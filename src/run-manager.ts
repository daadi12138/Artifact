import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { schemaFor, validatePayload } from './artifact-schema'
import { resolveExecutorForRun, type ExecutorConfig } from './executor-config'
import { notifyRunChanged } from './run-events'
import { approveProjectCommand, detectProjectEnvironment, isProjectCommandApproved, loadProject, type CommandSpec, type ProjectCommandKey, type ProjectConfig } from './project'
import { buildRepositoryMap, intentPrompt, orchestrationReviewReason, parseIntentModelOutput, runStateGraph, textualAttachmentContext, type IntentOrchestrationSnapshot } from './intelligent-orchestration'

export type RunNodeState = 'idle' | 'running' | 'paused' | 'success' | 'waiting' | 'failed' | 'cancelled' | 'skipped'
export type RunStatus = 'preparing' | 'running' | 'paused' | 'awaiting_input' | 'awaiting_approval' | 'awaiting_delivery' | 'succeeded' | 'failed' | 'cancelled'
export type RunInputAttachment = { id: string; name: string; mediaType: string; byteLength: number; dataUrl?: string; sourceUrl?: string }
export type RunInput = { text: string; attachments: RunInputAttachment[]; submittedAt?: string }
export type WorkflowRunReference = { workflowId: string; workflowName: string; revision: number; publishedAt: string }
export type NodeExecutionMode = 'read_only' | 'workspace_write'
export type RunEvent = { id: string; occurredAt: string; type: 'run-created' | 'run-state' | 'node-state' | 'command' | 'executor' | 'artifact' | 'operator' | 'activity' | 'error'; message: string; nodeId?: string; attemptId?: string; details?: Record<string, string | number | boolean | null> }
export type AgentTraceEvent = { schemaVersion: 1; seq: number; occurredAt: string; executorId: string; nodeId: string; attemptId: string; kind: 'status' | 'agent_message' | 'reasoning_summary' | 'tool_started' | 'tool_completed' | 'error'; sourceEventId?: string; toolName?: string; content?: string; command?: string; status?: string; exitCode?: number; durationMs?: number; truncated?: boolean; redacted?: boolean }
export type AgentPromptSnapshot = { schemaVersion: 1; createdAt: string; contentHash: string; runtimeInstruction: string; nodeInstruction: string; renderedPrompt: string; inputArtifactIds: string[]; redacted: boolean }
export type StepAttempt = { id: string; attempt: number; executorId: string; executorSnapshot?: Pick<ExecutorConfig, 'id' | 'path' | 'model' | 'profile' | 'version'>; status: 'running' | 'paused' | 'succeeded' | 'failed' | 'cancelled'; startedAt: string; endedAt?: string; exitReason?: string; process?: { pid: number; commandHash: string; startedAt: string }; output?: string; inputArtifactIds?: string[]; promptSnapshot?: AgentPromptSnapshot; trace?: AgentTraceEvent[]; traceOmittedCount?: number; finalResponse?: string; finalResponseRedacted?: boolean; finalResponseTruncated?: boolean }
export type RunNode = { id: string; kind: string; executorId?: string; prompt?: string; outputType?: string; executionMode?: NodeExecutionMode; state: RunNodeState; attempts: StepAttempt[]; steeringArtifactIds?: string[] }
export type RunEdge = { from: string; to: string }
export type RunArtifact = { id: string; nodeId: string; attemptId?: string; type: string; version: number; schemaId: string; schemaVersion: number; status: 'valid' | 'awaiting_approval' | 'rejected' | 'invalid'; path: string; contentHash: string; inputArtifactIds: string[]; validationErrors: string[]; createdAt: string }
export type PendingCommandApproval = { nodeId: string; commandKey: ProjectCommandKey; command: CommandSpec; requestedAt: string }
export type HumanInteractionKind = 'confirm' | 'choice' | 'text' | 'form' | 'permission' | 'review'
export type HumanInteractionSource = 'agent' | 'intent' | 'command' | 'delivery' | 'approval' | 'operator'
export type HumanInteractionOption = { id: string; label: string; description?: string }
export type HumanInteractionRequest = {
  id: string
  nodeId?: string
  attemptId?: string
  source: HumanInteractionSource
  kind: HumanInteractionKind
  title: string
  question: string
  context?: { command?: string; cwd?: string; files?: string[]; risk?: 'low' | 'medium' | 'high' }
  options?: HumanInteractionOption[]
  required: boolean
  status: 'pending' | 'answered' | 'rejected' | 'expired'
  answer?: unknown
  createdAt: string
  answeredAt?: string
}
export type DeliveryOperation = 'add' | 'modify' | 'delete' | 'rename'
export type DeliveryClassification = 'source' | 'config' | 'test' | 'generated' | 'binary' | 'other'
export type DeliveryConflict = { path: string; reason: string }
export type DeliveryChange = {
  operation: DeliveryOperation
  path: string
  previousPath?: string
  classification: DeliveryClassification
  baseHash: string | null
  worktreeHash: string | null
  projectHash: string | null
  previousBaseHash?: string | null
  previousProjectHash?: string | null
  conflicts: DeliveryConflict[]
}
export type DeliveryApproval = { requestedAt: string; changedFiles: string[]; changes: DeliveryChange[]; worktreePath: string; projectPath: string }
export type RunFailureCategory = 'compilation' | 'test_assertion' | 'dependency' | 'environment' | 'timeout' | 'command_configuration' | 'executor' | 'unknown'
export type RunSnapshot = { id: string; status: RunStatus; startedAt: string; endedAt?: string; workflowCompletedAt?: string; project: ProjectConfig; workflow?: WorkflowRunReference; input: RunInput; intelligence?: IntentOrchestrationSnapshot; baseGitRef?: string; branchName?: string; worktreePath?: string; pendingCommandApproval?: PendingCommandApproval; deliveryApproval?: DeliveryApproval; interactions: HumanInteractionRequest[]; autoRepairCount?: number; lastFailure?: { nodeId: string; attemptId: string; category: RunFailureCategory; message: string; repairExhausted?: boolean }; validationEnvironmentFingerprint?: string; nodes: RunNode[]; edges: RunEdge[]; logs: string[]; events: RunEvent[]; artifacts: RunArtifact[] }
export type StartRunInput = { nodes: Array<Omit<RunNode, 'state' | 'attempts' | 'steeringArtifactIds'>>; edges?: RunEdge[]; input?: RunInput; workflow?: WorkflowRunReference; intentAware?: boolean }
type AgentActivity = { type: 'executor' | 'command' | 'activity'; message: string; details?: Record<string, string | number | boolean | null> }
type AgentInteractionDraft = Omit<CreateInteractionInput, 'source' | 'nodeId' | 'attemptId'> & { source?: HumanInteractionSource; nodeId?: string; attemptId?: string }
type AgentRunnerResult = { output: string; activities?: AgentActivity[] }
type AgentTraceDraft = Omit<AgentTraceEvent, 'schemaVersion' | 'seq' | 'occurredAt' | 'executorId' | 'nodeId' | 'attemptId'>
type AgentRunner = (input: { prompt: string; cwd: string; writable: boolean; executor: ExecutorConfig; runId?: string; nodeId?: string; attemptId: string; attemptDirectory: string; environment: NodeJS.ProcessEnv; onPublicTrace?: (event: AgentTraceDraft) => Promise<void>; onProcessStarted?: (process: NonNullable<StepAttempt['process']>) => Promise<void>; onInteraction?: (interaction: AgentInteractionDraft) => Promise<void> }) => Promise<string | AgentRunnerResult>
type AgentAdapter = { id: string; run: AgentRunner }
type RunProcessOptions = { stdin?: string; env?: NodeJS.ProcessEnv; maxLineLength?: number; onStdoutLine?: (line: string) => void | Promise<void>; onSpawn?: (process: NonNullable<StepAttempt['process']>) => void | Promise<void> }

const stateRoot = () => process.env.ARTIFACT_STATE_DIR || join(process.cwd(), '.artifact')
const artifactRoot = () => join(stateRoot(), 'runs')
const worktreeRoot = () => join(stateRoot(), 'worktrees')
const runDirectory = (id: string) => join(artifactRoot(), id)
const manifestPath = (id: string) => join(runDirectory(id), 'manifest.json')
const attemptDirectory = (runId: string, attemptId: string) => join(runDirectory(runId), 'attempts', attemptId)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const publicTraceLimit = 300
const publicTraceContentLimit = 12_000
const publicTraceCommandLimit = 2_000
const publicFinalResponseLimit = 100_000
const publicTraceSchemaVersion = 1 as const
const activeRuns = new Set<string>()
const activeProcesses = new Map<string, ChildProcess>()
const queuedRuns = new Set<string>()
let recoveryStarted = false
const builtInAgentAdapters = (): AgentAdapter[] => [
  { id: 'codex', run: runCodex },
  { id: 'claude', run: runClaude },
]
let agentAdapters = new Map(builtInAgentAdapters().map(adapter => [adapter.id, adapter]))

export function configureRunManagerForTests(dependencies: { codexRunner?: AgentRunner; claudeRunner?: AgentRunner } = {}): void {
  agentAdapters = new Map(builtInAgentAdapters().map(adapter => [adapter.id, {
    ...adapter,
    run: adapter.id === 'codex' ? dependencies.codexRunner ?? adapter.run : dependencies.claudeRunner ?? adapter.run,
  }]))
}

