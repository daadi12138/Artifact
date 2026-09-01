import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { importProject, loadProject } from './project'
import { saveExecutorConfigs } from './executor-config'
import { approveRun, configureRunManagerForTests, getRun, pauseRun, requestDeliveryApproval, resumeInterruptedRuns, resumeRun, retryRun, startRun, steerRun, validateRunGraph } from './run-manager'

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

test('validation discovers commands created in the Worktree and keeps their approval run-scoped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-worktree-validation-'))
  const repository = join(root, 'fixture')
  const state = join(root, 'state')
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = state
  try {
    await createGitFixture(repository, 'worktree-validation')
    const imported = await importProject(repository)
    assert.equal(imported.environment.commands.test, undefined)
    assert.equal(imported.environment.commands.build, undefined)
    await saveExecutorConfigs([{ id: 'codex', name: 'Codex', type: 'test', version: 'fixture', status: 'available', icon: 'C', tone: 'blue', path: 'codex', model: '', profile: 'coding-safe', capabilities: [], authentication: 'authenticated' }])
    configureRunManagerForTests({ codexRunner: async input => {
      await writeFile(join(input.cwd, 'package.json'), JSON.stringify({ name: 'generated', scripts: { test: 'node -e "process.exit(0)"' } }))
      return 'Created a project with a test command.'
    } })

    const started = await startRun({
      nodes: [
        { id: 'implementation', kind: 'Agent', executorId: 'codex', outputType: 'code-change', prompt: 'Create the project.' },
        { id: 'validation', kind: '验证', outputType: 'test-report' },
      ],
      edges: [{ from: 'implementation', to: 'validation' }],
    })
    let run = await waitForRun(started.id, value => value.status === 'awaiting_approval')
    assert.equal(run.pendingCommandApproval?.command.command, 'npm install')
    await approveRun(run.id)
    run = await waitForRun(run.id, value => value.status === 'awaiting_approval' && value.pendingCommandApproval?.commandKey === 'test')
    await approveRun(run.id)
    run = await waitForRun(run.id, value => value.status === 'succeeded')
    assert.equal(run.nodes.find(node => node.id === 'validation')?.state, 'success')
    assert.equal((await loadProject())?.environment.commands.test, undefined)
  } finally {
    configureRunManagerForTests()
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
  }
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
    run = await requestDeliveryApproval(run.id) ?? run
    assert.ok(run.deliveryApproval?.changedFiles.includes('implemented.txt'))
    await approveRun(run.id)
    assert.equal(await readFile(join(repository, 'implemented.txt'), 'utf8'), 'written in worktree')

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

