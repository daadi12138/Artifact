import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { importProject, loadProject } from './project'
import { saveExecutorConfigs } from './executor-config'
import { approveRun, configureRunManagerForTests, getRun, pauseRun, resumeInterruptedRuns, resumeRun, retryRun, startRun, steerRun, validateRunGraph } from './run-manager'

const execFileAsync = promisify(execFile)

test('run graph accepts a directed acyclic workflow', () => {
  assert.doesNotThrow(() => validateRunGraph(
    [{ id: 'input', kind: '输入' }, { id: 'agent', kind: 'Agent' }, { id: 'review', kind: '审批' }],
    [{ from: 'input', to: 'agent' }, { from: 'agent', to: 'review' }],
  ))
})

test('run graph rejects invalid dependencies before execution', () => {
  assert.throws(() => validateRunGraph([{ id: 'input', kind: '输入' }, { id: 'input', kind: '验证' }]), /Duplicate node id/)
  assert.throws(() => validateRunGraph([{ id: 'input', kind: '输入' }], [{ from: 'input', to: 'missing' }]), /Unknown edge/)
  assert.throws(() => validateRunGraph([{ id: 'a', kind: '输入' }, { id: 'b', kind: '验证' }], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]), /contains a cycle/)
})

test('run creates an isolated worktree, validates artifacts, retries a failed command, and recovers a lost attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-run-'))
  const repository = join(root, 'fixture')
  const state = join(root, 'state')
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = state
  try {
    await mkdir(repository)
    await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node -e "require(\'node:fs\').accessSync(\'pass.flag\')"' } }, null, 2))
    await writeFile(join(repository, 'package-lock.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture', version: '1.0.0' } } }, null, 2))
    await execFileAsync('git', ['init'], { cwd: repository })
    await execFileAsync('git', ['add', 'package.json', 'package-lock.json'], { cwd: repository })
    await execFileAsync('git', ['-c', 'user.name=Artifact Test', '-c', 'user.email=artifact@example.test', 'commit', '-m', 'fixture'], { cwd: repository })
    const detected = await importProject(repository)
    assert.equal(detected.status, 'ready')
    assert.equal(detected.environment.commandAllowlist.test, undefined)
    await saveExecutorConfigs([{ id: 'codex', name: 'Codex', type: 'test', version: 'fixture', status: 'available', icon: 'C', tone: 'blue', path: 'codex', model: '', profile: 'coding-safe', capabilities: [], authentication: 'authenticated' }])
    configureRunManagerForTests({ codexRunner: async input => { await writeFile(join(input.cwd, 'implemented.txt'), 'written in worktree'); return 'Implemented the requested fixture change.' } })

    const started = await startRun({
      nodes: [
        { id: 'requirement', kind: '输入', outputType: 'requirement', prompt: 'The fixture must pass its confirmed test.' },
        { id: 'implementation', kind: 'Agent', executorId: 'codex', outputType: 'code-change', prompt: 'Create the fixture implementation.' },
        { id: 'validation', kind: '验证', outputType: 'test-report' },
        { id: 'delivery', kind: '交付', outputType: 'git-diff' },
      ],
      edges: [{ from: 'requirement', to: 'implementation' }, { from: 'implementation', to: 'validation' }, { from: 'validation', to: 'delivery' }],
    })
    let run = await waitForRun(started.id, value => value.status === 'awaiting_approval')
    assert.equal(run.pendingCommandApproval?.nodeId, 'validation')
    assert.equal(run.pendingCommandApproval?.commandKey, 'install')
    await approveRun(run.id)
    run = await waitForRun(run.id, value => value.status === 'awaiting_approval' && value.pendingCommandApproval?.commandKey === 'test')
    await approveRun(run.id)
    run = await waitForRun(run.id, value => value.status === 'failed')
    const project = await loadProject()
    assert.equal(project?.environment.commandAllowlist.install?.command, detected.environment.commands.install?.command)
    assert.equal(project?.environment.commandAllowlist.test?.command, detected.environment.commands.test?.command)
    assert.ok(run.worktreePath)
    assert.notEqual(run.worktreePath, repository)
    assert.equal(await readFile(join(run.worktreePath!, 'implemented.txt'), 'utf8'), 'written in worktree')
    assert.equal(run.nodes.find(node => node.id === 'implementation')?.attempts[0].executorSnapshot?.version, 'fixture')
    assert.equal(run.nodes.find(node => node.id === 'validation')?.attempts.length, 1)

    await writeFile(join(run.worktreePath!, 'pass.flag'), 'ready')
    await retryRun(run.id, 'validation')
    run = await waitForRun(run.id, value => value.status === 'succeeded')
    assert.equal(run.nodes.find(node => node.id === 'validation')?.attempts.length, 2)
    assert.ok(run.artifacts.every(artifact => artifact.schemaId && artifact.schemaVersion === 1 && artifact.validationErrors.length === 0))
    assert.ok(run.artifacts.some(artifact => artifact.type === 'git-diff'))

    const manifestPath = join(state, 'runs', run.id, 'manifest.json')
    const interrupted = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof run
    interrupted.status = 'running'
    delete interrupted.endedAt
    const delivery = interrupted.nodes.find(node => node.id === 'delivery')!
    delivery.state = 'running'
    delivery.attempts.push({ id: 'attempt-interrupted', attempt: delivery.attempts.length + 1, executorId: 'local', status: 'running', startedAt: new Date().toISOString() })
    await writeFile(manifestPath, JSON.stringify(interrupted, null, 2))
    await resumeInterruptedRuns()
    run = await waitForRun(run.id, value => value.status === 'succeeded' && value.nodes.find(node => node.id === 'delivery')!.attempts.length >= 3)
    assert.equal(run.nodes.find(node => node.id === 'delivery')?.attempts.find(attempt => attempt.id === 'attempt-interrupted')?.exitReason, 'process_lost')
  } finally {
    configureRunManagerForTests()
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
  }
})

