import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { schemaFor, validatePayload } from './artifact-schema'
import { loadExecutorConfigs, refreshExecutorAuthentication, type ExecutorConfig } from './executor-config'
import { approveProjectCommand, isProjectCommandApproved, loadProject, type CommandSpec, type ProjectCommandKey, type ProjectConfig } from './project'

export type RunNodeState = 'idle' | 'running' | 'paused' | 'success' | 'waiting' | 'failed' | 'cancelled' | 'skipped'
export type RunStatus = 'preparing' | 'running' | 'paused' | 'awaiting_approval' | 'succeeded' | 'failed' | 'cancelled'
export type RunInputAttachment = { id: string; name: string; mediaType: string; byteLength: number; dataUrl?: string; sourceUrl?: string }
export type RunInput = { text: string; attachments: RunInputAttachment[]; submittedAt?: string }
export type WorkflowRunReference = { workflowId: string; workflowName: string; revision: number; publishedAt: string }
export type RunEvent = { id: string; occurredAt: string; type: 'run-created' | 'run-state' | 'node-state' | 'command' | 'executor' | 'artifact' | 'operator' | 'activity' | 'error'; message: string; nodeId?: string; attemptId?: string; details?: Record<string, string | number | boolean | null> }
export type StepAttempt = { id: string; attempt: number; executorId: string; executorSnapshot?: Pick<ExecutorConfig, 'id' | 'path' | 'model' | 'profile' | 'version'>; status: 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'; startedAt: string; endedAt?: string; exitReason?: string; output?: string; inputArtifactIds?: string[] }
export type RunNode = { id: string; kind: string; executorId?: string; prompt?: string; outputType?: string; state: RunNodeState; attempts: StepAttempt[]; steeringArtifactIds?: string[] }
export type RunEdge = { from: string; to: string }
export type RunArtifact = { id: string; nodeId: string; type: string; version: number; schemaId: string; schemaVersion: number; status: 'valid' | 'awaiting_approval' | 'rejected' | 'invalid'; path: string; contentHash: string; inputArtifactIds: string[]; validationErrors: string[]; createdAt: string }
export type PendingCommandApproval = { nodeId: string; commandKey: ProjectCommandKey; command: CommandSpec; requestedAt: string }
export type RunSnapshot = { id: string; status: RunStatus; startedAt: string; endedAt?: string; project: ProjectConfig; workflow?: WorkflowRunReference; input: RunInput; baseGitRef?: string; branchName?: string; worktreePath?: string; pendingCommandApproval?: PendingCommandApproval; nodes: RunNode[]; edges: RunEdge[]; logs: string[]; events: RunEvent[]; artifacts: RunArtifact[] }
export type StartRunInput = { nodes: Array<Omit<RunNode, 'state' | 'attempts' | 'steeringArtifactIds'>>; edges?: RunEdge[]; input?: RunInput; workflow?: WorkflowRunReference }
type AgentActivity = { type: 'executor' | 'command' | 'activity'; message: string; details?: Record<string, string | number | boolean | null> }
type AgentRunnerResult = { output: string; activities?: AgentActivity[] }
type AgentRunner = (input: { prompt: string; cwd: string; writable: boolean; executor: ExecutorConfig; attemptId: string }) => Promise<string | AgentRunnerResult>

const stateRoot = () => process.env.ARTIFACT_STATE_DIR || join(process.cwd(), '.artifact')
const artifactRoot = () => join(stateRoot(), 'runs')
const worktreeRoot = () => join(stateRoot(), 'worktrees')
const runDirectory = (id: string) => join(artifactRoot(), id)
const manifestPath = (id: string) => join(runDirectory(id), 'manifest.json')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const activeRuns = new Set<string>()
const activeProcesses = new Map<string, ChildProcess>()
let recoveryStarted = false
let codexRunner: AgentRunner = runCodex
let claudeRunner: AgentRunner = runClaude

export function configureRunManagerForTests(dependencies: { codexRunner?: AgentRunner; claudeRunner?: AgentRunner } = {}): void {
  codexRunner = dependencies.codexRunner ?? runCodex
  claudeRunner = dependencies.claudeRunner ?? runClaude
}

export function validateRunGraph(nodes: Array<Pick<RunNode, 'id' | 'kind'>>, edges: RunEdge[] = []): void {
  const ids = new Set<string>()
  for (const node of nodes) { if (!node.id.trim()) throw new Error('Node id is required'); if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`); ids.add(node.id) }
  for (const edge of edges) { if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error(`Unknown edge: ${edge.from} -> ${edge.to}`); if (edge.from === edge.to) throw new Error(`Self-cycle: ${edge.from}`) }
  const incoming = new Map<string, number>(nodes.map(node => [node.id, 0]))
  const next = new Map<string, string[]>(nodes.map(node => [node.id, []]))
  for (const edge of edges) { incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1); next.get(edge.from)?.push(edge.to) }
  const ready = nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id)
  let visited = 0
  while (ready.length) { const id = ready.shift()!; visited += 1; for (const target of next.get(id) ?? []) { const count = (incoming.get(target) ?? 1) - 1; incoming.set(target, count); if (count === 0) ready.push(target) } }
  if (visited !== nodes.length) throw new Error('Workflow contains a cycle')
}

export async function startRun(input: StartRunInput): Promise<RunSnapshot> {
  const project = await loadProject()
  if (!project) throw new Error('Import a Git project before starting a run')
  const edges = input.edges ?? []
  validateRunGraph(input.nodes, edges)
  await validateAgentExecutors(input.nodes)
  const runInput = normalizeRunInput(input.input)
  const snapshot: RunSnapshot = { id: `run-${randomUUID()}`, status: 'preparing', startedAt: new Date().toISOString(), project: structuredClone(project), workflow: input.workflow ? structuredClone(input.workflow) : undefined, input: runInput, nodes: input.nodes.map(node => ({ ...node, state: 'idle', attempts: [] })), edges, logs: [], events: [], artifacts: [] }
  appendEvent(snapshot, 'run-created', `运行已创建 · ${input.nodes.length} 个节点 · 环境 v${project.environment.version}`, undefined, undefined, { workflow: input.workflow?.workflowName ?? 'legacy' })
  await writeArtifact(snapshot, { id: 'run-input', kind: '输入', outputType: 'run-input', state: 'success', attempts: [] }, reportPayload('运行需求已冻结', runInputContent(runInput)))
  await saveRun(snapshot)
  void processRun(snapshot.id)
  return snapshot
}

export async function getRun(id: string): Promise<RunSnapshot | null> {
  if (!/^run-[a-zA-Z0-9-]+$/.test(id)) return null
  try { return normalizeRun(JSON.parse(await readFile(manifestPath(id), 'utf8')) as RunSnapshot) } catch { return null }
}

export async function listRuns(): Promise<RunSnapshot[]> {
  await ensureRecovery()
  try { const entries = await readdir(artifactRoot(), { withFileTypes: true }); const runs = await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry => getRun(entry.name))); return runs.filter((run): run is RunSnapshot => run !== null).sort((a, b) => b.startedAt.localeCompare(a.startedAt)) } catch { return [] }
}

export async function approveRun(id: string): Promise<RunSnapshot | null> {
  const run = await getRun(id); if (!run) return null
  const approval = run.nodes.find(node => node.state === 'waiting'); if (!approval || run.status !== 'awaiting_approval') return run
  if (run.pendingCommandApproval) {
    const pending = run.pendingCommandApproval
    if (approval.id !== pending.nodeId) throw new Error('The waiting node does not match the requested command approval')
    const project = await approveProjectCommand(pending.commandKey, pending.command)
    run.project = structuredClone(project)
    approval.state = 'idle'
    delete run.pendingCommandApproval
    run.status = 'running'
    appendLog(run, `${approval.id} · 已允许 ${pending.commandKey}：${pending.command.command}`)
    await saveRun(run); void processRun(id); return run
  }
  approval.state = 'success'; const attempt = approval.attempts.at(-1); if (attempt) { attempt.status = 'succeeded'; attempt.endedAt = new Date().toISOString() }
  run.status = 'running'; appendLog(run, `${approval.id} · 人工审批已通过`)
  const pending = [...run.artifacts].reverse().find(item => item.nodeId === approval.id && item.status === 'awaiting_approval'); if (pending) { pending.status = 'valid'; await saveArtifactManifest(run, pending) }
  await saveRun(run); void processRun(id); return run
}

export async function rejectRun(id: string): Promise<RunSnapshot | null> {
  const run = await getRun(id); if (!run) return null
  const approval = run.nodes.find(node => node.state === 'waiting'); if (!approval || run.status !== 'awaiting_approval') return run
  if (run.pendingCommandApproval) {
    const pending = run.pendingCommandApproval
    if (approval.id !== pending.nodeId) throw new Error('The waiting node does not match the requested command approval')
    approval.state = 'failed'
    markDownstream(run, approval.id, 'cancelled')
    delete run.pendingCommandApproval
    run.status = 'failed'; run.endedAt = new Date().toISOString()
    appendLog(run, `${approval.id} · 已拒绝 ${pending.commandKey}，后续节点已取消`)
    await saveRun(run); return run
  }
  approval.state = 'failed'; const attempt = approval.attempts.at(-1); if (attempt) { attempt.status = 'failed'; attempt.endedAt = new Date().toISOString(); attempt.exitReason = 'rejected' }
  const pending = [...run.artifacts].reverse().find(item => item.nodeId === approval.id && item.status === 'awaiting_approval'); if (pending) { pending.status = 'rejected'; await saveArtifactManifest(run, pending) }
  markDownstream(run, approval.id, 'cancelled'); run.status = 'failed'; run.endedAt = new Date().toISOString(); appendLog(run, `${approval.id} · 人工审批已拒绝，后续节点已取消`); await saveRun(run); return run
}

export async function cancelRun(id: string): Promise<RunSnapshot | null> {
  const run = await getRun(id); if (!run) return null; if (isTerminal(run.status)) return run
  for (const node of run.nodes) {
    if (node.state === 'idle' || node.state === 'waiting') node.state = 'cancelled'
    if (node.state === 'running') { node.state = 'cancelled'; const attempt = node.attempts.at(-1); if (attempt) { activeProcesses.get(attempt.id)?.kill('SIGTERM'); attempt.status = 'cancelled'; attempt.endedAt = new Date().toISOString(); attempt.exitReason = 'cancelled_by_user' } }
  }
  delete run.pendingCommandApproval
  run.status = 'cancelled'; run.endedAt = new Date().toISOString(); appendLog(run, '运行已取消'); await saveRun(run); return run
}

export async function retryRun(id: string, nodeId: string): Promise<RunSnapshot | null> {
  const run = await getRun(id); if (!run) return null; if (!run.nodes.some(node => node.id === nodeId)) throw new Error('Node not found')
  const affected = collectDownstream(run, nodeId); affected.add(nodeId); for (const node of run.nodes) if (affected.has(node.id)) node.state = 'idle'
  if (run.pendingCommandApproval && affected.has(run.pendingCommandApproval.nodeId)) delete run.pendingCommandApproval
  run.status = 'running'; delete run.endedAt; appendEvent(run, 'operator', `${nodeId} · 已请求重试`, nodeId); await saveRun(run); void processRun(id); return run
}

export async function pauseRun(id: string, requestedNodeId?: string): Promise<RunSnapshot | null> {
  const run = await getRun(id)
  if (!run) return null
  if (isTerminal(run.status) || run.status === 'paused') return run
  const node = requestedNodeId ? run.nodes.find(item => item.id === requestedNodeId) : run.nodes.find(item => item.state === 'running' || item.state === 'waiting')
  if (!node) throw new Error('No active node is available to pause')
  if (node.state !== 'running' && node.state !== 'waiting') throw new Error('Only an active or waiting node can be paused')
  const attempt = node.attempts.at(-1)
  if (node.state === 'running' && attempt) {
    activeProcesses.get(attempt.id)?.kill('SIGTERM')
    attempt.status = 'paused'
    attempt.endedAt = new Date().toISOString()
    attempt.exitReason = 'paused_by_operator'
  }
  node.state = 'paused'
  delete run.pendingCommandApproval
  run.status = 'paused'
  appendEvent(run, 'operator', `${node.id} · 已暂停，保留 Worktree 和已生成产物`, node.id, attempt?.id)
  await saveRun(run)
  return run
}

export async function steerRun(id: string, nodeId: string, note: string): Promise<RunSnapshot | null> {
  const trimmed = note.trim()
  if (!trimmed) throw new Error('A steering note is required')
  if (trimmed.length > 16_000) throw new Error('Steering note is too long')
  let run = await getRun(id)
  if (!run) return null
  const node = run.nodes.find(item => item.id === nodeId)
  if (!node) throw new Error('Node not found')
  if (run.status !== 'paused' || node.state !== 'paused') {
    const paused = await pauseRun(id, nodeId)
    if (!paused) return null
    run = paused
  }
  const current = run.nodes.find(item => item.id === nodeId)
  if (!current) return null
  const artifact = await writeArtifact(run, { id: `operator-${nodeId}`, kind: '操作说明', outputType: 'operator-note', state: 'success', attempts: [] }, reportPayload('操作员补充说明', trimmed))
  current.steeringArtifactIds = [...(current.steeringArtifactIds ?? []), artifact.id]
  appendEvent(run, 'operator', `${nodeId} · 已添加补充说明，继续时会作为冻结输入`, nodeId, undefined, { artifactId: artifact.id })
  await saveRun(run)
  return run
}

export async function resumeRun(id: string): Promise<RunSnapshot | null> {
  const run = await getRun(id)
  if (!run) return null
  if (run.status !== 'paused') return run
  const paused = run.nodes.filter(node => node.state === 'paused')
  if (!paused.length) throw new Error('No paused node is available to resume')
  for (const node of paused) node.state = 'idle'
  run.status = 'running'
  delete run.endedAt
  appendEvent(run, 'operator', `${paused.map(node => node.id).join(', ')} · 已继续执行，将创建新的 Attempt`)
  await saveRun(run)
  void processRun(id)
  return run
}

export async function readArtifactPayload(runId: string, artifactId: string): Promise<unknown | null> {
  const run = await getRun(runId); const artifact = run?.artifacts.find(item => item.id === artifactId); if (!run || !artifact) return null
  try { return JSON.parse(await readFile(join(runDirectory(run.id), artifact.path), 'utf8')) as unknown } catch { return null }
}

async function ensureRecovery(): Promise<void> {
  if (recoveryStarted) return; recoveryStarted = true
  await resumeInterruptedRuns()
}

export async function resumeInterruptedRuns(): Promise<void> {
  let entries; try { entries = await readdir(artifactRoot(), { withFileTypes: true }) } catch { return }
  for (const entry of entries.filter(item => item.isDirectory())) {
    const run = await getRun(entry.name); if (!run || activeRuns.has(run.id) || (run.status !== 'running' && run.status !== 'preparing')) continue
    for (const node of run.nodes.filter(item => item.state === 'running')) { node.state = 'idle'; const attempt = node.attempts.at(-1); if (attempt?.status === 'running') { attempt.status = 'failed'; attempt.endedAt = new Date().toISOString(); attempt.exitReason = 'process_lost' }; appendLog(run, `${node.id} · 服务重启，上一 Attempt 标记为 process_lost`) }
    run.status = 'running'; await saveRun(run); void processRun(run.id)
  }
}

async function processRun(id: string): Promise<void> {
  if (activeRuns.has(id)) return; activeRuns.add(id)
  try {
    let run = await getRun(id); if (!run || isTerminal(run.status) || run.status === 'awaiting_approval') return
    if (!run.worktreePath) {
      try { await prepareWorktree(run); run.status = 'running'; appendLog(run, `Worktree 已创建 · ${run.worktreePath}`); await saveRun(run) }
      catch (error) { run.status = 'failed'; run.endedAt = new Date().toISOString(); appendLog(run, `Worktree 创建失败 · ${errorMessage(error)}`); await saveRun(run); return }
    }
    while (true) {
      run = await getRun(id); if (!run || run.status !== 'running') return
      const ready = run.nodes.find(node => node.state === 'idle' && parentsSucceeded(run!, node.id))
      if (!ready) {
        if (run.nodes.every(node => node.state === 'success' || node.state === 'skipped')) { run.status = 'succeeded'; run.endedAt = new Date().toISOString(); appendLog(run, '工作流已成功完成'); await saveRun(run) }
        else if (!run.nodes.some(node => node.state === 'waiting' || node.state === 'running')) { run.status = 'failed'; run.endedAt = new Date().toISOString(); appendLog(run, '工作流无法继续：前置节点未成功'); await saveRun(run) }
        return
      }
      if (ready.kind === '验证') {
        const pendingCommand = firstUnapprovedValidationCommand(run)
        if (pendingCommand) {
          ready.state = 'waiting'
          run.status = 'awaiting_approval'
          run.pendingCommandApproval = { nodeId: ready.id, commandKey: pendingCommand.key, command: structuredClone(pendingCommand.command), requestedAt: new Date().toISOString() }
          appendLog(run, `${ready.id} · 等待允许 ${pendingCommand.key}：${pendingCommand.command.command}`)
          await saveRun(run)
          return
        }
      }
      const attempt: StepAttempt = { id: `attempt-${randomUUID()}`, attempt: ready.attempts.length + 1, executorId: ready.executorId ?? (ready.kind === 'Agent' ? 'codex' : 'local'), status: 'running', startedAt: new Date().toISOString() }
      ready.attempts.push(attempt); ready.state = 'running'; appendLog(run, `${ready.id} · Attempt ${attempt.attempt} 开始执行`); await saveRun(run)
      try {
        if (ready.kind === '审批') { ready.state = 'waiting'; run.status = 'awaiting_approval'; appendLog(run, `${ready.id} · 等待人工审批`); await writeArtifact(run, ready, reportPayload('等待人工审批', '该节点已暂停，等待人工审批。'), 'awaiting_approval'); await saveRun(run); return }
        const payload = await executeNode(run, ready, attempt)
        const latest = await getRun(id); if (!latest || latest.status !== 'running') return
        const node = latest.nodes.find(item => item.id === ready.id); const latestAttempt = node?.attempts.find(item => item.id === attempt.id); if (!node || !latestAttempt) return
        const artifact = await writeArtifact(latest, node, payload)

        if (typeof payload.codeDiff === 'string') {
          await writeArtifact(latest, { ...node, outputType: 'code-diff' }, reportPayload(payload.codeDiff ? '代码 Diff 已生成' : '没有检测到代码 Diff', payload.codeDiff || '当前节点没有产生受 Git 跟踪的代码变更。'))
        }
        if (artifact.status === 'invalid') { await saveRun(latest); throw new Error(`Artifact schema validation failed: ${artifact.validationErrors.join(', ')}`) }
        node.state = 'success'; latestAttempt.status = 'succeeded'; latestAttempt.endedAt = new Date().toISOString(); latestAttempt.output = payload.summary; appendLog(latest, `${node.id} · 执行完成，Artifact v${artifact.version} 已通过 Schema 校验`); await saveRun(latest)
      } catch (error) {
        const latest = await getRun(id); if (!latest || latest.status !== 'running') return
        const node = latest.nodes.find(item => item.id === ready.id); const latestAttempt = node?.attempts.find(item => item.id === attempt.id); if (!node || !latestAttempt) return
        node.state = 'failed'; latestAttempt.status = 'failed'; latestAttempt.endedAt = new Date().toISOString(); latestAttempt.exitReason = errorMessage(error); markDownstream(latest, node.id, 'skipped'); latest.status = 'failed'; latest.endedAt = new Date().toISOString(); appendLog(latest, `${node.id} · Attempt ${latestAttempt.attempt} 失败：${errorMessage(error)}`); await saveRun(latest); return
      }
    }
  } finally { activeRuns.delete(id) }
}

async function prepareWorktree(run: RunSnapshot): Promise<void> {
  const branchName = `artifact/${run.id.slice(4, 16)}`; const worktreePath = join(worktreeRoot(), run.id); await mkdir(worktreeRoot(), { recursive: true })
  try {
    const baseGitRef = (await runProcess('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], worktreePath, 15_000)).trim()
    run.baseGitRef = baseGitRef; run.branchName = branchName; run.worktreePath = worktreePath; return
  } catch { /* create the missing worktree below */ }
  const baseGitRef = (await runProcess('git', ['-C', run.project.gitRoot, 'rev-parse', 'HEAD'], run.project.gitRoot, 15_000)).trim()
  let branchExists = false
  try { await runProcess('git', ['-C', run.project.gitRoot, 'rev-parse', '--verify', `refs/heads/${branchName}`], run.project.gitRoot, 15_000); branchExists = true } catch { /* create it below */ }
  await runProcess('git', branchExists ? ['-C', run.project.gitRoot, 'worktree', 'add', worktreePath, branchName] : ['-C', run.project.gitRoot, 'worktree', 'add', '-b', branchName, worktreePath, baseGitRef], run.project.gitRoot, 60_000)
  run.baseGitRef = baseGitRef; run.branchName = branchName; run.worktreePath = worktreePath
}

async function executeNode(run: RunSnapshot, node: RunNode, attempt: StepAttempt): Promise<Record<string, unknown> & { summary: string; content: string }> {
  if (!run.worktreePath) throw new Error('Worktree is not prepared')
  if (node.kind === '输入') return reportPayload('需求已冻结', runInputContent(run.input, node.prompt))
  if (node.kind === 'Agent') {
    const executors = await loadExecutorConfigs(); const executor = executors.find(item => item.id === (node.executorId ?? 'codex'))
    assertExecutorReady(executor, node.executorId ?? 'codex')
    const runner = executor.id === 'codex' ? codexRunner : executor.id === 'claude' ? claudeRunner : undefined
    if (!runner) throw new Error(`Executor adapter not implemented: ${executor.id}`)
    attempt.executorSnapshot = { id: executor.id, path: executor.path, model: executor.model, profile: executor.profile, version: executor.version }
    const inputs = await inputPackage(run, node); attempt.inputArtifactIds = inputs.artifactIds; appendEvent(run, 'executor', `${node.id} · 已冻结 ${inputs.artifactIds.length} 个输入 Artifact`, node.id, attempt.id, { executor: executor.id, model: executor.model || 'default' }); await saveRun(run)
    const writable = node.id.toLowerCase().includes('implementation') || ['code-change', 'implementation-report'].includes(node.outputType ?? '')
    const instruction = writable ? 'Implement the requested changes in this Git worktree. You may edit files. Run focused checks when practical. Do not commit, push, or modify anything outside the worktree.' : 'Analyze the request and produce a concrete report. Do not modify files.'
    const result = normalizeAgentResult(await runner({ prompt: `${instruction}\n\nNode instruction:\n${node.prompt?.trim() || `Complete workflow node ${node.id}.`}\n\nFrozen upstream Artifact package:\n${inputs.content}`, cwd: run.worktreePath, writable, executor, attemptId: attempt.id }))
    for (const activity of result.activities ?? []) appendEvent(run, activity.type, `${node.id} · ${activity.message}`, node.id, attempt.id, activity.details)
    const changedFiles = writable ? (await runProcess('git', ['status', '--short'], run.worktreePath, 15_000)).split('\n').filter(Boolean) : []
    const codeDiff = writable ? await runProcess('git', ['diff', '--binary', '--no-ext-diff', run.baseGitRef ?? 'HEAD'], run.worktreePath, 30_000) : undefined
    return { ...reportPayload(writable ? `完成代码执行，变更 ${changedFiles.length} 项` : 'Agent 报告已生成', result.output), changedFiles, ...(codeDiff === undefined ? {} : { codeDiff }) }
  }
  if (node.kind === '验证') return executeValidation(run, attempt.id)
  if (node.kind === '交付') { const diff = await runProcess('git', ['diff', '--no-ext-diff', '--stat', run.baseGitRef ?? 'HEAD'], run.worktreePath, 30_000); const status = await runProcess('git', ['status', '--short'], run.worktreePath, 15_000); return reportPayload('Git 交付报告已生成', `Worktree: ${run.worktreePath}\nBranch: ${run.branchName}\n\nChanged files:\n${status || '(none)'}\n\nDiff stat:\n${diff || '(none)'}`) }
  return reportPayload(`${node.kind} 节点已完成`, `节点 ${node.id} 已由本地运行时完成。`)
}

async function validateAgentExecutors(nodes: Array<Omit<RunNode, 'state' | 'attempts'>>): Promise<void> {
  const requestedIds = [...new Set(nodes.filter(node => node.kind === 'Agent').map(node => node.executorId ?? 'codex'))]
  if (!requestedIds.length) return
  const executors = await loadExecutorConfigs()
  for (const id of requestedIds) {
    let executor = executors.find(item => item.id === id)
    if (executor?.status === 'available' && executor.authentication === 'unknown') executor = await refreshExecutorAuthentication(id)
    assertExecutorReady(executor, id)
  }
}

function assertExecutorReady(executor: ExecutorConfig | undefined, requestedId: string): asserts executor is ExecutorConfig {
  if (!executor || executor.status !== 'available') throw new Error(`Executor is unavailable: ${requestedId}`)
  if (executor.authentication !== 'authenticated' && executor.authentication !== 'api_key') {
    throw new Error(`Executor requires login before starting a run: ${executor.name}`)
  }
}

async function executeValidation(run: RunSnapshot, attemptId: string): Promise<{ summary: string; content: string }> {
  if (!run.worktreePath) throw new Error('Worktree is not prepared')
  const commands = validationCommands(run)
  if (!commands.length) throw new Error('No detected validation commands are configured')
  const output: string[] = []
  for (const { command } of commands) {
    appendEvent(run, 'command', `开始执行验证命令：${command.command}`, undefined, attemptId, { command: command.command, cwd: command.cwd })
    await saveRun(run)
    output.push(`$ ${command.command}`)
    output.push(await runShellCommand(command.command, join(run.worktreePath, command.cwd), command.timeoutMs, attemptId))
    appendEvent(run, 'command', `验证命令完成：${command.command}`, undefined, attemptId, { command: command.command, cwd: command.cwd })
  }
  return reportPayload(`${commands.length} 个验证命令通过`, output.join('\n\n'))
}

async function inputPackage(run: RunSnapshot, node: RunNode): Promise<{ content: string; artifactIds: string[] }> {
  const parentIds = run.edges.filter(edge => edge.to === node.id).map(edge => edge.from)
  const selected = latestValidArtifacts(run, parentIds)
  const queue = [...selected.flatMap(artifact => artifact.inputArtifactIds), ...(node.steeringArtifactIds ?? [])]
  const included = new Set(selected.map(artifact => artifact.id))
  while (queue.length) {
    const id = queue.shift()!
    if (included.has(id)) continue
    const artifact = run.artifacts.find(item => item.id === id && item.status === 'valid')
    if (!artifact) continue
    included.add(id)
    queue.push(...artifact.inputArtifactIds)
  }
  const artifacts = run.artifacts.filter(artifact => included.has(artifact.id))
  const records = await Promise.all(artifacts.map(async artifact => ({ id: artifact.id, type: artifact.type, version: artifact.version, contentHash: artifact.contentHash, payload: await readArtifactPayload(run.id, artifact.id) })))
  return { content: JSON.stringify(records, null, 2), artifactIds: artifacts.map(artifact => artifact.id) }
}

async function writeArtifact(run: RunSnapshot, node: RunNode, payload: Record<string, unknown> & { summary: string; content: string }, requestedStatus: RunArtifact['status'] = 'valid'): Promise<RunArtifact> {
  const type = node.outputType ?? `${node.kind.toLowerCase()}-report`; const schema = schemaFor(type); const validationErrors = validatePayload(schema, payload); const version = run.artifacts.filter(item => item.type === type).length + 1; const artifactId = `${node.id}-${randomUUID()}`; const relativePath = join('artifacts', node.id, `v${version}`, 'payload.json'); const serialized = JSON.stringify(payload, null, 2)
  const parentIds = run.edges.filter(edge => edge.to === node.id).map(edge => edge.from)
  const inputArtifactIds = node.kind === '输入'
    ? run.artifacts.filter(item => item.type === 'run-input' && item.status === 'valid').slice(-1).map(item => item.id)
    : latestValidArtifacts(run, parentIds).map(artifact => artifact.id)
  const artifact: RunArtifact = { id: artifactId, nodeId: node.id, type, version, schemaId: schema.$id, schemaVersion: schema.version, status: validationErrors.length ? 'invalid' : requestedStatus, path: relativePath, contentHash: hash(serialized), inputArtifactIds, validationErrors, createdAt: new Date().toISOString() }
  const payloadPath = join(runDirectory(run.id), relativePath); await atomicWrite(payloadPath, serialized); await atomicWrite(join(dirname(payloadPath), 'payload.md'), payload.content); await atomicWrite(join(dirname(payloadPath), 'manifest.json'), JSON.stringify(artifact, null, 2)); run.artifacts.push(artifact); appendEvent(run, 'artifact', `${node.id} · 已创建 ${type} v${version}`, node.id, undefined, { artifactId, type, version }); return artifact
}

async function saveArtifactManifest(run: RunSnapshot, artifact: RunArtifact): Promise<void> { await atomicWrite(join(dirname(join(runDirectory(run.id), artifact.path)), 'manifest.json'), JSON.stringify(artifact, null, 2)) }
function normalizeRun(run: RunSnapshot): RunSnapshot {
  run.project.environment.commandAllowlist ??= {}
  run.input = normalizeRunInput(run.input)
  run.events ??= []
  run.nodes = (run.nodes ?? []).map(node => ({ ...node, attempts: node.attempts ?? [], steeringArtifactIds: node.steeringArtifactIds ?? [] }))
  run.artifacts = (run.artifacts ?? []).map((artifact, index) => {
    const normalized = artifact as RunArtifact
    normalized.version ??= index + 1
    normalized.schemaId ??= schemaFor(normalized.type).$id
    normalized.schemaVersion ??= 1
    normalized.validationErrors ??= []
    return normalized
  })
  return run
}
function validationCommands(run: RunSnapshot): Array<{ key: ProjectCommandKey; command: CommandSpec }> {
  const commands = run.project.environment.commands
  const checks = (['typecheck', 'test', 'build', 'lint'] as const).filter(key => commands[key])
  if (!checks.length) return []
  const keys: ProjectCommandKey[] = commands.install ? ['install', ...checks] : checks
  return keys.flatMap(key => commands[key] ? [{ key, command: commands[key]! }] : [])
}
function firstUnapprovedValidationCommand(run: RunSnapshot): { key: ProjectCommandKey; command: CommandSpec } | null {
  return validationCommands(run).find(({ key, command }) => !isProjectCommandApproved(run.project, key, command)) ?? null
}
function parentsSucceeded(run: RunSnapshot, nodeId: string): boolean { return run.edges.filter(edge => edge.to === nodeId).every(edge => run.nodes.find(node => node.id === edge.from)?.state === 'success') }
function latestValidArtifacts(run: RunSnapshot, nodeIds: string[]): RunArtifact[] { return nodeIds.flatMap(nodeId => { const matches = run.artifacts.filter(artifact => artifact.nodeId === nodeId && artifact.status === 'valid'); return matches.length ? [matches.at(-1)!] : [] }) }
function collectDownstream(run: RunSnapshot, sourceId: string): Set<string> { const result = new Set<string>(); const queue = [sourceId]; while (queue.length) { const current = queue.shift()!; for (const edge of run.edges.filter(item => item.from === current)) if (!result.has(edge.to)) { result.add(edge.to); queue.push(edge.to) } } return result }
function markDownstream(run: RunSnapshot, sourceId: string, state: Extract<RunNodeState, 'cancelled' | 'skipped'>): void { for (const nodeId of collectDownstream(run, sourceId)) { const node = run.nodes.find(item => item.id === nodeId); if (node && node.state === 'idle') node.state = state } }
function reportPayload(summary: string, content: string): { summary: string; content: string } { return { summary, content: content.trim() || summary } }
function appendEvent(run: RunSnapshot, type: RunEvent['type'], message: string, nodeId?: string, attemptId?: string, details?: RunEvent['details']): void {
  const event: RunEvent = { id: `event-${randomUUID()}`, occurredAt: new Date().toISOString(), type, message, ...(nodeId ? { nodeId } : {}), ...(attemptId ? { attemptId } : {}), ...(details ? { details } : {}) }
  run.events = [...(run.events ?? []), event].slice(-1_000)
  run.logs = [`${new Date(event.occurredAt).toLocaleTimeString('zh-CN', { hour12: false })} · ${message}`, ...(run.logs ?? [])].slice(0, 200)
}
function appendLog(run: RunSnapshot, message: string): void { appendEvent(run, 'activity', message) }
function isTerminal(status: RunStatus): boolean { return status === 'succeeded' || status === 'failed' || status === 'cancelled' }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
async function saveRun(run: RunSnapshot): Promise<void> { await atomicWrite(manifestPath(run.id), JSON.stringify(run, null, 2)) }
async function atomicWrite(path: string, content: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temporary = `${path}.${randomUUID()}.tmp`; await writeFile(temporary, content, 'utf8'); await rename(temporary, path) }

function normalizeRunInput(input: RunInput | undefined): RunInput {
  const text = typeof input?.text === 'string' ? input.text.slice(0, 40_000) : ''
  const attachments = Array.isArray(input?.attachments) ? input.attachments.slice(0, 12).map((attachment, index) => ({
    id: typeof attachment?.id === 'string' && attachment.id ? attachment.id : `attachment-${index + 1}`,
    name: typeof attachment?.name === 'string' && attachment.name.trim() ? attachment.name.slice(0, 180) : `附件 ${index + 1}`,
    mediaType: typeof attachment?.mediaType === 'string' && attachment.mediaType ? attachment.mediaType.slice(0, 120) : 'application/octet-stream',
    byteLength: Number.isFinite(attachment?.byteLength) ? Math.max(0, Math.min(Number(attachment.byteLength), 8 * 1024 * 1024)) : 0,
    ...(typeof attachment?.dataUrl === 'string' && attachment.dataUrl.length <= 11_200_000 ? { dataUrl: attachment.dataUrl } : {}),
    ...(typeof attachment?.sourceUrl === 'string' && attachment.sourceUrl.length <= 2_000 ? { sourceUrl: attachment.sourceUrl } : {}),
  })) : []
  return { text, attachments, submittedAt: typeof input?.submittedAt === 'string' ? input.submittedAt : new Date().toISOString() }
}

function runInputContent(input: RunInput, fallback?: string): string {
  const requirement = input.text.trim() || fallback?.trim() || '请根据当前项目与工作流配置完成任务。'
  const attachments = input.attachments.length
    ? input.attachments.map(item => `- ${item.name} (${item.mediaType}, ${item.byteLength} bytes)${item.sourceUrl ? ` · ${item.sourceUrl}` : ''}`).join('\n')
    : '(无附件)'
  return `${requirement}\n\n附件：\n${attachments}`
}

function normalizeAgentResult(value: string | AgentRunnerResult): AgentRunnerResult {
  return typeof value === 'string' ? { output: value, activities: [] } : { output: value.output, activities: value.activities ?? [] }
}

async function runCodex(input: { prompt: string; cwd: string; writable: boolean; executor: ExecutorConfig; attemptId: string }): Promise<AgentRunnerResult> {
  const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', input.writable ? 'workspace-write' : 'read-only', '--json']; if (input.executor.model.trim()) args.push('--model', input.executor.model.trim()); args.push(input.prompt)
  const stdout = await runProcess(input.executor.path, args, input.cwd, 1_800_000, input.attemptId)
  const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line) as { type?: string; item?: { type?: string; text?: string; command?: string; exit_code?: number } }] } catch { return [] } })
  const messages = events.flatMap(event => event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text ? [event.item.text] : [])
  const activities: AgentActivity[] = []
  for (const event of events) {
    // Never persist reasoning items. Only retain public agent messages and explicit tool activity.
    if (event.item?.type === 'agent_message' && event.item.text) activities.push({ type: 'activity', message: '执行器返回说明', details: { text: event.item.text.slice(0, 8_000) } })
    if (event.item?.type === 'command_execution') {
      const state = event.type === 'item.started' ? '开始执行命令' : event.type === 'item.completed' ? '命令执行完成' : '命令活动'
      activities.push({ type: 'command', message: state, details: { command: event.item.command?.slice(0, 2_000) ?? '', exitCode: event.item.exit_code ?? null } })
    }
  }
  return { output: messages.join('\n\n') || 'Codex completed without a textual report.', activities }
}

async function runClaude(input: { prompt: string; cwd: string; writable: boolean; executor: ExecutorConfig; attemptId: string }): Promise<AgentRunnerResult> {
  const args = ['--print', '--output-format', 'json', '--permission-mode', input.writable ? 'acceptEdits' : 'plan']
  if (input.executor.model.trim()) args.push('--model', input.executor.model.trim())
  args.push(input.prompt)
  const stdout = await runProcess(input.executor.path, args, input.cwd, 1_800_000, input.attemptId)
  const output = parseClaudeResult(stdout)
  const result = output || 'Claude Code completed without a textual report.'
  return { output: result, activities: [{ type: 'activity', message: '执行器返回说明', details: { text: result.slice(0, 8_000) } }] }
}

function parseClaudeResult(stdout: string): string | undefined {
  const lines = stdout.split(/\r?\n/).filter(Boolean).reverse()
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as { result?: unknown; is_error?: unknown; error?: unknown }
      if (value.is_error === true) throw new Error(typeof value.error === 'string' ? value.error : 'Claude Code returned an error')
      if (typeof value.result === 'string' && value.result.trim()) return value.result.trim()
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
  }
  return stdout.trim() || undefined
}
async function runShellCommand(command: string, cwd: string, timeoutMs: number, attemptId: string): Promise<string> { return runProcess('/bin/zsh', ['-lc', command], cwd, timeoutMs, attemptId) }
async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, attemptId?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); if (attemptId) activeProcesses.set(attemptId, child); let stdout = ''; let stderr = ''; const maxOutput = 2_000_000
    child.stdout.on('data', chunk => { if (stdout.length < maxOutput) stdout += String(chunk) }); child.stderr.on('data', chunk => { if (stderr.length < maxOutput) stderr += String(chunk) })
    let settled = false
    const finish = (handler: () => void) => { if (settled) return; settled = true; clearTimeout(timer); if (attemptId) activeProcesses.delete(attemptId); handler() }
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(() => reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))) }, timeoutMs)
    child.on('error', error => finish(() => reject(error)))
    child.on('close', code => finish(() => code !== 0 ? reject(new Error((stderr || stdout).trim().slice(-8_000) || `${command} exited with code ${code}`)) : resolve(stdout.trim() || stderr.trim())))
  })
}