function maxConcurrentRuns(): number {
  const configured = Number.parseInt(process.env.ARTIFACT_MAX_CONCURRENT_RUNS ?? '2', 10)
  return Number.isFinite(configured) ? Math.max(1, Math.min(configured, 8)) : 2
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
  const snapshot: RunSnapshot = { id: `run-${randomUUID()}`, status: 'preparing', startedAt: new Date().toISOString(), project: structuredClone(project), workflow: input.workflow ? structuredClone(input.workflow) : undefined, input: runInput, ...(input.intentAware ? { intelligence: { schemaVersion: 1, status: 'running', startedAt: new Date().toISOString(), currentStage: 'context' } as IntentOrchestrationSnapshot } : {}), nodes: input.nodes.map(node => ({ ...node, state: 'idle', attempts: [] })), edges, interactions: [], logs: [], events: [], artifacts: [] }
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

type CreateInteractionInput = Omit<HumanInteractionRequest, 'id' | 'status' | 'createdAt' | 'answeredAt' | 'answer'>

function addInteraction(run: RunSnapshot, input: CreateInteractionInput): HumanInteractionRequest {
  const existing = run.interactions.find(item => item.status === 'pending' && item.source === input.source && item.nodeId === input.nodeId)
  if (existing) return existing
  const interaction: HumanInteractionRequest = { ...input, id: `interaction-${randomUUID()}`, status: 'pending', createdAt: new Date().toISOString() }
  run.interactions = [...run.interactions, interaction].slice(-100)
  appendEvent(run, 'operator', `${input.title} · 等待用户响应`, input.nodeId, input.attemptId, { interactionId: interaction.id, kind: input.kind, source: input.source })
  return interaction
}

function resolveInteraction(run: RunSnapshot, source: HumanInteractionSource, status: 'answered' | 'rejected', answer: unknown): void {
  const pending = [...run.interactions].reverse().find(item => item.status === 'pending' && item.source === source)
  if (!pending) return
  pending.status = status
  pending.answer = answer
  pending.answeredAt = new Date().toISOString()
}

export async function requestRunInteraction(id: string, input: CreateInteractionInput): Promise<RunSnapshot | null> {
  const run = await getRun(id)
  if (!run) return null
  const node = input.nodeId ? run.nodes.find(item => item.id === input.nodeId) : undefined
  if (input.nodeId && !node) throw new Error('Node not found')
  const pauseNode = (candidate: RunNode) => {
    const attempt = candidate.attempts.at(-1)
    if (candidate.state === 'running' && attempt?.status === 'running') {
      activeProcesses.get(attempt.id)?.kill('SIGTERM')
      attempt.status = 'paused'; attempt.endedAt = new Date().toISOString(); attempt.exitReason = 'waiting_for_user_input'
      candidate.state = 'waiting'
    } else if (candidate.state === 'idle') candidate.state = 'waiting'
  }
  if (node) pauseNode(node)
  else if (run.status === 'running') run.nodes.filter(candidate => candidate.state === 'running').forEach(pauseNode)
  addInteraction(run, input)
  if (input.source === 'agent' || input.source === 'operator') run.status = 'awaiting_input'
  delete run.endedAt
  await saveRun(run)
  return run
}

function interactionDecision(answer: unknown): 'approve' | 'reject' | 'submit' {
  if (answer === true || answer === 'approve') return 'approve'
  if (answer === false || answer === 'reject') return 'reject'
  if (answer && typeof answer === 'object' && 'decision' in answer) {
    const decision = (answer as { decision?: unknown }).decision
    if (decision === 'approve') return 'approve'
    if (decision === 'reject') return 'reject'
  }
  return 'submit'
}

export async function answerRunInteraction(id: string, interactionId: string, answer: unknown): Promise<RunSnapshot | null> {
  const run = await getRun(id)
  if (!run) return null
  const interaction = run.interactions.find(item => item.id === interactionId)
  if (!interaction) throw new Error('Interaction not found')
  if (interaction.status !== 'pending') throw new Error('Interaction has already been resolved')
  validateInteractionAnswer(interaction, answer)
  const decision = interactionDecision(answer)
  if (['intent', 'command', 'delivery', 'approval'].includes(interaction.source)) {
    const resolved = decision === 'reject' ? await rejectRun(id) : await approveRun(id)
    if (!resolved) return null
    const latest = await getRun(id)
    const record = latest?.interactions.find(item => item.id === interactionId)
    if (record) { record.answer = answer; record.status = decision === 'reject' ? 'rejected' : 'answered'; record.answeredAt = new Date().toISOString(); await saveRun(latest!) }
    return latest
  }
  const latest = await getRun(id)
  if (!latest) return null
  const record = latest.interactions.find(item => item.id === interactionId)
  if (!record) return null
  record.answer = answer; record.status = decision === 'reject' ? 'rejected' : 'answered'; record.answeredAt = new Date().toISOString()
  const node = record.nodeId ? latest.nodes.find(item => item.id === record.nodeId) : undefined
  if (node && node.state === 'waiting') node.state = 'idle'
  if (decision === 'reject') {
    if (node) { node.state = 'failed'; markDownstream(latest, node.id, 'cancelled') }
    latest.status = 'cancelled'; latest.endedAt = new Date().toISOString()
    appendLog(latest, `${record.title} · 用户拒绝，运行已取消`)
  } else {
    latest.status = 'running'; delete latest.endedAt
    appendLog(latest, `${record.title} · 已收到用户响应`)
    if (record.nodeId && record.answer !== undefined) {
      const artifact = await writeArtifact(latest, { id: `interaction-${record.id}`, kind: '操作说明', outputType: 'operator-response', state: 'success', attempts: [] }, reportPayload('用户交互响应', JSON.stringify(record.answer)))
      if (node) node.steeringArtifactIds = [...(node.steeringArtifactIds ?? []), artifact.id]
    }
  }
  await saveRun(latest)
  if (latest.status === 'running') void processRun(id)
  return latest
}

function validateInteractionAnswer(interaction: HumanInteractionRequest, answer: unknown): void {
  const decision = interactionDecision(answer)
  if (decision === 'reject' || interaction.kind === 'confirm' || interaction.kind === 'permission' || interaction.kind === 'review') return
  if (interaction.kind === 'choice') {
    const optionId = answer && typeof answer === 'object' && 'optionId' in answer ? (answer as { optionId?: unknown }).optionId : undefined
    if (typeof optionId !== 'string' || !interaction.options?.some(option => option.id === optionId)) throw new Error('A valid interaction option is required')
    return
  }
  if (interaction.kind === 'text' && (typeof answer !== 'string' || !answer.trim())) throw new Error('A text response is required')
  if (interaction.kind === 'form' && (!answer || typeof answer !== 'object')) throw new Error('A form response is required')
}

export async function listRuns(): Promise<RunSnapshot[]> {
  await ensureRecovery()
  try { const entries = await readdir(artifactRoot(), { withFileTypes: true }); const runs = await Promise.all(entries.filter(entry => entry.isDirectory()).map(entry => getRun(entry.name))); return runs.filter((run): run is RunSnapshot => run !== null).sort((a, b) => b.startedAt.localeCompare(a.startedAt)) } catch { return [] }
}

export async function approveRun(id: string): Promise<RunSnapshot | null> {
  const run = await getRun(id); if (!run) return null
  if (run.deliveryApproval) {
    run.deliveryApproval = await buildDeliveryApproval(run, run.deliveryApproval.requestedAt)
    if (run.deliveryApproval.changes.some(change => change.conflicts.length)) {
      appendLog(run, '交付已暂停：目标项目在运行期间发生了冲突变更')
      await saveRun(run)
      return run
    }
    await applyDelivery(run)
    delete run.deliveryApproval
    run.status = 'succeeded'
    run.endedAt = new Date().toISOString()
    resolveInteraction(run, 'delivery', 'answered', { decision: 'approve' })
    appendLog(run, `交付已批准 · 结果已应用到项目目录 ${run.project.repositoryPath}`)
    await saveRun(run)
    return run
  }
  if (run.intelligence?.status === 'awaiting_approval' && run.status === 'awaiting_approval') {
    run.intelligence.status = 'completed'
    run.intelligence.currentStage = 'complete'
    run.intelligence.completedAt = new Date().toISOString()
    run.status = 'running'
    resolveInteraction(run, 'intent', 'answered', { decision: 'approve' })
    appendLog(run, '意图与执行计划已由操作员确认')
    await saveRun(run)
    void processRun(id)
    return run
  }
  const approval = run.nodes.find(node => node.state === 'waiting'); if (!approval || run.status !== 'awaiting_approval') return run
  if (run.pendingCommandApproval) {
    const pending = run.pendingCommandApproval
    if (approval.id !== pending.nodeId) throw new Error('The waiting node does not match the requested command approval')
    const project = await loadProject()
    const projectCommand = project?.environment.commands[pending.commandKey]
    if (project && projectCommand && sameCommand(projectCommand, pending.command)) {
      run.project = structuredClone(await approveProjectCommand(pending.commandKey, pending.command))
    } else {
      // Commands detected only after an Agent creates a project belong to this
      // run's Worktree. Approval must not add them to the original project.
      run.project.environment.commandAllowlist[pending.commandKey] = { ...pending.command, approvedAt: new Date().toISOString() }
    }
    approval.state = 'idle'
    delete run.pendingCommandApproval
    run.status = 'running'
    resolveInteraction(run, 'command', 'answered', { decision: 'approve' })
    appendLog(run, `${approval.id} · 已允许 ${pending.commandKey}：${pending.command.command}`)
    await saveRun(run); void processRun(id); return run
  }
  approval.state = 'success'; const attempt = approval.attempts.at(-1); if (attempt) { attempt.status = 'succeeded'; attempt.endedAt = new Date().toISOString() }
  run.status = 'running'; appendLog(run, `${approval.id} · 人工审批已通过`)
  resolveInteraction(run, 'approval', 'answered', { decision: 'approve' })
  const pending = [...run.artifacts].reverse().find(item => item.nodeId === approval.id && item.status === 'awaiting_approval'); if (pending) { pending.status = 'valid'; await saveArtifactManifest(run, pending) }
  await saveRun(run); void processRun(id); return run
}

export async function requestDeliveryApproval(id: string): Promise<RunSnapshot | null> {
  const run = await getRun(id); if (!run) return null
  if (run.status !== 'succeeded' && run.status !== 'awaiting_delivery') throw new Error('Only a completed run can be delivered')
  if (!run.worktreePath) throw new Error('Worktree is not prepared')
  run.deliveryApproval = await buildDeliveryApproval(run)
  if (!run.deliveryApproval.changes.length) throw new Error('No Worktree changes are available for delivery')
  run.status = 'awaiting_delivery'
  delete run.endedAt
  addInteraction(run, { source: 'delivery', kind: 'review', title: '确认交付结果', question: '请检查待应用到项目目录的文件变更。确认后才会写入原项目。', context: { files: run.deliveryApproval.changedFiles, risk: 'high' }, required: true })
  appendLog(run, `已准备交付审批 · ${run.deliveryApproval.changes.length} 项变更等待确认`)
  await saveRun(run)
  return run
}

export async function rejectRun(id: string): Promise<RunSnapshot | null> {
  const run = await getRun(id); if (!run) return null
  if (run.deliveryApproval) {
    delete run.deliveryApproval
    run.status = 'cancelled'; run.endedAt = new Date().toISOString()
    resolveInteraction(run, 'delivery', 'rejected', { decision: 'reject' })
    appendLog(run, '交付已拒绝 · Worktree 中的变更未应用到项目目录')
    await saveRun(run)
    return run
  }
  if (run.intelligence?.status === 'awaiting_approval' && run.status === 'awaiting_approval') {
    run.intelligence.status = 'failed'
    run.status = 'cancelled'; run.endedAt = new Date().toISOString()
    resolveInteraction(run, 'intent', 'rejected', { decision: 'reject' })
    for (const node of run.nodes) if (node.state === 'idle') node.state = 'cancelled'
    appendLog(run, '意图与执行计划未获批准，运行已取消')
    await saveRun(run)
    return run
  }
  const approval = run.nodes.find(node => node.state === 'waiting'); if (!approval || run.status !== 'awaiting_approval') return run
  if (run.pendingCommandApproval) {
    const pending = run.pendingCommandApproval
    if (approval.id !== pending.nodeId) throw new Error('The waiting node does not match the requested command approval')
    approval.state = 'failed'
    markDownstream(run, approval.id, 'cancelled')
    delete run.pendingCommandApproval
    run.status = 'failed'; run.endedAt = new Date().toISOString()
    resolveInteraction(run, 'command', 'rejected', { decision: 'reject' })
    appendLog(run, `${approval.id} · 已拒绝 ${pending.commandKey}，后续节点已取消`)
    await saveRun(run); return run
  }
  approval.state = 'failed'; const attempt = approval.attempts.at(-1); if (attempt) { attempt.status = 'failed'; attempt.endedAt = new Date().toISOString(); attempt.exitReason = 'rejected' }
  resolveInteraction(run, 'approval', 'rejected', { decision: 'reject' })
  const pending = [...run.artifacts].reverse().find(item => item.nodeId === approval.id && item.status === 'awaiting_approval'); if (pending) { pending.status = 'rejected'; await saveArtifactManifest(run, pending) }
  markDownstream(run, approval.id, 'cancelled'); run.status = 'failed'; run.endedAt = new Date().toISOString(); appendLog(run, `${approval.id} · 人工审批已拒绝，后续节点已取消`); await saveRun(run); return run
}

export async function cancelRun(id: string): Promise<RunSnapshot | null> {
  const run = await getRun(id); if (!run) return null; if (isTerminal(run.status)) return run
  queuedRuns.delete(id)
  for (const node of run.nodes) {
    if (node.state === 'idle' || node.state === 'waiting') node.state = 'cancelled'
    if (node.state === 'running') { node.state = 'cancelled'; const attempt = node.attempts.at(-1); if (attempt) { activeProcesses.get(attempt.id)?.kill('SIGTERM'); attempt.status = 'cancelled'; attempt.endedAt = new Date().toISOString(); attempt.exitReason = 'cancelled_by_user' } }
  }
  delete run.pendingCommandApproval
  run.status = 'cancelled'; run.endedAt = new Date().toISOString(); appendLog(run, '运行已取消'); await saveRun(run); return run
}

export async function retryRun(id: string, nodeId: string): Promise<RunSnapshot | null> {
  const run = await getRun(id); if (!run) return null; if (!run.nodes.some(node => node.id === nodeId)) throw new Error('Node not found')
  const blockedAncestors = [...collectAncestors(run, nodeId)]
    .filter(ancestorId => run.nodes.find(node => node.id === ancestorId)?.state !== 'success')
    .sort((left, right) => run.nodes.findIndex(node => node.id === left) - run.nodes.findIndex(node => node.id === right))
  const startNodeId = blockedAncestors[0] ?? nodeId
  const affected = collectDownstream(run, startNodeId); affected.add(startNodeId); for (const node of run.nodes) if (affected.has(node.id)) node.state = 'idle'
  if (run.pendingCommandApproval && affected.has(run.pendingCommandApproval.nodeId)) delete run.pendingCommandApproval
  run.status = 'running'; delete run.endedAt
  appendEvent(run, 'operator', startNodeId === nodeId ? `${nodeId} · 已请求重试` : `${nodeId} · 上游节点 ${startNodeId} 尚未完成，已从该节点重试`, startNodeId)
  await saveRun(run); void processRun(id); return run
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
  const orphaned = paused.find(node => {
    const attempt = node.attempts.at(-1)
    return attempt?.exitReason === 'process_still_running' && attempt.process && isProcessAlive(attempt.process.pid)
  })
  if (orphaned) throw new Error(`Attempt ${orphaned.attempts.at(-1)?.id} may still be running outside Artifact. Stop it before resuming this run.`)
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
    let hasLiveProcess = false
    for (const node of run.nodes.filter(item => item.state === 'running')) {
      node.state = 'idle'
      const attempt = node.attempts.at(-1)
      if (attempt?.status === 'running') {
        if (attempt.process && isProcessAlive(attempt.process.pid)) {
          node.state = 'paused'; attempt.status = 'paused'; attempt.endedAt = new Date().toISOString(); attempt.exitReason = 'process_still_running'; hasLiveProcess = true
          appendLog(run, `${node.id} · 服务重启后检测到 PID ${attempt.process.pid} 仍在运行，已暂停以避免重复执行`)
          continue
        }
        attempt.status = 'failed'; attempt.endedAt = new Date().toISOString(); attempt.exitReason = 'process_lost'
        if (node.kind === 'Agent') await appendAgentTrace(run, node, attempt, { kind: 'error', content: 'Executor process was lost during service restart.' })
      }
      appendLog(run, `${node.id} · 服务重启，上一 Attempt 标记为 process_lost`)
    }
    if (hasLiveProcess) { run.status = 'paused'; await saveRun(run); continue }
    run.status = 'running'; await saveRun(run); void processRun(run.id)
  }
}