test('an Agent attempt freezes the rendered prompt before spawn and persists its final response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-agent-trace-success-'))
  const repository = join(root, 'fixture')
  const state = join(root, 'state')
  const fakeCodex = join(root, 'fake-codex.mjs')
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = state
  try {
    await createGitFixture(repository, 'agent-trace-success')
    await writeExecutable(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
let prompt = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) prompt += chunk
writeFileSync('received-prompt.txt', prompt)
writeFileSync('received-argv.json', JSON.stringify(process.argv.slice(2)))
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'Final public answer. auth_token=agent-output-secret' } }))
`)
    await saveExecutorConfigs([{ id: 'codex', name: 'Codex', type: 'test', version: 'fixture-stream', status: 'available', icon: 'C', tone: 'blue', path: fakeCodex, model: 'fixture-model', profile: 'coding-safe', capabilities: [], authentication: 'authenticated' }])
    configureRunManagerForTests()

    const started = await startRun({
      nodes: [
        { id: 'requirement', kind: '输入', outputType: 'requirement', prompt: 'Freeze the user request.' },
        { id: 'analysis', kind: 'Agent', executorId: 'codex', outputType: 'agent-report', prompt: 'Inspect the frozen requirement.' },
      ],
      edges: [{ from: 'requirement', to: 'analysis' }],
      input: { text: 'Trace this request with API_KEY=super-secret-value.', attachments: [] },
    })
    const run = await waitForRun(started.id, value => value.status === 'succeeded')
    const attempt = run.nodes.find(node => node.id === 'analysis')?.attempts[0]
    assert.ok(attempt?.promptSnapshot)
    assert.equal(attempt.promptSnapshot.nodeInstruction, 'Inspect the frozen requirement.')
    assert.match(attempt.promptSnapshot.runtimeInstruction, /Do not modify files/)
    assert.deepEqual(attempt.promptSnapshot.inputArtifactIds, attempt.inputArtifactIds)
    assert.equal(attempt.promptSnapshot.redacted, true)
    assert.doesNotMatch(attempt.promptSnapshot.renderedPrompt, /super-secret-value/)
    assert.match(attempt.promptSnapshot.renderedPrompt, /\[REDACTED\]/)
    const receivedPrompt = await readFile(join(run.worktreePath!, 'received-prompt.txt'), 'utf8')
    assert.match(receivedPrompt, /super-secret-value/)
    assert.equal(attempt.promptSnapshot.contentHash, createHash('sha256').update(receivedPrompt).digest('hex'))
    const argv = JSON.parse(await readFile(join(run.worktreePath!, 'received-argv.json'), 'utf8')) as string[]
    assert.equal(argv.includes(receivedPrompt), false)
    assert.equal(attempt.finalResponse, 'Final public answer. auth_token=[REDACTED]')
    assert.equal(attempt.finalResponseRedacted, true)
    assert.equal(attempt.trace?.some(event => event.kind === 'agent_message' && event.content === 'Final public answer. auth_token=[REDACTED]' && event.redacted), true)
    const trace = await readFile(join(state, 'runs', run.id, 'attempts', attempt.id, 'trace.jsonl'), 'utf8')
    assert.match(trace, /Final public answer/)
    assert.doesNotMatch(trace, /agent-output-secret/)
    const resultArtifact = run.artifacts.find(artifact => artifact.nodeId === 'analysis' && artifact.type === 'agent-report')
    assert.ok(resultArtifact)
    const resultPayload = await readFile(join(state, 'runs', run.id, resultArtifact.path), 'utf8')
    assert.match(resultPayload, /\[REDACTED\]/)
    assert.doesNotMatch(resultPayload, /agent-output-secret/)
  } finally {
    configureRunManagerForTests()
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
  }
})

test('Codex public trace streams during execution, survives failure, and excludes raw reasoning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-agent-trace-failure-'))
  const repository = join(root, 'fixture')
  const state = join(root, 'state')
  const fakeCodex = join(root, 'fake-codex.mjs')
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = state
  try {
    await createGitFixture(repository, 'agent-trace-failure')
    await writeExecutable(fakeCodex, `#!/usr/bin/env node
