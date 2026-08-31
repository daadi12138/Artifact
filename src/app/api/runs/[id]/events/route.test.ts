import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { importProject } from '../../../../../project'
import { saveExecutorConfigs } from '../../../../../executor-config'
import { configureRunManagerForTests, getRun, startRun } from '../../../../../run-manager'
import { GET } from './route'

const execFileAsync = promisify(execFile)

function parseSseChunk(raw: string): Array<{ event?: string; data?: string }> {
  return raw.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n')
    const event = lines.find(line => line.startsWith('event: '))?.slice(7)
    const data = lines.find(line => line.startsWith('data: '))?.slice(6)
    return { ...(event ? { event } : {}), ...(data ? { data } : {}) }
  })
}

test('run SSE stream sends initial state/trace and incremental updates until the run completes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-sse-route-'))
  const repository = join(root, 'fixture')
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = join(root, 'state')
  let releaseAgent: (() => void) | undefined
  const agentReleased = new Promise<void>(resolve => { releaseAgent = resolve })
  try {
    await mkdir(repository)
    await writeFile(join(repository, 'package.json'), JSON.stringify({ name: 'sse-fixture', version: '1.0.0' }, null, 2))
    await execFileAsync('git', ['init'], { cwd: repository })
    await execFileAsync('git', ['add', 'package.json'], { cwd: repository })
    await execFileAsync('git', ['-c', 'user.name=Artifact Test', '-c', 'user.email=artifact@example.test', 'commit', '-m', 'fixture'], { cwd: repository })
    await importProject(repository)
    await saveExecutorConfigs([{ id: 'codex', name: 'Codex', type: 'test', version: 'fixture', status: 'available', icon: 'C', tone: 'blue', path: 'codex', model: '', profile: 'coding-safe', capabilities: [], authentication: 'authenticated' }])
    let traceCount = 0
    configureRunManagerForTests({ codexRunner: async input => {
      await input.onPublicTrace?.({ kind: 'tool_started', toolName: 'shell', command: 'sleep 0' })
      await agentReleased
      traceCount += 1
      await input.onPublicTrace?.({ kind: 'agent_message', content: `Agent finished pass ${traceCount}.` })
      return 'done'
    } })

    const started = await startRun({ nodes: [{ id: 'agent', kind: 'Agent', executorId: 'codex', outputType: 'agent-report', prompt: 'Stream a fixture.' }] })
    // Wait until the attempt is actually running so the initial snapshot has trace data.
    for (let index = 0; index < 200; index += 1) {
      const run = await getRun(started.id)
      if (run?.nodes[0]?.attempts[0]?.trace?.length) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }

    const response = await GET(new Request(`http://localhost/api/runs/${started.id}/events`), { params: Promise.resolve({ id: started.id }) })
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream; charset=utf-8')
    assert.notEqual(response.body, null)

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let raw = ''
    const readUntil = async (predicate: (events: Array<{ event?: string; data?: string }>) => boolean) => {
      for (let index = 0; index < 400; index += 1) {
        const parsed = parseSseChunk(raw)
        if (predicate(parsed)) return parsed
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out reading SSE stream')), 500)),
        ]) as Awaited<ReturnType<typeof reader.read>>
        if (chunk.done) break
        raw += decoder.decode(chunk.value, { stream: true })
      }
      throw new Error(`SSE stream did not reach the expected state: ${raw.slice(-400)}`)
    }

    const initial = await readUntil(events => events.some(item => item.event === 'state'))
    assert.ok(initial.some(item => !item.event && !item.data), 'stream must start with a retry directive')
    const initialState = initial.find(item => item.event === 'state')
    assert.ok(initialState?.data)
    assert.equal((JSON.parse(initialState.data) as { status: string }).status, 'running')
    const initialTrace = initial.find(item => item.event === 'trace')
    assert.ok(initialTrace, 'initial sync must include a trace payload')
    assert.equal((JSON.parse(initialTrace.data!) as { full: boolean }).full, true)

    releaseAgent!()
    const completed = await readUntil(events => events.some(item => item.event === 'done'))
    const doneState = [...completed].reverse().find(item => item.event === 'state')
    assert.equal((JSON.parse(doneState!.data!) as { status: string }).status, 'succeeded')
    const finalTraces = completed.filter(item => item.event === 'trace').map(item => JSON.parse(item.data!) as { events: Array<{ kind: string; content?: string }> })
    assert.ok(finalTraces.some(payload => payload.events.some(event => event.kind === 'agent_message' && event.content === 'Agent finished pass 1.')), 'incremental trace must deliver the post-resume event')
    configureRunManagerForTests()
  } finally {
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
  }
})