async function processRun(id: string): Promise<void> {
  if (activeRuns.has(id)) return
  if (activeRuns.size >= maxConcurrentRuns()) {
    queuedRuns.add(id)
    const queued = await getRun(id)
    if (queued && !isTerminal(queued.status) && !queued.logs.some(line => line.includes('等待运行并发槽位'))) {
      appendLog(queued, `等待运行并发槽位（最多 ${maxConcurrentRuns()} 个同时运行）`)
      await saveRun(queued)
    }
    return
  }
  queuedRuns.delete(id); activeRuns.add(id)
  try {
    let run = await getRun(id); if (!run || isTerminal(run.status) || run.status === 'awaiting_input' || run.status === 'awaiting_approval' || run.status === 'awaiting_delivery') return
    if (!run.worktreePath) {
      try { await prepareWorktree(run); run.status = 'running'; appendLog(run, `Worktree 已创建 · ${run.worktreePath}`); await saveRun(run) }
      catch (error) { const failure = redactPublicText(errorMessage(error)).value; run.status = 'failed'; run.endedAt = new Date().toISOString(); appendLog(run, `Worktree 创建失败 · ${failure}`); await saveRun(run); return }
    }
    if (run.intelligence?.status === 'running') {
      const ready = await prepareIntelligentRun(run)
      if (!ready) return
    }
    while (true) {
      run = await getRun(id); if (!run || run.status !== 'running') return
      const ready = run.nodes.find(node => node.state === 'idle' && parentsSucceeded(run!, node.id))
      if (!ready) {
        if (run.nodes.every(node => node.state === 'success' || node.state === 'skipped')) {
          run.status = 'succeeded'; run.workflowCompletedAt = new Date().toISOString(); run.endedAt = run.workflowCompletedAt
          if (run.worktreePath) {
            const delivery = await buildDeliveryApproval(run)
            if (delivery.changes.length) {
              run.deliveryApproval = delivery
              run.status = 'awaiting_delivery'
              delete run.endedAt
              addInteraction(run, { source: 'delivery', kind: 'review', title: '确认交付结果', question: '请检查待应用到项目目录的文件变更。确认后才会写入原项目。', context: { files: delivery.changedFiles, risk: 'high' }, required: true })
              appendLog(run, `工作流已完成 · ${delivery.changes.length} 项变更等待交付审批`)
            } else appendLog(run, '工作流已成功完成 · 未检测到文件变更')
          } else appendLog(run, '工作流已成功完成')
          await saveRun(run)
        }
        else if (!run.nodes.some(node => node.state === 'waiting' || node.state === 'running')) { run.status = 'failed'; run.endedAt = new Date().toISOString(); appendLog(run, '工作流无法继续：前置节点未成功'); await saveRun(run) }
        return
      }
      if (ready.kind === '验证') {
        await discoverWorktreeValidationCommands(run)
        const pendingCommand = firstUnapprovedValidationCommand(run)
      if (pendingCommand) {
          ready.state = 'waiting'
          run.status = 'awaiting_approval'
          run.pendingCommandApproval = { nodeId: ready.id, commandKey: pendingCommand.key, command: structuredClone(pendingCommand.command), requestedAt: new Date().toISOString() }
          addInteraction(run, { nodeId: ready.id, source: 'command', kind: 'permission', title: '允许执行验证命令', question: `验证节点需要执行 ${pendingCommand.key} 命令。`, context: { command: pendingCommand.command.command, cwd: pendingCommand.command.cwd, risk: 'medium' }, required: true })
          appendLog(run, `${ready.id} · 等待允许 ${pendingCommand.key}：${pendingCommand.command.command}`)
          await saveRun(run)
          return
        }
      }
      const attempt: StepAttempt = { id: `attempt-${randomUUID()}`, attempt: ready.attempts.length + 1, executorId: ready.executorId ?? (ready.kind === 'Agent' ? 'codex' : 'local'), status: 'running', startedAt: new Date().toISOString() }
      ready.attempts.push(attempt); ready.state = 'running'; appendLog(run, `${ready.id} · Attempt ${attempt.attempt} 开始执行`); await saveRun(run)
      try {
        if (ready.kind === '审批') { ready.state = 'waiting'; run.status = 'awaiting_approval'; addInteraction(run, { nodeId: ready.id, attemptId: attempt.id, source: 'approval', kind: 'confirm', title: '等待人工审批', question: '请确认当前节点产物后继续流程。', required: true }); appendLog(run, `${ready.id} · 等待人工审批`); await writeArtifact(run, ready, reportPayload('等待人工审批', '该节点已暂停，等待人工审批。'), { status: 'awaiting_approval', attemptId: attempt.id }); await saveRun(run); return }
        const payload = await executeNode(run, ready, attempt)
        const latest = await getRun(id); if (!latest || latest.status !== 'running') return
        const node = latest.nodes.find(item => item.id === ready.id); const latestAttempt = node?.attempts.find(item => item.id === attempt.id)
        if (!node || !latestAttempt || node.state !== 'running' || latestAttempt.status !== 'running') return
        if (node.kind === 'Agent') setAttemptFinalResponse(latestAttempt, payload.content)
        const artifact = await writeArtifact(latest, node, payload, { attemptId: latestAttempt.id })

        if (typeof payload.codeDiff === 'string') {
          await writeArtifact(latest, { ...node, outputType: 'code-diff' }, reportPayload(payload.codeDiff ? '代码 Diff 已生成' : '没有检测到代码 Diff', payload.codeDiff || '当前节点没有产生受 Git 跟踪的代码变更。'), { attemptId: latestAttempt.id })
        }
        if (artifact.status === 'invalid') { await saveRun(latest); throw new Error(`Artifact schema validation failed: ${artifact.validationErrors.join(', ')}`) }
        node.state = 'success'; latestAttempt.status = 'succeeded'; latestAttempt.endedAt = new Date().toISOString(); latestAttempt.output = payload.summary
        if (node.kind === 'Agent') await appendAgentTrace(latest, node, latestAttempt, { kind: 'status', content: 'Agent execution completed.' })
        appendLog(latest, `${node.id} · 执行完成，Artifact v${artifact.version} 已通过 Schema 校验`); await saveRun(latest)
      } catch (error) {
        const latest = await getRun(id); if (!latest || latest.status !== 'running') return
        const node = latest.nodes.find(item => item.id === ready.id); const latestAttempt = node?.attempts.find(item => item.id === attempt.id)
        if (!node || !latestAttempt || node.state !== 'running' || latestAttempt.status !== 'running') return
        const failure = normalizePublicText(errorMessage(error), publicTraceContentLimit).value ?? 'Executor failed.'
        node.state = 'failed'; latestAttempt.status = 'failed'; latestAttempt.endedAt = new Date().toISOString(); latestAttempt.exitReason = failure
        if (node.kind === 'Agent') await appendAgentTrace(latest, node, latestAttempt, { kind: 'error', content: failure })
        const failureCategory = classifyFailure(failure)
        latest.lastFailure = { nodeId: node.id, attemptId: latestAttempt.id, category: failureCategory, message: failure }
        const repairableValidationFailure = failureCategory === 'compilation' || failureCategory === 'test_assertion'
        const repairLimit = latest.intelligence?.plan?.recovery.maxValidationRepairs ?? 2
        if (node.kind === '验证' && repairableValidationFailure && (latest.autoRepairCount ?? 0) < repairLimit) {
          const repairAgent = [...latest.nodes].reverse().find(candidate => candidate.kind === 'Agent' && nodeCanWrite(candidate) && latest.edges.some(edge => edge.from === candidate.id && edge.to === node.id))
          if (repairAgent) {
            latest.autoRepairCount = (latest.autoRepairCount ?? 0) + 1
            const repair = await writeArtifact(latest, { id: `auto-repair-${node.id}`, kind: '操作说明', outputType: 'operator-note', state: 'success', attempts: [] }, reportPayload('验证失败，自动修复上下文', `验证节点 ${node.id} 失败：\n${failure}\n\n请修复后重新运行验证。`))
            repairAgent.steeringArtifactIds = [...(repairAgent.steeringArtifactIds ?? []), repair.id]
            node.state = 'idle'; repairAgent.state = 'idle'
            for (const downstream of collectDownstream(latest, node.id)) latest.nodes.find(item => item.id === downstream)!.state = 'idle'
            latest.status = 'running'; delete latest.endedAt
            appendLog(latest, `${node.id} · 验证失败，已请求 Agent 自动修复（第 ${latest.autoRepairCount}/${repairLimit} 轮）`)
            await saveRun(latest)
            continue
          }
        }
        if (node.kind === '验证' && repairableValidationFailure && (latest.autoRepairCount ?? 0) >= repairLimit) {
          latest.lastFailure.repairExhausted = true
          appendLog(latest, `${node.id} · 自动修复已达上限，请查看失败分类和最后一次输出后决定下一步`)
        }
        markDownstream(latest, node.id, 'skipped'); latest.status = 'failed'; latest.endedAt = new Date().toISOString(); appendLog(latest, `${node.id} · Attempt ${latestAttempt.attempt} 失败（${failureCategory}）：${failure}`); await saveRun(latest); return
      }
    }
  } finally {
    activeRuns.delete(id)
    const latest = await getRun(id)
    if (latest?.status === 'running' && latest.nodes.some(node => node.state === 'idle' && parentsSucceeded(latest, node.id))) void processRun(id)
    drainRunQueue()
  }
}