for await (const _chunk of process.stdin) { /* consume the prompt */ }
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'Public progress update. OPENAI_API_KEY=trace-secret' } }))
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'reasoning-raw', type: 'reasoning', text: 'PRIVATE RAW REASONING' } }))
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'reasoning-summary', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Public reasoning summary. password=summary-secret' }] } }))
console.log(JSON.stringify({ type: 'item.started', item: { id: 'command-1', type: 'command_execution', command: 'OPENAI_API_KEY=command-secret npm test' } }))
setTimeout(() => {
  console.log(JSON.stringify({ type: 'item.completed', item: { id: 'command-1', type: 'command_execution', command: 'OPENAI_API_KEY=command-secret npm test', exit_code: 3 } }))
  console.error('auth_token=stderr-secret fixture executor failure')
  process.exit(7)
}, 250)
`)
    await saveExecutorConfigs([{ id: 'codex', name: 'Codex', type: 'test', version: 'fixture-stream', status: 'available', icon: 'C', tone: 'blue', path: fakeCodex, model: '', profile: 'coding-safe', capabilities: [], authentication: 'authenticated' }])
    configureRunManagerForTests()

    const started = await startRun({ nodes: [{ id: 'analysis', kind: 'Agent', executorId: 'codex', outputType: 'agent-report', prompt: 'Emit a trace and fail.' }] })
    const duringRun = await waitForRun(started.id, value => value.status === 'running' && Boolean(value.nodes[0]?.attempts[0]?.trace?.some(event => event.kind === 'agent_message')))
    assert.equal(duringRun.nodes[0]?.attempts[0]?.trace?.some(event => event.content === 'Public progress update. OPENAI_API_KEY=[REDACTED]' && event.redacted), true)

    const failed = await waitForRun(started.id, value => value.status === 'failed')
    const attempt = failed.nodes[0]?.attempts[0]
    assert.ok(attempt)
    assert.equal(attempt.finalResponse, undefined)
    assert.equal(attempt.trace?.some(event => event.kind === 'reasoning_summary' && event.content === 'Public reasoning summary. password=[REDACTED]' && event.redacted), true)
    assert.equal(attempt.trace?.some(event => event.content?.includes('PRIVATE RAW REASONING')), false)
    assert.equal(attempt.trace?.some(event => event.kind === 'tool_started' && event.command === 'OPENAI_API_KEY=[REDACTED] npm test' && event.redacted), true)
    assert.equal(attempt.trace?.some(event => event.kind === 'tool_completed' && event.exitCode === 3), true)
    assert.equal(attempt.trace?.some(event => event.kind === 'error' && event.content?.includes('fixture executor failure')), true)
    assert.doesNotMatch(attempt.exitReason ?? '', /PRIVATE RAW REASONING/)
    assert.doesNotMatch(attempt.exitReason ?? '', /stderr-secret/)
    const trace = await readFile(join(state, 'runs', failed.id, 'attempts', attempt.id, 'trace.jsonl'), 'utf8')
    assert.match(trace, /Public progress update/)
    assert.match(trace, /Public reasoning summary/)
    assert.doesNotMatch(trace, /PRIVATE RAW REASONING/)
    assert.doesNotMatch(trace, /trace-secret|summary-secret|command-secret|stderr-secret/)
    const manifest = await readFile(join(state, 'runs', failed.id, 'manifest.json'), 'utf8')
    assert.doesNotMatch(manifest, /trace-secret|summary-secret|command-secret|stderr-secret|PRIVATE RAW REASONING/)
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

test('a Claude stream-json session streams thinking, tool calls, and results as public trace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-claude-stream-'))
  const repository = join(root, 'fixture')
  const fakeClaude = join(root, 'fake-claude.mjs')
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = join(root, 'state')
  try {
    await createGitFixture(repository, 'claude-stream-fixture')
    await writeExecutable(fakeClaude, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
let stdin = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) stdin += chunk
writeFileSync('received-argv.json', JSON.stringify(process.argv.slice(2)))
const lines = [
  { type: 'system', subtype: 'init', model: 'claude-fixture-model' },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'The user wants a fixture report.' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-1', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'all 3 tests passed' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Final Claude report.' }] } },
  { type: 'result', subtype: 'success', result: 'Final Claude report.' },
]
for (const line of lines) console.log(JSON.stringify(line))
`)
    await saveExecutorConfigs([{ id: 'claude', name: 'Claude Code', type: 'test', version: 'fixture', status: 'available', icon: 'C', tone: 'orange', path: fakeClaude, model: 'sonnet', profile: 'coding-safe', capabilities: [], authentication: 'authenticated' }])
    configureRunManagerForTests()

    const started = await startRun({ nodes: [{ id: 'claude-agent', kind: 'Agent', executorId: 'claude', outputType: 'agent-report', prompt: 'Inspect the fixture.' }] })
    const run = await waitForRun(started.id, value => value.status === 'succeeded')
    const attempt = run.nodes[0]?.attempts[0]
    const argv = JSON.parse(await readFile(join(run.worktreePath!, 'received-argv.json'), 'utf8')) as string[]
    assert.deepEqual(argv.slice(0, 4), ['--print', '--output-format', 'stream-json', '--verbose'])

    const trace = attempt?.trace ?? []
    const kindOrder = trace.map(event => event.kind)
    assert.ok(kindOrder.indexOf('status') < kindOrder.indexOf('reasoning_summary'), 'init status comes first')
    assert.equal(trace.some(event => event.kind === 'status' && event.content?.includes('claude-fixture-model')), true)
    const toolStart = trace.find(event => event.kind === 'tool_started')
    assert.equal(toolStart?.toolName, 'Bash')
    assert.equal(toolStart?.command, 'npm test')
    const toolDone = trace.find(event => event.kind === 'tool_completed')
    assert.equal(toolDone?.toolName, 'Bash')
    assert.equal(toolDone?.status, 'success')
    assert.equal(typeof toolDone?.durationMs, 'number')
    assert.equal(toolDone?.content, 'all 3 tests passed')
    assert.equal(trace.some(event => event.kind === 'agent_message' && event.content === 'Final Claude report.'), true)
    assert.equal(attempt?.finalResponse, 'Final Claude report.')
  } finally {
    configureRunManagerForTests()
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
  }
})