test('a Claude Code Agent node is dispatched through the Claude adapter and requires authenticated configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-claude-run-'))
  const repository = join(root, 'fixture')
  const state = join(root, 'state')
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = state
  try {
    await mkdir(repository)
    await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'claude-fixture', version: '1.0.0' }, null, 2))
    await execFileAsync('git', ['init'], { cwd: repository })
    await execFileAsync('git', ['add', 'package.json'], { cwd: repository })
    await execFileAsync('git', ['-c', 'user.name=Artifact Test', '-c', 'user.email=artifact@example.test', 'commit', '-m', 'fixture'], { cwd: repository })
    await importProject(repository)

    await saveExecutorConfigs([{ id: 'claude', name: 'Claude Code', type: 'test', version: 'fixture', status: 'available', icon: 'C', tone: 'orange', path: 'claude', model: 'sonnet', profile: 'coding-safe', capabilities: [], authentication: 'needs_login' }])
    await assert.rejects(() => startRun({ nodes: [{ id: 'claude-agent', kind: 'Agent', executorId: 'claude', outputType: 'agent-report', prompt: 'Inspect the fixture.' }] }), /requires login before starting a run: Claude Code/)

    await saveExecutorConfigs([{ id: 'claude', name: 'Claude Code', type: 'test', version: 'fixture', status: 'available', icon: 'C', tone: 'orange', path: 'claude', model: 'sonnet', profile: 'coding-safe', capabilities: [], authentication: 'authenticated' }])
    let receivedExecutorId = ''
    configureRunManagerForTests({ claudeRunner: async input => { receivedExecutorId = input.executor.id; return 'Claude inspected the fixture.' } })
    const started = await startRun({ nodes: [{ id: 'claude-agent', kind: 'Agent', executorId: 'claude', outputType: 'agent-report', prompt: 'Inspect the fixture.' }] })
    const run = await waitForRun(started.id, value => value.status === 'succeeded')
    assert.equal(receivedExecutorId, 'claude')
    assert.equal(run.nodes[0]?.attempts[0]?.executorSnapshot?.id, 'claude')
    assert.equal(run.nodes[0]?.attempts[0]?.executorSnapshot?.model, 'sonnet')
  } finally {
    configureRunManagerForTests()
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
  }
})

test('a paused agent run freezes an operator note and resumes in a new attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-run-pause-'))
  const repository = join(root, 'fixture')
  const state = join(root, 'state')
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = state
  try {
    await mkdir(repository)
    await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'pause-fixture', version: '1.0.0' }, null, 2))
    await execFileAsync('git', ['init'], { cwd: repository })
    await execFileAsync('git', ['add', 'package.json'], { cwd: repository })
    await execFileAsync('git', ['-c', 'user.name=Artifact Test', '-c', 'user.email=artifact@example.test', 'commit', '-m', 'fixture'], { cwd: repository })
    await importProject(repository)
    await saveExecutorConfigs([{ id: 'codex', name: 'Codex', type: 'test', version: 'fixture', status: 'available', icon: 'C', tone: 'blue', path: 'codex', model: '', profile: 'coding-safe', capabilities: [], authentication: 'authenticated' }])

    let resolveFirst: (() => void) | undefined
    const firstStarted = new Promise<void>(resolve => { resolveFirst = resolve })
    configureRunManagerForTests({ codexRunner: async () => { await firstStarted; return 'First attempt released.' } })
    const started = await startRun({ nodes: [{ id: 'agent', kind: 'Agent', executorId: 'codex', outputType: 'agent-report', prompt: 'Wait for a direction.' }], input: { text: 'Implement the requested change.', attachments: [] } })
    let run = await waitForRun(started.id, value => value.nodes[0]?.state === 'running')
    run = await pauseRun(run.id, 'agent') ?? run
    assert.equal(run.status, 'paused')
    run = await steerRun(run.id, 'agent', 'Prioritize the smallest compatible change.') ?? run
    assert.equal(run.artifacts.some(artifact => artifact.type === 'operator-note'), true)
    resolveFirst?.()
    await waitForRun(run.id, value => value.status === 'paused')

    configureRunManagerForTests({ codexRunner: async () => 'Second attempt completed.' })
    await resumeRun(run.id)
    run = await waitForRun(run.id, value => value.status === 'succeeded')
    const attempt = run.nodes[0]?.attempts.at(-1)
    assert.equal(run.nodes[0]?.attempts.length, 2)
    assert.equal(attempt?.inputArtifactIds?.length, 1)
    assert.equal(run.events.some(event => event.type === 'operator' && event.message.includes('补充说明')), true)
  } finally {
    configureRunManagerForTests()
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
  }
})

async function waitForRun(id: string, predicate: (run: NonNullable<Awaited<ReturnType<typeof getRun>>>) => boolean) {
  for (let index = 0; index < 200; index += 1) {
    const run = await getRun(id)
    if (run && predicate(run)) return run
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for run ${id}`)
}