function drainRunQueue(): void {
  for (const id of queuedRuns) {
    if (activeRuns.size >= maxConcurrentRuns()) return
    queuedRuns.delete(id)
    void processRun(id)
  }
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
    const executor = await resolveExecutorForRun(node.executorId ?? 'codex')
    assertExecutorReady(executor, node.executorId ?? 'codex')
    const adapter = agentAdapters.get(executor.id)
    if (!adapter) throw new Error(`Executor adapter not implemented: ${executor.id}`)
    attempt.executorSnapshot = { id: executor.id, path: executor.path, model: executor.model, profile: executor.profile, version: executor.version }
    const inputs = await inputPackage(run, node); attempt.inputArtifactIds = inputs.artifactIds
    const writable = nodeCanWrite(node)
    const runtimeInstruction = writable ? 'Implement the requested changes in this Git worktree. You may edit files. Run focused checks when practical. Do not commit, push, or modify anything outside the worktree.' : 'Analyze the request and produce a concrete report. Do not modify files.'
    const nodeInstruction = node.prompt?.trim() || `Complete workflow node ${node.id}.`
    const renderedPrompt = `${runtimeInstruction}\n\nNode instruction:\n${nodeInstruction}\n\nFrozen upstream Artifact package:\n${inputs.content}`
    const displayRuntimeInstruction = redactPublicText(runtimeInstruction)
    const displayNodeInstruction = redactPublicText(nodeInstruction)
    const displayPrompt = redactPublicText(renderedPrompt)
    attempt.promptSnapshot = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      contentHash: hash(renderedPrompt),
      runtimeInstruction: displayRuntimeInstruction.value,
      nodeInstruction: displayNodeInstruction.value,
      renderedPrompt: displayPrompt.value,
      inputArtifactIds: [...inputs.artifactIds],
      redacted: displayRuntimeInstruction.redacted || displayNodeInstruction.redacted || displayPrompt.redacted,
    }
    appendEvent(run, 'executor', `${node.id} · 已冻结 ${inputs.artifactIds.length} 个输入 Artifact`, node.id, attempt.id, { executor: executor.id, model: executor.model || 'default' })
    await appendAgentTrace(run, node, attempt, { kind: 'status', content: 'Prompt frozen and dispatched to executor.' })
    await saveRun(run)
    const result = normalizeAgentResult(await adapter.run({
      prompt: renderedPrompt,
      cwd: run.worktreePath,
      writable,
      executor,
      runId: run.id,
      nodeId: node.id,
      attemptId: attempt.id,
      attemptDirectory: attemptDirectory(run.id, attempt.id),
      // The selected executor's local CLI supplies its own authenticated environment.
      environment: agentEnvironment(),
      onPublicTrace: event => persistAgentTrace(run.id, node.id, attempt.id, event),
      onProcessStarted: process => persistAttemptProcess(run.id, node.id, attempt.id, process),
      onInteraction: interaction => requestRunInteraction(run.id, {
        ...interaction,
        nodeId: interaction.nodeId ?? node.id,
        attemptId: interaction.attemptId ?? attempt.id,
        source: interaction.source ?? 'agent',
        required: interaction.required !== false,
      }).then(() => undefined),
    }))
    for (const activity of result.activities ?? []) await persistLegacyAgentActivity(run.id, node.id, attempt.id, activity)
    const publicOutput = redactPublicText(result.output).value
    const changedFiles = writable ? (await runProcess('git', ['status', '--short'], run.worktreePath, 15_000)).split('\n').filter(Boolean) : []
    const codeDiff = writable ? await runProcess('git', ['diff', '--binary', '--no-ext-diff', run.baseGitRef ?? 'HEAD'], run.worktreePath, 30_000) : undefined
    return { ...reportPayload(writable ? `完成代码执行，变更 ${changedFiles.length} 项` : 'Agent 报告已生成', publicOutput), changedFiles, ...(codeDiff === undefined ? {} : { codeDiff }) }
  }
  if (node.kind === '验证') return executeValidation(run, node, attempt)
  if (node.kind === '交付') { const diff = await runProcess('git', ['diff', '--no-ext-diff', '--stat', run.baseGitRef ?? 'HEAD'], run.worktreePath, 30_000); const status = await runProcess('git', ['status', '--short'], run.worktreePath, 15_000); return reportPayload('Git 交付报告已生成', `Worktree: ${run.worktreePath}\nBranch: ${run.branchName}\n\nChanged files:\n${status || '(none)'}\n\nDiff stat:\n${diff || '(none)'}`) }
  return reportPayload(`${node.kind} 节点已完成`, `节点 ${node.id} 已由本地运行时完成。`)
}

async function validateAgentExecutors(nodes: Array<Omit<RunNode, 'state' | 'attempts'>>): Promise<void> {
  const requestedIds = [...new Set(nodes.filter(node => node.kind === 'Agent').map(node => node.executorId ?? 'codex'))]
  if (!requestedIds.length) return
  for (const id of requestedIds) {
    const executor = await resolveExecutorForRun(id)
    assertExecutorReady(executor, id)
    if (!agentAdapters.has(executor.id)) throw new Error(`Executor adapter not implemented: ${executor.id}`)
  }
}

function assertExecutorReady(executor: ExecutorConfig | undefined, requestedId: string): asserts executor is ExecutorConfig {
  if (!executor || executor.status !== 'available') throw new Error(`Executor is unavailable: ${requestedId}`)
  if (executor.authentication !== 'authenticated' && executor.authentication !== 'api_key') {
    throw new Error(`Executor requires login before starting a run: ${executor.name}`)
  }
}