test('a Claude error result surfaces a public trace error event and fails the attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-claude-error-'))
  const repository = join(root, 'fixture')
  const fakeClaude = join(root, 'fake-claude.mjs')
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = join(root, 'state')
  try {
    await createGitFixture(repository, 'claude-error-fixture')
    await writeExecutable(fakeClaude, `#!/usr/bin/env node
let stdin = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) stdin += chunk
console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fixture-model' }))
console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Model capacity reached.' }))
process.exit(1)
`)
    await saveExecutorConfigs([{ id: 'claude', name: 'Claude Code', type: 'test', version: 'fixture', status: 'available', icon: 'C', tone: 'orange', path: fakeClaude, model: 'sonnet', profile: 'coding-safe', capabilities: [], authentication: 'authenticated' }])
    configureRunManagerForTests()

    const started = await startRun({ nodes: [{ id: 'claude-agent', kind: 'Agent', executorId: 'claude', outputType: 'agent-report', prompt: 'Inspect the fixture.' }] })
    const run = await waitForRun(started.id, value => value.status === 'failed')
    const attempt = run.nodes[0]?.attempts[0]
    assert.equal(attempt?.status, 'failed')
    assert.equal((attempt?.trace ?? []).some(event => event.kind === 'error' && event.content?.includes('Model capacity reached.')), true)
  } finally {
    configureRunManagerForTests()
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
  }
})

test('codex file_change events carry the changed file paths into public trace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-codex-file-change-'))
  const repository = join(root, 'fixture')
  const fakeCodex = join(root, 'fake-codex.mjs')
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = join(root, 'state')
  try {
    await createGitFixture(repository, 'codex-file-change-fixture')
    await writeExecutable(fakeCodex, `#!/usr/bin/env node
let stdin = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) stdin += chunk
console.log(JSON.stringify({ type: 'item.started', item: { id: 'fc-1', type: 'file_change', status: 'in_progress' } }))
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'fc-1', type: 'file_change', status: 'completed', changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }] } }))
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: 'Edited two files.' } }))
`)
    await saveExecutorConfigs([{ id: 'codex', name: 'Codex', type: 'test', version: 'fixture', status: 'available', icon: 'C', tone: 'blue', path: fakeCodex, model: '', profile: 'coding-safe', capabilities: [], authentication: 'authenticated' }])
    configureRunManagerForTests()

    const started = await startRun({ nodes: [{ id: 'agent', kind: 'Agent', executorId: 'codex', outputType: 'agent-report', prompt: 'Edit fixture files.' }] })
    const run = await waitForRun(started.id, value => value.status === 'succeeded')
    const trace = run.nodes[0]?.attempts[0]?.trace ?? []
    const completed = trace.find(event => event.kind === 'tool_completed' && event.toolName === 'file_change')
    assert.ok(completed)
    assert.match(completed.content ?? '', /src\/a\.ts/)
    assert.match(completed.content ?? '', /src\/b\.ts/)
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

async function createGitFixture(repository: string, name: string): Promise<void> {
  await mkdir(repository)
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name, version: '1.0.0' }, null, 2))
  await execFileAsync('git', ['init'], { cwd: repository })
  await execFileAsync('git', ['add', 'package.json'], { cwd: repository })
  await execFileAsync('git', ['-c', 'user.name=Artifact Test', '-c', 'user.email=artifact@example.test', 'commit', '-m', 'fixture'], { cwd: repository })
  await importProject(repository)
}

async function writeExecutable(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8')
  await chmod(path, 0o755)
}