function agentEnvironment(): NodeJS.ProcessEnv {
  const coreKeys = [
    'PATH', 'HOME', 'TMPDIR', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'COLORTERM',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR', 'FORCE_COLOR',
    'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_CA_CERTIFICATE',
  ]
  const allowed = new Set(coreKeys)
  for (const key of Object.keys(process.env)) if (key.startsWith('LC_')) allowed.add(key)
  return Object.fromEntries([...allowed].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv
}

async function executeValidation(run: RunSnapshot, node: RunNode, attempt: StepAttempt): Promise<{ summary: string; content: string }> {
  if (!run.worktreePath) throw new Error('Worktree is not prepared')
  const commands = validationCommands(run)
  if (!commands.length) {
    const content = 'Worktree 中没有识别到 test、typecheck、build 或 lint 命令。本次运行未执行自动验证；该结果不会阻断交付审批。'
    appendEvent(run, 'command', '未识别到可执行验证命令，已记录未覆盖验证结果', node.id, attempt.id)
    await saveRun(run)
    return reportPayload('未识别到可执行验证命令', content)
  }
  const output: string[] = []
  for (const { command } of commands) {
    appendEvent(run, 'command', `开始执行验证命令：${command.command}`, node.id, attempt.id, { command: command.command, cwd: command.cwd })
    await saveRun(run)
    output.push(`$ ${command.command}`)
    output.push(await runShellCommand(command.command, join(run.worktreePath, command.cwd), command.timeoutMs, attempt.id, process => persistAttemptProcess(run.id, node.id, attempt.id, process)))
    appendEvent(run, 'command', `验证命令完成：${command.command}`, node.id, attempt.id, { command: command.command, cwd: command.cwd })
  }
  return reportPayload(`${commands.length} 个验证命令通过`, output.join('\n\n'))
}

async function inputPackage(run: RunSnapshot, node: RunNode): Promise<{ content: string; artifactIds: string[] }> {
  const parentIds = run.edges.filter(edge => edge.to === node.id).map(edge => edge.from)
  const globalContext = run.artifacts.filter(artifact => ['intent-spec', 'repository-map', 'execution-plan'].includes(artifact.type) && artifact.status === 'valid')
  const selected = [...globalContext, ...latestValidArtifacts(run, parentIds)]
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

async function prepareIntelligentRun(run: RunSnapshot): Promise<boolean> {
  if (!run.intelligence || !run.worktreePath) return true
  try {
    run.intelligence.currentStage = 'context'
    appendLog(run, '智能编排 · 正在构建代码库上下文')
    await saveRun(run)
    const repositoryMap = await buildRepositoryMap(run.worktreePath, run.input.text)
    run.intelligence.repositoryMap = repositoryMap
    await writeArtifact(run, { id: 'repository-context', kind: '编排', outputType: 'repository-map', state: 'success', attempts: [] }, reportPayload(`代码库地图包含 ${repositoryMap.fileCount} 个文件`, repositoryMap.content || '(empty repository)'))

    run.intelligence.currentStage = 'intent'
    appendLog(run, '智能编排 · 正在解析用户意图并生成执行计划')
    await saveRun(run)
    const executorId = run.nodes.find(node => node.kind === 'Agent')?.executorId ?? 'codex'
    const executor = await resolveExecutorForRun(executorId)
    assertExecutorReady(executor, executorId)
    const adapter = agentAdapters.get(executor.id)
    if (!adapter) throw new Error(`Executor adapter not implemented: ${executor.id}`)
    const prompt = intentPrompt({
      requirement: run.input.text,
      attachments: textualAttachmentContext(run.input.attachments),
      repositoryMap: repositoryMap.content,
      workflowId: run.workflow?.workflowId,
      workflowName: run.workflow?.workflowName,
      nodes: run.nodes.map(node => ({ id: node.id, kind: node.kind, prompt: node.prompt })),
    })
    const result = normalizeAgentResult(await adapter.run({
      prompt,
      cwd: run.worktreePath,
      writable: false,
      executor,
      attemptId: `intent-${run.id}`,
      attemptDirectory: attemptDirectory(run.id, 'intent'),
      environment: agentEnvironment(),
    }))
    const parsed = parseIntentModelOutput(result.output, { requirement: run.input.text, workflowId: run.workflow?.workflowId, nodes: run.nodes })
    run.intelligence.modelOutput = normalizePublicText(result.output, 40_000).value
    run.intelligence.intent = parsed.intent
    run.intelligence.plan = parsed.plan
    run.intelligence.currentStage = 'route'
    await writeArtifact(run, { id: 'intent-intake', kind: '编排', outputType: 'intent-spec', state: 'success', attempts: [] }, reportPayload('用户意图已结构化', JSON.stringify(parsed.intent, null, 2)))
    await writeArtifact(run, { id: 'execution-planner', kind: '编排', outputType: 'execution-plan', state: 'success', attempts: [] }, reportPayload(`已规划 ${parsed.plan.steps.length} 个执行步骤`, JSON.stringify(parsed.plan, null, 2)))

    const routing = await runStateGraph<{ reviewReason?: string; status: 'running' | 'awaiting_approval' | 'completed' }>(
      { reviewReason: orchestrationReviewReason(parsed.intent, run.workflow?.workflowId), status: 'running' },
      [{ id: 'route', run: async state => ({ ...state, status: state.reviewReason ? 'awaiting_approval' as const : 'completed' as const }) }],
    )
    run.intelligence.reviewReason = routing.reviewReason
    if (routing.status === 'awaiting_approval') {
      run.intelligence.status = 'awaiting_approval'
      run.status = 'awaiting_approval'
      addInteraction(run, { source: 'intent', kind: 'review', title: '确认用户意图与执行计划', question: routing.reviewReason ?? '请确认识别出的用户意图和执行计划。', options: [{ id: 'approve', label: '确认并继续' }, { id: 'reject', label: '取消本次运行' }], required: true })
      appendLog(run, `智能编排 · 等待人工确认：${routing.reviewReason}`)
      await saveRun(run)
      return false
    }
    run.intelligence.status = 'completed'
    run.intelligence.currentStage = 'complete'
    run.intelligence.completedAt = new Date().toISOString()
    appendLog(run, `智能编排 · 已识别为 ${parsed.intent.taskType}，开始执行工作流`)
    await saveRun(run)
    return true
  } catch (error) {
    const failure = normalizePublicText(errorMessage(error), publicTraceContentLimit).value ?? 'Intent orchestration failed.'
    run.intelligence.status = 'failed'
    run.status = 'failed'; run.endedAt = new Date().toISOString()
    run.lastFailure = { nodeId: 'intent-orchestration', attemptId: `intent-${run.id}`, category: classifyFailure(failure), message: failure }
    appendLog(run, `智能编排失败：${failure}`)
    await saveRun(run)
    return false
  }
}

async function writeArtifact(run: RunSnapshot, node: RunNode, payload: Record<string, unknown> & { summary: string; content: string }, options: { status?: RunArtifact['status']; attemptId?: string } = {}): Promise<RunArtifact> {
  const type = node.outputType ?? `${node.kind.toLowerCase()}-report`; const schema = schemaFor(type); const validationErrors = validatePayload(schema, payload); const version = run.artifacts.filter(item => item.type === type).length + 1; const artifactId = `${node.id}-${randomUUID()}`; const relativePath = join('artifacts', node.id, `v${version}`, 'payload.json'); const serialized = JSON.stringify(payload, null, 2)
  const parentIds = run.edges.filter(edge => edge.to === node.id).map(edge => edge.from)
  const inputArtifactIds = node.kind === '输入'
    ? run.artifacts.filter(item => item.type === 'run-input' && item.status === 'valid').slice(-1).map(item => item.id)
    : latestValidArtifacts(run, parentIds).map(artifact => artifact.id)
  const artifact: RunArtifact = { id: artifactId, nodeId: node.id, ...(options.attemptId ? { attemptId: options.attemptId } : {}), type, version, schemaId: schema.$id, schemaVersion: schema.version, status: validationErrors.length ? 'invalid' : options.status ?? 'valid', path: relativePath, contentHash: hash(serialized), inputArtifactIds, validationErrors, createdAt: new Date().toISOString() }
  const payloadPath = join(runDirectory(run.id), relativePath); await atomicWrite(payloadPath, serialized); await atomicWrite(join(dirname(payloadPath), 'payload.md'), payload.content); await atomicWrite(join(dirname(payloadPath), 'manifest.json'), JSON.stringify(artifact, null, 2)); run.artifacts.push(artifact); appendEvent(run, 'artifact', `${node.id} · 已创建 ${type} v${version}`, node.id, options.attemptId, { artifactId, type, version }); return artifact
}

async function saveArtifactManifest(run: RunSnapshot, artifact: RunArtifact): Promise<void> { await atomicWrite(join(dirname(join(runDirectory(run.id), artifact.path)), 'manifest.json'), JSON.stringify(artifact, null, 2)) }
function normalizeRun(run: RunSnapshot): RunSnapshot {
  run.project.environment.commandAllowlist ??= {}
  run.autoRepairCount ??= 0
  run.interactions = Array.isArray(run.interactions) ? run.interactions.filter(item => item && typeof item.id === 'string').map(item => ({ ...item, required: item.required !== false, status: item.status ?? 'pending', source: item.source ?? 'operator', kind: item.kind ?? 'text', title: item.title ?? '需要用户响应', question: item.question ?? '' })) : []
  run.input = normalizeRunInput(run.input)
  run.events ??= []
  if (run.deliveryApproval) {
    const legacyFiles = run.deliveryApproval.changedFiles ?? []
    run.deliveryApproval.changes ??= legacyFiles.map(path => ({
      operation: 'modify' as const,
      path,
      classification: classifyDeliveryPath(path),
      baseHash: null,
      worktreeHash: null,
      projectHash: null,
      conflicts: [],
    }))
    run.deliveryApproval.changedFiles = run.deliveryApproval.changes.map(change => change.path)
  }
  run.nodes = (run.nodes ?? []).map(node => ({
    ...node,
    attempts: (node.attempts ?? []).map(attempt => {
      const trace = (attempt.trace ?? []).map(event => ({ ...event, schemaVersion: 1 as const, executorId: event.executorId || attempt.executorId }))
      const promptSnapshot = attempt.promptSnapshot ? { ...attempt.promptSnapshot, schemaVersion: 1 as const } : undefined
      return {
        ...attempt,
        trace,
        ...(promptSnapshot ? { promptSnapshot } : {}),
        traceOmittedCount: attempt.traceOmittedCount ?? Math.max(0, (trace.at(-1)?.seq ?? trace.length) - trace.length),
      }
    }),
    steeringArtifactIds: node.steeringArtifactIds ?? [],
  }))
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

async function discoverWorktreeValidationCommands(run: RunSnapshot): Promise<void> {
  if (!run.worktreePath) return
  const environment = await detectProjectEnvironment(run.worktreePath)
  const fingerprint = await validationEnvironmentFingerprint(run.worktreePath, environment)
  if (validationCommands(run).length && run.validationEnvironmentFingerprint === fingerprint) return
  const discovered = environment.commands
  const commandsChanged = JSON.stringify(run.project.environment.commands) !== JSON.stringify(discovered)
  run.project.environment = {
    ...run.project.environment,
    detectedStack: environment.detectedStack,
    workspaceRoots: environment.workspaceRoots,
    commands: discovered,
  }
  run.validationEnvironmentFingerprint = fingerprint
  if (commandsChanged) appendEvent(run, 'command', 'Worktree 环境已变化，已重新识别验证命令并等待本次运行确认', undefined, undefined, { commandCount: validationCommands(run).length })
  else if (!validationCommands(run).length) appendEvent(run, 'command', '未识别到可执行验证命令，将记录未覆盖验证结果', undefined, undefined)
  await saveRun(run)
}

async function validationEnvironmentFingerprint(worktreePath: string, environment: Awaited<ReturnType<typeof detectProjectEnvironment>>): Promise<string> {
  const rootEntries = await readdir(worktreePath, { withFileTypes: true }).catch(() => [])
  const files = new Set([
    'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', '.npmrc',
    'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs', 'vite.config.cjs',
    'next.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.mts',
    'pyproject.toml', 'poetry.lock', 'uv.lock', 'requirements.txt', 'go.mod', 'go.sum',
    'Cargo.toml', 'Cargo.lock', 'clippy.toml', 'rustfmt.toml',
  ])
  for (const entry of rootEntries) if (/^tsconfig(?:\.[^/]+)?\.json$/i.test(entry.name) || /^requirements(?:[-._][^/]+)?\.txt$/i.test(entry.name)) files.add(entry.name)
  const inputs = (await Promise.all([...files].sort().map(async path => {
    try { return { path, contentHash: hash(await readFile(join(worktreePath, path), 'utf8')) } } catch { return null }
  }))).filter((input): input is { path: string; contentHash: string } => input !== null)
  return hash(JSON.stringify({
    worktreePath,
    detectedStack: environment.detectedStack,
    workspaceRoots: environment.workspaceRoots,
    commands: environment.commands,
    inputs,
  }))
}

async function buildDeliveryApproval(run: RunSnapshot, requestedAt = new Date().toISOString()): Promise<DeliveryApproval> {
  if (!run.worktreePath) throw new Error('Worktree is not prepared')
  const changes = await worktreeDeliveryChanges(run)
  return {
    requestedAt,
    changedFiles: changes.map(change => change.path),
    changes,
    worktreePath: run.worktreePath,
    projectPath: run.project.repositoryPath,
  }
}

async function worktreeDeliveryChanges(run: RunSnapshot): Promise<DeliveryChange[]> {
  if (!run.worktreePath) return []
  const [tracked, untracked] = await Promise.all([
    runProcess('git', ['diff', '--name-status', '-z', '--find-renames', 'HEAD'], run.worktreePath, 15_000),
    runProcess('git', ['ls-files', '--others', '--exclude-standard', '-z'], run.worktreePath, 15_000),
  ])
  const records = parseGitNameStatus(tracked).filter(record => !isGeneratedDeliveryPath(record.path))
  const trackedPaths = new Set(records.flatMap(record => [record.path, ...(record.previousPath ? [record.previousPath] : [])]))
  for (const path of untracked.split('\0').filter(Boolean)) {
    if (!trackedPaths.has(path) && !isGeneratedDeliveryPath(path)) records.push({ operation: 'add', path })
  }
  return Promise.all((await inferUntrackedRenames(run, records)).map(record => buildDeliveryChange(run, record)))
}

async function inferUntrackedRenames(run: RunSnapshot, records: Array<Pick<DeliveryChange, 'operation' | 'path' | 'previousPath'>>): Promise<Array<Pick<DeliveryChange, 'operation' | 'path' | 'previousPath'>>> {
  if (!run.worktreePath) return records
  const additions = records.filter(record => record.operation === 'add')
  for (const deletion of records.filter(record => record.operation === 'delete')) {
    const baseHash = await gitObjectHash(run.project.gitRoot, run.baseGitRef ?? 'HEAD', deletion.path)
    if (!baseHash) continue
    const matchingAddition = await findAsync(additions, async addition => (await fileGitHash(run.worktreePath!, addition.path)) === baseHash)
    if (!matchingAddition) continue
    const deletionIndex = records.indexOf(deletion)
    if (deletionIndex >= 0) records[deletionIndex] = { operation: 'rename', path: matchingAddition.path, previousPath: deletion.path }
    additions.splice(additions.indexOf(matchingAddition), 1)
    records.splice(records.indexOf(matchingAddition), 1)
  }
  return records
}

async function findAsync<T>(items: T[], predicate: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (const item of items) if (await predicate(item)) return item
  return undefined
}

function parseGitNameStatus(value: string): Array<Pick<DeliveryChange, 'operation' | 'path' | 'previousPath'>> {
  const fields = value.split('\0')
  const records: Array<Pick<DeliveryChange, 'operation' | 'path' | 'previousPath'>> = []
  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++]
    if (!status) continue
    const kind = status[0]
    if (kind === 'R' || kind === 'C') {
      const previousPath = fields[index++]
      const path = fields[index++]
      if (path && previousPath) records.push({ operation: kind === 'R' ? 'rename' : 'add', path, ...(kind === 'R' ? { previousPath } : {}) })
      continue
    }
    const path = fields[index++]
    if (!path) continue
    records.push({ operation: kind === 'D' ? 'delete' : kind === 'A' ? 'add' : 'modify', path })
  }
  return records
}

async function buildDeliveryChange(run: RunSnapshot, record: Pick<DeliveryChange, 'operation' | 'path' | 'previousPath'>): Promise<DeliveryChange> {
  if (!run.worktreePath) throw new Error('Worktree is not prepared')
  assertDeliveryPath(run.worktreePath, record.path)
  if (record.previousPath) assertDeliveryPath(run.worktreePath, record.previousPath)
  const baseHash = record.operation === 'add' || record.operation === 'rename' ? null : await gitObjectHash(run.project.gitRoot, run.baseGitRef ?? 'HEAD', record.path)
  const worktreeHash = record.operation === 'delete' ? null : await fileGitHash(run.worktreePath, record.path)
  const projectHash = await fileGitHash(run.project.repositoryPath, record.path)
  const previousBaseHash = record.previousPath ? await gitObjectHash(run.project.gitRoot, run.baseGitRef ?? 'HEAD', record.previousPath) : undefined
  const previousProjectHash = record.previousPath ? await fileGitHash(run.project.repositoryPath, record.previousPath) : undefined
  const conflicts: DeliveryConflict[] = []
  const targetConflict = record.operation === 'delete'
    ? projectHash !== null && baseHash !== projectHash
    : baseHash !== projectHash
  if (targetConflict) conflicts.push({ path: record.path, reason: baseHash === null ? '目标路径在运行后被新建' : '目标文件已在运行后被修改或删除' })
  const renameSourceConflict = Boolean(record.previousPath && previousProjectHash !== null && previousBaseHash !== previousProjectHash)
  if (renameSourceConflict && record.previousPath) conflicts.push({ path: record.previousPath, reason: '重命名源文件已在运行后被修改或删除' })
  return { ...record, classification: classifyDeliveryPath(record.path), baseHash, worktreeHash, projectHash, ...(record.previousPath ? { previousBaseHash, previousProjectHash } : {}), conflicts }
}

function classifyDeliveryPath(path: string): DeliveryClassification {
  const name = path.toLowerCase()
  if (isGeneratedDeliveryPath(path)) return 'generated'
  if (/(^|\/)(test|tests|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[^/]+$/.test(name)) return 'test'
  if (/(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|vite\.config\.[^/]+|next\.config\.[^/]+|\.github\/)/.test(name)) return 'config'
  if (/\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|otf|mp3|mp4|mov)$/i.test(path)) return 'binary'
  if (/\.(ts|tsx|js|jsx|mjs|cjs|css|scss|sass|less|html|vue|svelte|py|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp)$/i.test(path)) return 'source'
  return 'other'
}

function isGeneratedDeliveryPath(path: string): boolean {
  return /(^|\/)(node_modules|dist|build|coverage|\.next|\.nuxt|\.vite|\.cache)(\/|$)|\.tsbuildinfo$/i.test(path)
}

function assertDeliveryPath(root: string, path: string): string {
  if (!path || path.includes('\0')) throw new Error('Invalid empty delivery path')
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(resolvedRoot, path)
  const relativePath = relative(resolvedRoot, resolvedPath)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error(`Invalid delivery path: ${path}`)
  return resolvedPath
}

async function fileGitHash(root: string, path: string): Promise<string | null> {
  const absolutePath = assertDeliveryPath(root, path)
  try { await lstat(absolutePath) } catch { return null }
  return (await runProcess('git', ['hash-object', '--', path], root, 15_000)).trim() || null
}

async function gitObjectHash(root: string, revision: string, path: string): Promise<string | null> {
  try { return (await runProcess('git', ['rev-parse', '--verify', `${revision}:${path}`], root, 15_000)).trim() || null } catch { return null }
}

async function applyDelivery(run: RunSnapshot): Promise<void> {
  const delivery = run.deliveryApproval
  if (!delivery) return
  if (delivery.changes.some(change => change.conflicts.length)) throw new Error('Delivery has unresolved conflicts')
  const sourceRoot = resolve(delivery.worktreePath)
  const targetRoot = resolve(delivery.projectPath)
  const transactionId = randomUUID()
  const stagingRoot = join(runDirectory(run.id), 'delivery-staging', transactionId)
  const backupRoot = join(runDirectory(run.id), 'delivery-backups', transactionId)
  const targetPaths = [...new Set(delivery.changes.flatMap(change => [change.path, ...(change.previousPath ? [change.previousPath] : [])]))]
  const backups: Array<{ path: string; existed: boolean }> = []
  try {
    for (const change of delivery.changes.filter(change => change.operation !== 'delete')) {
      const source = assertDeliveryPath(sourceRoot, change.path)
      const staged = assertDeliveryPath(stagingRoot, change.path)
      await mkdir(dirname(staged), { recursive: true })
      await cp(source, staged, { recursive: true, force: true })
    }
    for (const path of targetPaths) {
      const target = assertDeliveryPath(targetRoot, path)
      let existed = true
      try { await lstat(target) } catch { existed = false }
      backups.push({ path, existed })
      if (existed) {
        const backup = assertDeliveryPath(backupRoot, path)
        await mkdir(dirname(backup), { recursive: true })
        await cp(target, backup, { recursive: true, force: true })
      }
    }
    for (const change of delivery.changes) {
      const target = assertDeliveryPath(targetRoot, change.path)
      if (change.operation === 'delete') {
        await rm(target, { recursive: true, force: true })
        continue
      }
      const staged = assertDeliveryPath(stagingRoot, change.path)
      await mkdir(dirname(target), { recursive: true })
      await cp(staged, target, { recursive: true, force: true })
      if (change.operation === 'rename' && change.previousPath) await rm(assertDeliveryPath(targetRoot, change.previousPath), { recursive: true, force: true })
    }
  } catch (error) {
    for (const backup of backups.reverse()) {
      const target = assertDeliveryPath(targetRoot, backup.path)
      await rm(target, { recursive: true, force: true })
      if (backup.existed) {
        const source = assertDeliveryPath(backupRoot, backup.path)
        await mkdir(dirname(target), { recursive: true })
        await cp(source, target, { recursive: true, force: true })
      }
    }
    throw error
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

function sameCommand(left: CommandSpec, right: CommandSpec): boolean {
  return left.command === right.command && left.cwd === right.cwd && left.timeoutMs === right.timeoutMs
}
function legacyNodeWriteMode(node: Pick<RunNode, 'id' | 'outputType'>): boolean {
  return node.id.toLowerCase().includes('implementation') || ['code-change', 'implementation-report'].includes(node.outputType ?? '')
}
function nodeCanWrite(node: Pick<RunNode, 'id' | 'outputType' | 'executionMode'>): boolean {
  return node.executionMode === 'workspace_write' || (node.executionMode === undefined && legacyNodeWriteMode(node))
}
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
function classifyFailure(message: string): RunFailureCategory {
  if (/timed out|timeout|etimedout/i.test(message)) return 'timeout'
  if (/TS\d{4}|cannot find module|module or type declarations|syntaxerror|type error|vite\s+build|compilation failed|build failed/i.test(message)) return 'compilation'
  if (/assertionerror|expected .* to |tests? failed|failing tests?|jest|vitest|mocha/i.test(message)) return 'test_assertion'
  if (/npm (ci|install)|pnpm install|yarn install|cannot find package|missing dependency|lockfile/i.test(message)) return 'dependency'
  if (/permission denied|eacces|enoent|not found|requires login|authentication|environment variable|unsupported engine|node version/i.test(message)) return 'environment'
  if (/no detected validation commands|invalid timeout|unsafe working directory|command .* is required/i.test(message)) return 'command_configuration'
  if (/executor|codex|claude|process lost/i.test(message)) return 'executor'
  return 'unknown'
}
function firstUnapprovedValidationCommand(run: RunSnapshot): { key: ProjectCommandKey; command: CommandSpec } | null {
  return validationCommands(run).find(({ key, command }) => !isProjectCommandApproved(run.project, key, command)) ?? null
}
function parentsSucceeded(run: RunSnapshot, nodeId: string): boolean { return run.edges.filter(edge => edge.to === nodeId).every(edge => run.nodes.find(node => node.id === edge.from)?.state === 'success') }
function latestValidArtifacts(run: RunSnapshot, nodeIds: string[]): RunArtifact[] { return nodeIds.flatMap(nodeId => { const matches = run.artifacts.filter(artifact => artifact.nodeId === nodeId && artifact.status === 'valid'); return matches.length ? [matches.at(-1)!] : [] }) }
function collectDownstream(run: RunSnapshot, sourceId: string): Set<string> { const result = new Set<string>(); const queue = [sourceId]; while (queue.length) { const current = queue.shift()!; for (const edge of run.edges.filter(item => item.from === current)) if (!result.has(edge.to)) { result.add(edge.to); queue.push(edge.to) } } return result }
function collectAncestors(run: RunSnapshot, sourceId: string): Set<string> { const result = new Set<string>(); const queue = [sourceId]; while (queue.length) { const current = queue.shift()!; for (const edge of run.edges.filter(item => item.to === current)) if (!result.has(edge.from)) { result.add(edge.from); queue.push(edge.from) } } return result }
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
async function saveRun(run: RunSnapshot): Promise<void> {
  await atomicWrite(manifestPath(run.id), JSON.stringify(run, null, 2))
  notifyRunChanged(run.id)
}
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

function setAttemptFinalResponse(attempt: StepAttempt, finalResponse: string): void {
  const normalized = normalizePublicText(finalResponse, publicFinalResponseLimit)
  attempt.finalResponse = normalized.value
  if (normalized.redacted || /\[REDACTED(?: [A-Z ]+)?\]/.test(normalized.value ?? '')) attempt.finalResponseRedacted = true
  if (normalized.truncated) attempt.finalResponseTruncated = true
}

// Process metadata arrives from an asynchronous child-process callback. Reload the
// manifest here so it cannot overwrite trace events saved while the process starts.
async function persistAttemptProcess(runId: string, nodeId: string, attemptId: string, process: NonNullable<StepAttempt['process']>): Promise<void> {
  const run = await getRun(runId)
  const node = run?.nodes.find(item => item.id === nodeId)
  const attempt = node?.attempts.find(item => item.id === attemptId)
  if (!run || !node || !attempt) return
  attempt.process = process
  await saveRun(run)
}

async function persistAgentTrace(runId: string, nodeId: string, attemptId: string, draft: AgentTraceDraft): Promise<void> {
  const run = await getRun(runId)
  const node = run?.nodes.find(item => item.id === nodeId)
  const attempt = node?.attempts.find(item => item.id === attemptId)
  if (!run || !node || !attempt || run.status !== 'running' || node.state !== 'running' || attempt.status !== 'running') return
  const event = await appendAgentTrace(run, node, attempt, draft)
  // Mirror tool activity into the run log so the global log panel stays alive while an agent works.
  if (event.kind === 'tool_started' || event.kind === 'tool_completed') appendLog(run, toolTraceLogLabel(node.id, event))
  await saveRun(run)
}

function toolTraceLogLabel(nodeId: string, event: AgentTraceEvent): string {
  const action = event.kind === 'tool_started' ? '调用工具' : '工具完成'
  const detail = event.command ?? event.content
  return `${nodeId} · ${action} ${event.toolName ?? 'tool'}${detail ? `：${detail.slice(0, 160)}` : ''}`
}

async function persistLegacyAgentActivity(runId: string, nodeId: string, attemptId: string, activity: AgentActivity): Promise<void> {
  const run = await getRun(runId)
  const node = run?.nodes.find(item => item.id === nodeId)
  const attempt = node?.attempts.find(item => item.id === attemptId)
  if (!run || !node || !attempt || run.status !== 'running' || node.state !== 'running' || attempt.status !== 'running') return
  const publicMessage = redactPublicText(activity.message).value
  const publicDetails = redactEventDetails(activity.details)
  appendEvent(run, activity.type, `${node.id} · ${publicMessage}`, node.id, attempt.id, publicDetails)
  const content = typeof publicDetails?.text === 'string' ? publicDetails.text : activity.type === 'command' ? undefined : publicMessage
  const command = typeof publicDetails?.command === 'string' ? publicDetails.command : undefined
  const exitCode = typeof activity.details?.exitCode === 'number' ? activity.details.exitCode : undefined
  const kind: AgentTraceEvent['kind'] = activity.type === 'command'
    ? activity.message.includes('开始') ? 'tool_started' : 'tool_completed'
    : activity.type === 'activity' ? 'agent_message' : 'status'
  await appendAgentTrace(run, node, attempt, { kind, ...(content ? { content } : {}), ...(command ? { command } : {}), ...(exitCode === undefined ? {} : { exitCode }) })
  await saveRun(run)
}

async function appendAgentTrace(run: RunSnapshot, node: RunNode, attempt: StepAttempt, draft: AgentTraceDraft): Promise<AgentTraceEvent> {
  const normalized = normalizeTraceDraft(draft)
  const event: AgentTraceEvent = {
    schemaVersion: publicTraceSchemaVersion,
    seq: (attempt.trace?.at(-1)?.seq ?? 0) + 1,
    occurredAt: new Date().toISOString(),
    executorId: attempt.executorId,
    nodeId: node.id,
    attemptId: attempt.id,
    ...normalized,
  }
  const directory = attemptDirectory(run.id, attempt.id)
  await mkdir(directory, { recursive: true })
  await appendFile(join(directory, 'trace.jsonl'), `${JSON.stringify(event)}\n`, 'utf8')
  attempt.trace = [...(attempt.trace ?? []), event].slice(-publicTraceLimit)
  attempt.traceOmittedCount = Math.max(0, event.seq - attempt.trace.length)
  return event
}

function normalizeTraceDraft(draft: AgentTraceDraft): AgentTraceDraft {
  const sourceEventId = normalizePublicText(draft.sourceEventId, 200)
  const toolName = normalizePublicText(draft.toolName, 200)
  const content = normalizePublicText(draft.content, publicTraceContentLimit)
  const command = normalizePublicText(draft.command, publicTraceCommandLimit)
  const status = normalizePublicText(draft.status, 200)
  return {
    kind: draft.kind,
    ...(sourceEventId.value === undefined ? {} : { sourceEventId: sourceEventId.value }),
    ...(toolName.value === undefined ? {} : { toolName: toolName.value }),
    ...(content.value === undefined ? {} : { content: content.value }),
    ...(command.value === undefined ? {} : { command: command.value }),
    ...(status.value === undefined ? {} : { status: status.value }),
    ...(typeof draft.exitCode === 'number' && Number.isFinite(draft.exitCode) ? { exitCode: draft.exitCode } : {}),
    ...(typeof draft.durationMs === 'number' && Number.isFinite(draft.durationMs) ? { durationMs: Math.max(0, Math.round(draft.durationMs)) } : {}),
    ...((draft.truncated || sourceEventId.truncated || toolName.truncated || content.truncated || command.truncated || status.truncated) ? { truncated: true } : {}),
    ...((draft.redacted || sourceEventId.redacted || toolName.redacted || content.redacted || command.redacted || status.redacted) ? { redacted: true } : {}),
  }
}

function normalizePublicText(value: string | undefined, limit: number): { value?: string; truncated: boolean; redacted: boolean } {
  if (typeof value !== 'string') return { truncated: false, redacted: false }
  const publicValue = redactPublicText(value)
  return publicValue.value.length > limit
    ? { value: publicValue.value.slice(0, limit), truncated: true, redacted: publicValue.redacted }
    : { value: publicValue.value, truncated: false, redacted: publicValue.redacted }
}

function redactPublicText(value: string): { value: string; redacted: boolean } {
  const sentinels = ['[REDACTED]', '[REDACTED JWT]', '[REDACTED PRIVATE KEY]']
  const protectedMarkers = sentinels.map((sentinel, index) => `__ARTIFACT_REDACTED_${index}__`)
  let redacted = value
  for (let index = 0; index < sentinels.length; index += 1) redacted = redacted.split(sentinels[index]).join(protectedMarkers[index])
  const replacements: Array<[RegExp, string]> = [
    [/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|secret)\b["']?\s*[=:]\s*["']?)([^\s,"'\]\[}]+)/gi, '$1[REDACTED]'],
    [/(\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|NPM_TOKEN)\b["']?\s*[=:]\s*["']?)([^\s,"'\]\[}]+)/g, '$1[REDACTED]'],
    [/(\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b["']?\s*[=:]\s*["']?)([^\s,"'\]\[}]+)/g, '$1[REDACTED]'],
    [/(\bAuthorization\s*:\s*Bearer\s+)[^\s,"']+/gi, '$1[REDACTED]'],
    [/(\bAuthorization\s*:\s*Basic\s+)[^\s,"']+/gi, '$1[REDACTED]'],
    [/([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]'],
    [/\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  ]
  for (const [pattern, replacement] of replacements) redacted = redacted.replace(pattern, replacement)
  for (let index = 0; index < sentinels.length; index += 1) redacted = redacted.split(protectedMarkers[index]).join(sentinels[index])
  return { value: redacted, redacted: redacted !== value }
}

function redactEventDetails(details: AgentActivity['details']): AgentActivity['details'] {
  if (!details) return undefined
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === 'string' ? redactPublicText(value).value : value]))
}

type CodexJsonItem = { id?: unknown; type?: unknown; text?: unknown; command?: unknown; exit_code?: unknown; status?: unknown; summary?: unknown; summary_text?: unknown; changes?: unknown; server?: unknown; tool?: unknown; name?: unknown; input?: unknown; arguments?: unknown; question?: unknown; title?: unknown; options?: unknown }
type CodexJsonEvent = { type?: unknown; item?: CodexJsonItem; error?: unknown; message?: unknown }

// Adapter boundary: Codex-native JSON is normalized before it reaches persisted public trace data.
async function runCodex(input: Parameters<AgentRunner>[0]): Promise<AgentRunnerResult> {
  const finalMessagePath = join(input.attemptDirectory, 'last-message.txt')
  await mkdir(input.attemptDirectory, { recursive: true })
  const args = [
    'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', input.writable ? 'workspace-write' : 'read-only',
    '--json', '--color', 'never', '--output-last-message', finalMessagePath,
    '-c', 'shell_environment_policy.inherit=core',
    '-c', 'shell_environment_policy.exclude=["OPENAI_API_KEY","CODEX_API_KEY","CODEX_ACCESS_TOKEN","ANTHROPIC_API_KEY","ARTIFACT_SESSION_TOKEN"]',
  ]
  if (input.executor.model.trim()) args.push('--model', input.executor.model.trim())
  args.push('-')
  const messages: string[] = []
  const startedTools = new Map<string, number>()
  let parseErrorCount = 0
  let interactionRequested = false
  const heartbeat = startSilenceHeartbeat(idleMs => input.onPublicTrace?.({ kind: 'status', content: `Codex 仍在运行，约 ${Math.max(1, Math.round(idleMs / 60_000))} 分钟没有新事件。` }) ?? Promise.resolve())
  try {
    await runProcess(input.executor.path, args, input.cwd, 1_800_000, input.attemptId, {
      stdin: input.prompt,
      env: input.environment,
      maxLineLength: 1_000_000,
      onSpawn: input.onProcessStarted,
      onStdoutLine: async line => {
        heartbeat.touch()
        let event: CodexJsonEvent
        try { event = JSON.parse(line) as CodexJsonEvent } catch { parseErrorCount += 1; return }
        const eventType = typeof event.type === 'string' ? event.type : ''
        const item = event.item
        const itemType = typeof item?.type === 'string' ? item.type : ''
        const sourceEventId = typeof item?.id === 'string' ? item.id : undefined
        if (eventType === 'turn.failed') {
          const failure = codexErrorMessage(event)
          if (failure) await input.onPublicTrace?.({ kind: 'error', content: failure })
          return
        }
        if (eventType === 'item.completed' && itemType === 'agent_message' && typeof item?.text === 'string' && item.text.trim()) {
          const message = item.text.trim()
          messages.push(message)
          await input.onPublicTrace?.({ kind: 'agent_message', ...(sourceEventId ? { sourceEventId } : {}), content: message })
          return
        }
        if (!interactionRequested && item && isHumanInputTool(itemType, item) && input.onInteraction) {
          const interaction = parseAgentInteraction(item)
          if (interaction) {
            interactionRequested = true
            await input.onInteraction(interaction)
            return
          }
        }
        const summary = publicReasoningSummary(event)
        if (summary) {
          await input.onPublicTrace?.({ kind: 'reasoning_summary', ...(sourceEventId ? { sourceEventId } : {}), content: summary })
          return
        }
        const toolName = codexToolName(itemType, item)
        if (!toolName) return
        const command = itemType === 'command_execution' && typeof item?.command === 'string' ? item.command : undefined
        const status = typeof item?.status === 'string' ? item.status : undefined
        const fileChangePaths = itemType === 'file_change' && Array.isArray(item?.changes)
          ? item.changes.flatMap(change => change && typeof change === 'object' && typeof (change as { path?: unknown }).path === 'string' ? [(change as { path: string }).path] : []).slice(0, 30)
          : undefined
        if (eventType === 'item.started') {
          if (sourceEventId) startedTools.set(sourceEventId, Date.now())
          await input.onPublicTrace?.({ kind: 'tool_started', ...(sourceEventId ? { sourceEventId } : {}), toolName, ...(command ? { command } : {}), ...(status ? { status } : {}) })
        } else if (eventType === 'item.completed') {
          const startedAt = sourceEventId ? startedTools.get(sourceEventId) : undefined
          if (sourceEventId) startedTools.delete(sourceEventId)
          await input.onPublicTrace?.({
            kind: 'tool_completed',
            ...(sourceEventId ? { sourceEventId } : {}),
            toolName,
            ...(command ? { command } : {}),
            ...(fileChangePaths?.length ? { content: `变更文件：${fileChangePaths.join('、')}` } : {}),
            ...(status ? { status } : {}),
            ...(typeof item?.exit_code === 'number' ? { exitCode: item.exit_code } : {}),
            ...(startedAt === undefined ? {} : { durationMs: Date.now() - startedAt }),
          })
        }
      },
    })
  } finally {
    heartbeat.stop()
    if (parseErrorCount) await input.onPublicTrace?.({ kind: 'error', content: `Ignored ${parseErrorCount} malformed executor event${parseErrorCount === 1 ? '' : 's'}.` })
  }
  let finalMessage = ''
  try { finalMessage = (await readFile(finalMessagePath, 'utf8')).trim() } catch { /* fall back to the normalized event stream */ }
  return { output: finalMessage || messages.at(-1) || 'Codex completed without a textual report.' }
}

function publicReasoningSummary(event: CodexJsonEvent): string | undefined {
  const eventType = typeof event.type === 'string' ? event.type : ''
  const item = event.item
  const itemType = typeof item?.type === 'string' ? item.type : ''
  if (eventType !== 'item.completed' && eventType !== 'reasoning_summary') return undefined
  if (itemType === 'reasoning_summary' || itemType === 'reasoning_summary_text') {
    const value = typeof item?.summary_text === 'string' ? item.summary_text : typeof item?.text === 'string' ? item.text : undefined
    return value?.trim() || undefined
  }
  if (itemType !== 'reasoning') return undefined
  if (typeof item?.summary_text === 'string' && item.summary_text.trim()) return item.summary_text.trim()
  if (typeof item?.summary === 'string' && item.summary.trim()) return item.summary.trim()
  if (!Array.isArray(item?.summary)) return undefined
  const parts = item.summary.flatMap(part => {
    if (!part || typeof part !== 'object') return []
    const value = part as { type?: unknown; text?: unknown }
    return value.type === 'summary_text' && typeof value.text === 'string' && value.text.trim() ? [value.text.trim()] : []
  })
  return parts.length ? parts.join('\n\n') : undefined
}

function codexToolName(itemType: string, item: CodexJsonItem | undefined): string | undefined {
  if (itemType === 'command_execution') return 'shell'
  if (itemType === 'file_change') return 'file_change'
  if (itemType === 'web_search') return 'web_search'
  if (itemType === 'mcp_tool_call') {
    const server = typeof item?.server === 'string' ? item.server : 'mcp'
    const tool = typeof item?.tool === 'string' ? item.tool : typeof item?.name === 'string' ? item.name : 'tool'
    return `${server}/${tool}`
  }
  return undefined
}

function codexErrorMessage(event: CodexJsonEvent): string | undefined {
  if (typeof event.message === 'string' && event.message.trim()) return event.message.trim()
  if (typeof event.error === 'string' && event.error.trim()) return event.error.trim()
  if (event.error && typeof event.error === 'object' && 'message' in event.error && typeof event.error.message === 'string') return event.error.message.trim() || undefined
  return undefined
}

// Claude Code streams JSONL while it works; parse each line so the run workspace can
// show thinking, tool calls, and results as they happen instead of after the process exits.
type ClaudeContentBlock = { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown }
type ClaudeStreamEvent = { type?: unknown; subtype?: unknown; message?: { role?: unknown; content?: unknown }; result?: unknown; is_error?: unknown; error?: unknown; model?: unknown }

async function runClaude(input: Parameters<AgentRunner>[0]): Promise<AgentRunnerResult> {
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', input.writable ? 'acceptEdits' : 'plan']
  if (input.executor.model.trim()) args.push('--model', input.executor.model.trim())
  const startedTools = new Map<string, { name: string; startedAt: number }>()
  const heartbeat = startSilenceHeartbeat(idleMs => input.onPublicTrace?.({ kind: 'status', content: `Claude Code 仍在运行，约 ${Math.max(1, Math.round(idleMs / 60_000))} 分钟没有新事件。` }) ?? Promise.resolve())
  try {
    const stdout = await runProcess(input.executor.path, args, input.cwd, 1_800_000, input.attemptId, {
      stdin: input.prompt,
      env: input.environment,
      maxLineLength: 1_000_000,
      onSpawn: input.onProcessStarted,
      onStdoutLine: async line => {
        heartbeat.touch()
        let event: ClaudeStreamEvent
        try { event = JSON.parse(line) as ClaudeStreamEvent } catch { return }
        await emitClaudeStreamEvent(event, startedTools, input)
      },
    })
    const output = parseClaudeResult(stdout)
    return { output: output || 'Claude Code completed without a textual report.' }
  } finally {
    heartbeat.stop()
  }
}

async function emitClaudeStreamEvent(event: ClaudeStreamEvent, startedTools: Map<string, { name: string; startedAt: number }>, input: Parameters<AgentRunner>[0]): Promise<void> {
  const eventType = typeof event.type === 'string' ? event.type : ''
  if (eventType === 'system') {
    if (event.subtype === 'init') {
      const model = typeof event.model === 'string' && event.model.trim() ? event.model.trim() : '默认模型'
      await input.onPublicTrace?.({ kind: 'status', content: `Claude Code 会话已建立 · 模型 ${model}` })
    }
    return
  }
  if (eventType === 'assistant' || eventType === 'user') {
    for (const block of claudeContentBlocks(event.message?.content)) {
      await emitClaudeBlock(block, eventType, startedTools, input)
    }
    return
  }
  if (eventType === 'result' && typeof event.subtype === 'string' && event.subtype.startsWith('error')) {
    await input.onPublicTrace?.({ kind: 'error', content: claudeErrorText(event) })
  }
}

function claudeContentBlocks(content: unknown): ClaudeContentBlock[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  return content.filter((block): block is ClaudeContentBlock => Boolean(block) && typeof block === 'object')
}

async function emitClaudeBlock(block: ClaudeContentBlock, role: 'assistant' | 'user', startedTools: Map<string, { name: string; startedAt: number }>, input: Parameters<AgentRunner>[0]): Promise<void> {
  const blockType = typeof block.type === 'string' ? block.type : ''
  if (role === 'assistant') {
    if (blockType === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      await input.onPublicTrace?.({ kind: 'reasoning_summary', content: block.thinking.trim() })
      return
    }
    if (blockType === 'text' && typeof block.text === 'string' && block.text.trim()) {
      await input.onPublicTrace?.({ kind: 'agent_message', content: block.text.trim() })
      return
    }
    if (blockType === 'tool_use') {
      const name = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'tool'
      const toolInput = claudeToolInput(block.input)
      if (isHumanInputTool(name, block) && input.onInteraction) {
        const interaction = parseAgentInteraction({ ...block, name, input: block.input })
        if (interaction) {
          await input.onInteraction(interaction)
          return
        }
      }
      if (typeof block.id === 'string' && block.id) startedTools.set(block.id, { name, startedAt: Date.now() })
      await input.onPublicTrace?.({ kind: 'tool_started', ...(typeof block.id === 'string' && block.id ? { sourceEventId: block.id } : {}), toolName: name, ...(toolInput.command ? { command: toolInput.command } : {}), ...(toolInput.summary ? { content: toolInput.summary } : {}) })
    }
    return
  }
  if (blockType === 'tool_result') {
    const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined
    const started = id ? startedTools.get(id) : undefined
    if (id) startedTools.delete(id)
    const preview = claudeToolResultPreview(block.content)
    await input.onPublicTrace?.({
      kind: 'tool_completed',
      ...(id ? { sourceEventId: id } : {}),
      toolName: started?.name ?? 'tool',
      ...(preview ? { content: preview } : {}),
      status: block.is_error === true ? 'error' : 'success',
      ...(started ? { durationMs: Date.now() - started.startedAt } : {}),
    })
  }
}

function isHumanInputTool(typeOrName: string, payload: Record<string, unknown> | undefined): boolean {
  const value = `${typeOrName} ${typeof payload?.name === 'string' ? payload.name : ''} ${typeof payload?.tool === 'string' ? payload.tool : ''}`.toLowerCase()
  return /ask[_-]?user|human[_-]?input|request[_-]?input|user[_-]?question|approval/.test(value)
}

function parseAgentInteraction(payload: Record<string, unknown>): AgentInteractionDraft | null {
  const input = payload.input && typeof payload.input === 'object' ? payload.input as Record<string, unknown>
    : payload.arguments && typeof payload.arguments === 'object' ? payload.arguments as Record<string, unknown> : payload
  const questionRecord = Array.isArray(input.questions) && input.questions[0] && typeof input.questions[0] === 'object' ? input.questions[0] as Record<string, unknown> : undefined
  const question = firstString(input.question, input.prompt, input.message, input.text, questionRecord?.question, questionRecord?.prompt, payload.question, payload.text)
  if (!question) return null
  const title = firstString(input.title, input.subject, questionRecord?.header, payload.title) ?? 'Agent 需要你的输入'
  const rawOptions = Array.isArray(input.options) ? input.options : questionRecord?.options
  const options = Array.isArray(rawOptions) ? rawOptions.flatMap((option, index) => {
    if (typeof option === 'string' && option.trim()) return [{ id: option.trim(), label: option.trim() }]
    if (!option || typeof option !== 'object') return []
    const record = option as Record<string, unknown>
    const label = firstString(record.label, record.title, record.name, record.value)
    if (!label) return []
    return [{ id: firstString(record.id, record.value) ?? `option-${index + 1}`, label, ...(firstString(record.description) ? { description: firstString(record.description) } : {}) }]
  }) : undefined
  const kind = options?.length ? 'choice' : (input.kind === 'confirm' || input.kind === 'permission' || input.kind === 'review' || input.kind === 'form' ? input.kind : 'text')
  return { kind, title, question, ...(options?.length ? { options } : {}), required: input.required !== false, source: 'agent' }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim()) as string | undefined
}

function claudeToolInput(value: unknown): { command?: string; summary?: string } {
  if (!value || typeof value !== 'object') return {}
  const record = value as Record<string, unknown>
  const command = typeof record.command === 'string' && record.command.trim() ? record.command.trim() : undefined
  const target = typeof record.file_path === 'string' && record.file_path.trim() ? record.file_path.trim()
    : typeof record.path === 'string' && record.path.trim() ? record.path.trim()
    : typeof record.url === 'string' && record.url.trim() ? record.url.trim()
    : typeof record.pattern === 'string' && record.pattern.trim() ? record.pattern.trim()
    : undefined
  return { ...(command ? { command } : {}), ...(target ? { summary: target } : {}) }
}

function claudeToolResultPreview(content: unknown): string | undefined {
  const text = typeof content === 'string' ? content
    : Array.isArray(content)
      ? content.flatMap(item => item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? [(item as { text: string }).text] : []).join(' ')
      : undefined
  const value = redactPublicText((text ?? '').trim().slice(0, 400)).value
  return value || undefined
}

function claudeErrorText(event: ClaudeStreamEvent): string {
  const result = typeof event.result === 'string' ? event.result : undefined
  const error = event.error && typeof event.error === 'object' && typeof (event.error as { message?: unknown }).message === 'string'
    ? (event.error as { message: string }).message
    : typeof event.error === 'string' ? event.error : undefined
  return result || error || `Claude Code 执行出错（${String(event.subtype ?? 'unknown')}）`
}

// Emits a status trace when an executor produces no output for a long stretch, so a
// five-minute npm install does not look like a hung run.
function startSilenceHeartbeat(notify: (idleMs: number) => Promise<void>): { touch: () => void; stop: () => void } {
  let lastTouch = Date.now()
  const timer = setInterval(() => {
    const idleMs = Date.now() - lastTouch
    if (idleMs < 45_000) return
    lastTouch = Date.now()
    void notify(idleMs)
  }, 15_000)
  return { touch: () => { lastTouch = Date.now() }, stop: () => clearInterval(timer) }
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
async function runShellCommand(command: string, cwd: string, timeoutMs: number, attemptId: string, onSpawn?: RunProcessOptions['onSpawn']): Promise<string> { return runProcess('/bin/zsh', ['-lc', command], cwd, timeoutMs, attemptId, { onSpawn }) }
async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, attemptId?: string, options: RunProcessOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: options.env ?? process.env, stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); if (attemptId) activeProcesses.set(attemptId, child)
    const spawnCallback = child.pid && options.onSpawn ? Promise.resolve(options.onSpawn({ pid: child.pid, commandHash: hash(JSON.stringify({ command, args, cwd })), startedAt: new Date().toISOString() })) : Promise.resolve()
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    let stdout = ''; let stderr = ''; let stdoutRemainder = ''; let callbacks = Promise.resolve(); let callbackError: unknown; let remainderQueued = false; const maxOutput = 2_000_000; const maxLineLength = options.maxLineLength ?? maxOutput
    const appendBounded = (current: string, value: string) => current.length >= maxOutput ? current : current + value.slice(0, maxOutput - current.length)
    const queueLine = (line: string) => {
      if (!options.onStdoutLine || !line.trim()) return
      const bounded = line.slice(0, maxLineLength)
      callbacks = callbacks.then(async () => {
        try { await options.onStdoutLine?.(bounded) } catch (error) { callbackError ??= error }
      })
    }
    child.stdout!.on('data', (value: string) => {
      stdout = appendBounded(stdout, value)
      if (!options.onStdoutLine) return
      const lines = `${stdoutRemainder}${value}`.split(/\r?\n/)
      stdoutRemainder = lines.pop() ?? ''
      for (const line of lines) queueLine(line)
      if (stdoutRemainder.length > maxLineLength) { queueLine(stdoutRemainder); stdoutRemainder = '' }
    })
    child.stderr!.on('data', (value: string) => { stderr = appendBounded(stderr, value) })
    let settled = false; let timedOut = false; let forceKillTimer: NodeJS.Timeout | undefined
    const finish = (handler: () => void) => { if (settled) return; settled = true; clearTimeout(timer); if (forceKillTimer) clearTimeout(forceKillTimer); if (attemptId) activeProcesses.delete(attemptId); handler() }
    const drainCallbacks = () => {
      if (!remainderQueued) { remainderQueued = true; queueLine(stdoutRemainder) }
      return callbacks
    }
    const settleAfterCallbacks = (handler: () => void) => { void Promise.all([drainCallbacks(), spawnCallback]).then(() => finish(() => callbackError ? reject(callbackError) : handler()), error => finish(() => reject(error))) }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      forceKillTimer = setTimeout(() => { if (!settled) child.kill('SIGKILL') }, 5_000)
    }, timeoutMs)
    child.on('error', error => settleAfterCallbacks(() => reject(error)))
    child.on('close', (code, signal) => settleAfterCallbacks(() => {
      if (timedOut) return reject(new Error(redactPublicText(`Command timed out after ${timeoutMs}ms: ${command}`).value))
      // Structured stdout may contain private native events. Adapter failures expose stderr only.
      const failureOutput = redactPublicText((stderr || (options.onStdoutLine ? '' : stdout)).trim().slice(-8_000)).value
      return code !== 0 ? reject(new Error(failureOutput || `${command} ${signal ? `terminated by ${signal}` : `exited with code ${code}`}`)) : resolve(stdout.trim() || stderr.trim())
    }))
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined)
      child.stdin.end(options.stdin, 'utf8')
    }
  })
}
