'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AlignHorizontalSpaceAround, Bot, ChevronLeft, ChevronRight, Ellipsis, Focus, FolderCog, History, Package, PanelBottom, PanelLeftClose, PanelLeftOpen, PanelRight, Plus, Scan, Settings, Upload, Workflow, X } from 'lucide-react'
import { ExecutorSettings, SettingsOverview } from './executor-settings'
import { RunWorkspace } from './run-workspace'
import { WorkflowLibraryView, type WorkflowRecordView, type WorkflowTemplateView } from './workflow-library'

type NodeState = 'idle' | 'running' | 'paused' | 'success' | 'waiting' | 'failed' | 'cancelled' | 'skipped'
type WorkflowNode = { id: string; title: string; subtitle: string; kind: string; tone: string; state: NodeState; x: number; y: number; input?: string; output: string; executorId?: string; prompt?: string }
type Edge = { from: string; to: string }
type CommandSpec = { command: string; cwd: string; timeoutMs: number }
type CommandApproval = CommandSpec & { approvedAt: string }
type ProjectSummary = { name: string; repositoryPath: string; gitRoot: string; status: 'detected' | 'ready' | 'invalid'; environment: { version: number; confirmedByUser: boolean; commands: Record<string, CommandSpec | undefined>; commandAllowlist: Record<string, CommandApproval | undefined> } }
type ExecutorOption = { id: string; name: string; connected: boolean; authentication: 'authenticated' | 'api_key' | 'needs_login' | 'unknown' }
type Artifact = { id: string; nodeId: string; type: string; version?: number; schemaId?: string; schemaVersion?: number; status: string; contentHash: string; createdAt: string; inputArtifactIds?: string[]; validationErrors?: string[] }
type Attempt = { id: string; attempt: number; status: string; startedAt?: string; endedAt?: string; exitReason?: string }
type PendingCommandApproval = { nodeId: string; commandKey: string; command: CommandSpec; requestedAt: string }
type Run = { id: string; status: string; startedAt: string; endedAt?: string; worktreePath?: string; branchName?: string; pendingCommandApproval?: PendingCommandApproval; logs: string[]; nodes: Array<{ id: string; state: string; attempts?: Attempt[] }>; artifacts: Artifact[] }
type DragState = { id: string; dx: number; dy: number; startX: number; startY: number; finalX: number; finalY: number; element: HTMLButtonElement }
type CanvasViewport = { x: number; y: number; zoom: number }
type CanvasPanState = { pointerId: number; startX: number; startY: number; originX: number; originY: number }
type LogPanelResizeState = { pointerId: number; startY: number; startHeight: number }
type Readiness = { ready: boolean; step: string; title: string; detail: string; action: string; target: 'project' | 'environment' | 'executors' | null }
type WorkflowMode = 'library' | 'editor'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function editorNodes(value: unknown): WorkflowNode[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const node = asRecord(item)
    if (!node || typeof node.id !== 'string' || !node.id.trim()) return []
    const x = typeof node.x === 'number' && Number.isFinite(node.x) ? node.x : 48 + index * 236
    const y = typeof node.y === 'number' && Number.isFinite(node.y) ? node.y : 154
    return [{
      id: node.id,
      title: typeof node.title === 'string' && node.title.trim() ? node.title : `节点 ${index + 1}`,
      subtitle: typeof node.subtitle === 'string' ? node.subtitle : 'Custom Node',
      kind: typeof node.kind === 'string' ? node.kind : '工具',
      tone: typeof node.tone === 'string' ? node.tone : 'blue',
      state: 'idle',
      x,
      y,
      input: typeof node.input === 'string' ? node.input : undefined,
      output: typeof node.output === 'string' && node.output.trim() ? node.output : 'artifact',
      executorId: typeof node.executorId === 'string' ? node.executorId : undefined,
      prompt: typeof node.prompt === 'string' ? node.prompt : undefined,
    }]
  })
}

function editorEdges(value: unknown, nodeIds: Set<string>): Edge[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const edge = asRecord(item)
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string' || edge.from === edge.to || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) return []
    return [{ from: edge.from, to: edge.to }]
  })
}

const initialNodes: WorkflowNode[] = [
  { id: 'requirement', title: '需求输入', subtitle: 'Requirement', kind: '输入', tone: 'blue', state: 'idle', x: 48, y: 154, output: 'requirement', prompt: '描述需要在目标项目中完成的功能和验收标准。' },
  { id: 'ui-spec', title: 'UI 规格', subtitle: 'UI Spec Agent', kind: 'Agent', tone: 'violet', state: 'idle', x: 284, y: 154, input: 'requirement', output: 'ui-spec', executorId: 'codex', prompt: '分析需求和现有项目，给出可执行的实现规格、风险与验证方法。' },
  { id: 'approval', title: '人工审批', subtitle: 'Human Approval', kind: '审批', tone: 'amber', state: 'idle', x: 520, y: 154, input: 'ui-spec', output: 'approved-spec' },
  { id: 'implementation', title: '实现代码', subtitle: 'Coding Agent', kind: 'Agent', tone: 'violet', state: 'idle', x: 756, y: 154, input: 'approval', output: 'code-change', executorId: 'codex', prompt: '按照已批准的规格在 Worktree 中实现代码，保持改动聚焦并运行相关检查。' },
  { id: 'validation', title: '运行验证', subtitle: 'Confirmed Commands', kind: '验证', tone: 'green', state: 'idle', x: 992, y: 154, input: 'implementation', output: 'test-report' },
  { id: 'review', title: '代码交付', subtitle: 'Git Diff', kind: '交付', tone: 'slate', state: 'idle', x: 1228, y: 154, input: 'validation', output: 'git-diff' },
]
const initialEdges: Edge[] = [{ from: 'requirement', to: 'ui-spec' }, { from: 'ui-spec', to: 'approval' }, { from: 'approval', to: 'implementation' }, { from: 'implementation', to: 'validation' }, { from: 'validation', to: 'review' }]
const navItems = [{ id: 'workflow', label: '工作流', icon: Workflow }, { id: 'runs', label: '运行', icon: History }, { id: 'artifacts', label: 'Artifacts', icon: Package }, { id: 'settings', label: '项目设置', icon: Settings }]
const nodePresets = [{ kind: 'Agent', title: 'Agent 节点', subtitle: 'Custom Agent', tone: 'violet', output: 'agent-report' }, { kind: '验证', title: '验证节点', subtitle: 'Confirmed Commands', tone: 'green', output: 'test-report' }, { kind: '审批', title: '审批节点', subtitle: 'Human Approval', tone: 'amber', output: 'approved-spec' }, { kind: '工具', title: '工具节点', subtitle: 'Local Tool', tone: 'blue', output: 'tool-result' }]
const outputSchemas = ['requirement', 'ui-spec', 'approved-spec', 'agent-report', 'code-change', 'test-report', 'git-diff', 'tool-result']
const defaultSidebarWidth = 218
const minSidebarWidth = 190
const maxSidebarWidth = 360
const flowWidth = 1470
const flowHeight = 480
const flowNodeWidth = 188
const flowNodeHeight = 118
const minCanvasZoom = 0.35
const maxCanvasZoom = 1.4
const defaultInspectorWidth = 286
const minInspectorWidth = 240
const maxInspectorWidth = 480
const defaultLogPanelHeight = 165
const minLogPanelHeight = 132
const maxLogPanelHeight = 420

function isTextEntryTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('input, textarea, select, [contenteditable="true"]')))
}

function edgePath(from: Pick<WorkflowNode, 'x' | 'y'>, to: Pick<WorkflowNode, 'x' | 'y'>) {
  const fromX = from.x + flowNodeWidth
  const fromY = from.y + flowNodeHeight / 2
  const toX = to.x
  const toY = to.y + flowNodeHeight / 2
  return `M ${fromX} ${fromY} C ${fromX + 24} ${fromY}, ${toX - 24} ${toY}, ${toX} ${toY}`
}

function arrangeWorkflowNodes(nodes: WorkflowNode[], edges: Edge[]): WorkflowNode[] {
  if (!nodes.length) return nodes
  const order = new Map(nodes.map((node, index) => [node.id, index]))
  const incoming = new Map(nodes.map(node => [node.id, 0]))
  const outgoing = new Map(nodes.map(node => [node.id, [] as string[]]))
  for (const edge of edges) {
    if (!incoming.has(edge.to) || !outgoing.has(edge.from)) continue
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)?.push(edge.to)
  }

  const queue = nodes.filter(node => (incoming.get(node.id) ?? 0) === 0).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).map(node => node.id)
  const depth = new Map(nodes.map(node => [node.id, 0]))
  const visited = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    for (const next of outgoing.get(id) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, (depth.get(id) ?? 0) + 1))
      const nextIncoming = (incoming.get(next) ?? 1) - 1
      incoming.set(next, nextIncoming)
      if (nextIncoming === 0) queue.push(next)
    }
  }
  // Keep cyclic or disconnected leftovers visible after the normal DAG layers.
  let nextDepth = Math.max(...depth.values(), 0) + 1
  for (const node of nodes) {
    if (!visited.has(node.id)) depth.set(node.id, nextDepth++)
  }

  const layers = new Map<number, WorkflowNode[]>()
  for (const node of nodes) {
    const layer = depth.get(node.id) ?? 0
    const items = layers.get(layer) ?? []
    items.push(node)
    layers.set(layer, items)
  }
  const maxLayerSize = Math.max(...[...layers.values()].map(layer => layer.length), 1)
  const verticalPadding = 42
  const verticalGap = maxLayerSize === 1 ? 0 : Math.max(22, (flowHeight - verticalPadding * 2 - maxLayerSize * flowNodeHeight) / (maxLayerSize - 1))
  const horizontalGap = 48
  return nodes.map(node => {
    const layer = depth.get(node.id) ?? 0
    const items = layers.get(layer) ?? [node]
    const index = items.findIndex(item => item.id === node.id)
    const contentHeight = items.length * flowNodeHeight + Math.max(items.length - 1, 0) * verticalGap
    return { ...node, x: 48 + layer * (flowNodeWidth + horizontalGap), y: Math.max(verticalPadding, (flowHeight - contentHeight) / 2) + index * (flowNodeHeight + verticalGap) }
  })
}

export default function HomePage() {
  const [activeView, setActiveView] = useState('settings')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(defaultSidebarWidth)
  const [inspectorWidth, setInspectorWidth] = useState(defaultInspectorWidth)
  const [inspectorVisible, setInspectorVisible] = useState(true)
  const [settingsPage, setSettingsPage] = useState<'overview' | 'executors'>('overview')
  const [executorOptions, setExecutorOptions] = useState<ExecutorOption[]>([])
  const [executorsLoaded, setExecutorsLoaded] = useState(false)
  const [project, setProject] = useState<ProjectSummary | null>(null)
  const [workflows, setWorkflows] = useState<WorkflowRecordView[]>([])
  const [templates, setTemplates] = useState<WorkflowTemplateView[]>([])
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>('library')
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null)
  const [workflowBusyId, setWorkflowBusyId] = useState<string | null>(null)
  const [workflowLibraryReady, setWorkflowLibraryReady] = useState(false)
  const [draftSaveState, setDraftSaveState] = useState<'saved' | 'saving' | 'error'>('saved')
  const [nodes, setNodes] = useState(initialNodes)
  const [edges, setEdges] = useState(initialEdges)
  const [selectedId, setSelectedId] = useState('requirement')
  const [running, setRunning] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const [pendingCommandApproval, setPendingCommandApproval] = useState<PendingCommandApproval | null>(null)
  const [workflowReady, setWorkflowReady] = useState(false)
  const [logs, setLogs] = useState<string[]>(['工作流已加载 · 核心交付链'])
  const dragRef = useRef<DragState | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const sidebarWidthRef = useRef(defaultSidebarWidth)
  const sidebarResizingRef = useRef(false)
  const inspectorWidthRef = useRef(defaultInspectorWidth)
  const inspectorResizingRef = useRef(false)
  const editorHydratingRef = useRef(false)
  const draftSaveTimerRef = useRef<number | null>(null)
  const workflowWriteQueueRef = useRef<Promise<void>>(Promise.resolve())
  const selected = nodes.find(node => node.id === selectedId)
  const selectedWorkflow = useMemo(() => workflows.find(workflow => workflow.id === selectedWorkflowId) ?? null, [selectedWorkflowId, workflows])
  const completed = useMemo(() => nodes.filter(node => node.state === 'success').length, [nodes])
  const projectName = project?.name ?? '未导入项目'

  useEffect(() => {
    setSidebarCollapsed(window.localStorage.getItem('artifact.sidebar.collapsed') === 'true')
    setInspectorVisible(window.localStorage.getItem('artifact.inspector.visible') !== 'false')
    const savedWidth = Number.parseInt(window.localStorage.getItem('artifact.sidebar.width') ?? '', 10)
    if (Number.isFinite(savedWidth)) {
      const width = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, savedWidth))
      sidebarWidthRef.current = width
      setSidebarWidth(width)
    }
    const savedInspectorWidth = Number.parseInt(window.localStorage.getItem('artifact.inspector.width') ?? '', 10)
    if (Number.isFinite(savedInspectorWidth)) {
      const width = Math.max(minInspectorWidth, Math.min(maxInspectorWidth, savedInspectorWidth))
      inspectorWidthRef.current = width
      setInspectorWidth(width)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b' && !isTextEntryTarget(event.target)) {
        event.preventDefault()
        setSidebarCollapsed(value => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    window.localStorage.setItem('artifact.sidebar.collapsed', String(sidebarCollapsed))
  }, [sidebarCollapsed])

  useEffect(() => {
    window.localStorage.setItem('artifact.inspector.visible', String(inspectorVisible))
  }, [inspectorVisible])

  const updateSidebarWidth = (value: number, persist = true) => {
    const width = Math.max(minSidebarWidth, Math.min(maxSidebarWidth, value))
    sidebarWidthRef.current = width
    shellRef.current?.style.setProperty('--primary-sidebar-width', `${width}px`)
    if (persist) {
      setSidebarWidth(width)
      window.localStorage.setItem('artifact.sidebar.width', String(width))
    }
  }

  const startSidebarResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (sidebarCollapsed || event.button !== 0) return
    event.preventDefault()
    sidebarResizingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    shellRef.current?.setAttribute('data-resizing', 'true')
  }

  const resizeSidebar = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!sidebarResizingRef.current) return
    updateSidebarWidth(event.clientX - 58, false)
  }

  const finishSidebarResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!sidebarResizingRef.current) return
    sidebarResizingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    shellRef.current?.removeAttribute('data-resizing')
    updateSidebarWidth(sidebarWidthRef.current)
  }

  const adjustSidebarWidth = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      updateSidebarWidth(sidebarWidthRef.current - 16)
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      updateSidebarWidth(sidebarWidthRef.current + 16)
    }
    if (event.key === 'Home') {
      event.preventDefault()
      updateSidebarWidth(minSidebarWidth)
    }
    if (event.key === 'End') {
      event.preventDefault()
      updateSidebarWidth(maxSidebarWidth)
    }
  }

  const updateInspectorWidth = (value: number, persist = true) => {
    const width = Math.max(minInspectorWidth, Math.min(maxInspectorWidth, value))
    inspectorWidthRef.current = width
    shellRef.current?.style.setProperty('--inspector-width', `${width}px`)
    if (persist) {
      setInspectorWidth(width)
      window.localStorage.setItem('artifact.inspector.width', String(width))
    }
  }

  const startInspectorResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!hasInspector || event.button !== 0) return
    event.preventDefault()
    inspectorResizingRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    shellRef.current?.setAttribute('data-inspector-resizing', 'true')
  }

  const resizeInspector = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!inspectorResizingRef.current) return
    const shell = shellRef.current?.getBoundingClientRect()
    if (shell) updateInspectorWidth(shell.right - event.clientX, false)
  }

  const finishInspectorResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!inspectorResizingRef.current) return
    inspectorResizingRef.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    shellRef.current?.removeAttribute('data-inspector-resizing')
    updateInspectorWidth(inspectorWidthRef.current)
  }

  const adjustInspectorWidth = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); updateInspectorWidth(inspectorWidthRef.current + 16) }
    if (event.key === 'ArrowRight') { event.preventDefault(); updateInspectorWidth(inspectorWidthRef.current - 16) }
    if (event.key === 'Home') { event.preventDefault(); updateInspectorWidth(minInspectorWidth) }
    if (event.key === 'End') { event.preventDefault(); updateInspectorWidth(maxInspectorWidth) }
  }

  const loadProject = useCallback(() => {
    void fetch('/api/project')
      .then(response => response.ok ? response.json() : null)
      .then((value: { project?: ProjectSummary | null } | null) => setProject(value?.project ?? null))
      .catch(() => setProject(null))
  }, [])

  const loadExecutors = useCallback(() => {
    void fetch('/api/executors/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ includeLatest: false }) })
      .then(response => response.ok ? response.json() : null)
      .then((value: { executors?: ExecutorOption[] } | null) => setExecutorOptions(value?.executors ?? []))
      .catch(() => setExecutorOptions([]))
      .finally(() => setExecutorsLoaded(true))
  }, [])
  useEffect(() => {
    loadExecutors()
    window.addEventListener('artifact-executors-updated', loadExecutors)
    return () => window.removeEventListener('artifact-executors-updated', loadExecutors)
  }, [loadExecutors])
  useEffect(() => {
    loadProject()
    window.addEventListener('artifact-project-updated', loadProject)
    const unsubscribeDesktop = window.artifactDesktop?.onProjectUpdated(loadProject)
    return () => { window.removeEventListener('artifact-project-updated', loadProject); unsubscribeDesktop?.() }
  }, [loadProject])

  const applyWorkflowRecord = useCallback((workflow: WorkflowRecordView) => {
    const nextNodes = editorNodes(workflow.draft.nodes)
    const nextEdges = editorEdges(workflow.draft.edges, new Set(nextNodes.map(node => node.id)))
    editorHydratingRef.current = true
    setSelectedWorkflowId(workflow.id)
    setNodes(nextNodes.length ? nextNodes : initialNodes)
    setEdges(nextEdges)
    setSelectedId(nextNodes[0]?.id ?? initialNodes[0].id)
    setRunId(null)
    setRunStatus(null)
    setPendingCommandApproval(null)
    setRunning(false)
    setLogs([`工作流已加载 · ${workflow.draft.name}`])
  }, [])

  const loadWorkflowLibrary = useCallback(async (preferredId?: string | null) => {
    try {
      const response = await fetch('/api/workflow')
      if (!response.ok) throw new Error('工作流库加载失败')
      const value = await response.json() as { workflows?: WorkflowRecordView[]; templates?: WorkflowTemplateView[] }
      const nextWorkflows = Array.isArray(value.workflows) ? value.workflows : []
      setWorkflows(nextWorkflows)
      setTemplates(Array.isArray(value.templates) ? value.templates : [])
      setSelectedWorkflowId(current => {
        if (preferredId && nextWorkflows.some(workflow => workflow.id === preferredId)) return preferredId
        if (current && nextWorkflows.some(workflow => workflow.id === current)) return current
        return nextWorkflows[0]?.id ?? null
      })
      setWorkflowLibraryReady(true)
      return nextWorkflows
    } catch (error) {
      setWorkflows([])
      setTemplates([])
      setWorkflowLibraryReady(true)
      setLogs(current => [`工作流库加载失败 · ${error instanceof Error ? error.message : String(error)}`, ...current])
      return []
    }
  }, [])

  useEffect(() => {
    void loadWorkflowLibrary()
  }, [loadWorkflowLibrary])

  useEffect(() => {
    if (!workflowLibraryReady || !selectedWorkflowId) return
    const workflow = workflows.find(item => item.id === selectedWorkflowId)
    if (!workflow) return
    const nextNodes = editorNodes(workflow.draft.nodes)
    const nextEdges = editorEdges(workflow.draft.edges, new Set(nextNodes.map(node => node.id)))
    editorHydratingRef.current = true
    setNodes(nextNodes.length ? nextNodes : initialNodes)
    setEdges(nextEdges)
    setSelectedId(current => nextNodes.some(node => node.id === current) ? current : nextNodes[0]?.id ?? '')
    setWorkflowReady(true)
  }, [selectedWorkflowId, workflowLibraryReady])

  const saveWorkflowDraft = useCallback(async (workflowId: string, draftNodes: WorkflowNode[], draftEdges: Edge[]) => {
    const response = await fetch('/api/workflow', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: workflowId, nodes: draftNodes.map(({ state: _state, ...node }) => node), edges: draftEdges }),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(error.error ?? '草稿保存失败')
    }
    const saved = await response.json() as WorkflowRecordView
    setWorkflows(current => current.map(workflow => workflow.id === saved.id ? saved : workflow))
    return saved
  }, [])

  const queueWorkflowWrite = useCallback((operation: () => Promise<WorkflowRecordView>) => {
    const queued = workflowWriteQueueRef.current.then(operation)
    workflowWriteQueueRef.current = queued.then(() => undefined, () => undefined)
    return queued
  }, [])

  useEffect(() => {
    if (!workflowLibraryReady || !selectedWorkflowId) return
    if (editorHydratingRef.current) {
      editorHydratingRef.current = false
      return
    }
    setDraftSaveState('saving')
    const timer = window.setTimeout(() => {
      draftSaveTimerRef.current = null
      void queueWorkflowWrite(() => saveWorkflowDraft(selectedWorkflowId, nodes, edges))
        .then(() => setDraftSaveState('saved'))
        .catch(error => {
          setDraftSaveState('error')
          setLogs(current => [`草稿保存失败 · ${error instanceof Error ? error.message : String(error)}`, ...current])
        })
    }, 450)
    draftSaveTimerRef.current = timer
    return () => {
      window.clearTimeout(timer)
      if (draftSaveTimerRef.current === timer) draftSaveTimerRef.current = null
    }
  }, [nodes, edges, queueWorkflowWrite, saveWorkflowDraft, selectedWorkflowId, workflowLibraryReady])

  const syncRun = useCallback((run: Run, focusNodeId?: string) => {
    setRunId(run.id)
    setRunStatus(run.status)
    setPendingCommandApproval(run.pendingCommandApproval ?? null)
    setLogs(run.logs)
    setRunning(['running', 'preparing', 'awaiting_approval'].includes(run.status))
    setNodes(current => current.map(node => ({ ...node, state: run.nodes.find(item => item.id === node.id)?.state as NodeState ?? node.state })))
    const activeNode = focusNodeId ?? run.nodes.find(node => node.state === 'waiting' || node.state === 'failed' || node.state === 'running')?.id
    if (activeNode) setSelectedId(activeNode)
  }, [])
  useEffect(() => {
    if (!runId) return
    const refreshRun = () => {
      void fetch(`/api/runs/${runId}`)
        .then(response => response.ok ? response.json() : null)
        .then((run: Run | null) => { if (run) syncRun(run) })
        .catch(() => undefined)
    }
    refreshRun()
    const timer = window.setInterval(refreshRun, 700)
    return () => window.clearInterval(timer)
  }, [runId, syncRun])

  const readiness = useMemo<Readiness>(() => {
    if (!project) return { ready: false, step: '第 1 步', title: '选择 Git 项目', detail: '从本机选择项目，Artifact 会检测仓库和常用命令。', action: '选择项目', target: 'project' }
    const agentExecutorIds = [...new Set(nodes.filter(node => node.kind === 'Agent').map(node => node.executorId ?? 'codex'))]
    if (agentExecutorIds.length && !executorsLoaded) return { ready: false, step: '第 3 步', title: '检查 Agent 执行器', detail: '正在读取本地运行时配置。', action: '请稍候', target: null }
    const unavailable = agentExecutorIds.map(id => executorOptions.find(executor => executor.id === id)).find(executor => !executor || !executor.connected || (executor.authentication !== 'authenticated' && executor.authentication !== 'api_key'))
    if (unavailable) return { ready: false, step: '第 3 步', title: `配置 ${unavailable.name ?? 'Agent'} 执行器`, detail: '节点需要已安装、已连接并完成登录验证的运行时。', action: '管理执行器', target: 'executors' }
    return { ready: true, step: '已就绪', title: `${project.name} 可以运行`, detail: '运行将在独立 Worktree 中完成；验证命令会在首次使用前请求授权。', action: '运行工作流', target: null }
  }, [executorsLoaded, executorOptions, nodes, project])

  const openSetup = (target: Readiness['target'] = readiness.target) => {
    if (!target) return
    setActiveView('settings')
    setSettingsPage(target === 'executors' ? 'executors' : 'overview')
  }
  const selectView = (view: string) => {
    setActiveView(view)
    setSidebarCollapsed(false)
    if (view !== 'settings') setSettingsPage('overview')
    if (view === 'workflow') setWorkflowMode('library')
  }
  const openWorkflowLibrary = () => {
    setActiveView('workflow')
    setWorkflowMode('library')
  }
  const openWorkflowEditor = (workflow: WorkflowRecordView) => {
    applyWorkflowRecord(workflow)
    setActiveView('workflow')
    setWorkflowMode('editor')
  }
  const createWorkflow = async (template: WorkflowTemplateView) => {
    setWorkflowBusyId(`create:${template.id}`)
    try {
      const value = await queueWorkflowWrite(async () => {
        const response = await fetch('/api/workflow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', templateId: template.id }) })
        const next = await response.json() as WorkflowRecordView & { error?: string }
        if (!response.ok) throw new Error(next.error ?? '模板创建失败')
        return next
      })
      setWorkflows(current => [...current, value])
      applyWorkflowRecord(value)
      setActiveView('workflow')
      setWorkflowMode('editor')
      setDraftSaveState('saved')
    } catch (error) {
      setLogs(current => [`模板创建失败 · ${error instanceof Error ? error.message : String(error)}`, ...current])
    } finally { setWorkflowBusyId(null) }
  }
  const publishWorkflow = async (workflow: WorkflowRecordView) => {
    setWorkflowBusyId(`publish:${workflow.id}`)
    try {
      const value = await queueWorkflowWrite(async () => {
        if (workflow.id === selectedWorkflowId) await saveWorkflowDraft(workflow.id, nodes, edges)
        const response = await fetch('/api/workflow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'publish', id: workflow.id }) })
        const next = await response.json() as WorkflowRecordView & { error?: string }
        if (!response.ok) throw new Error(next.error ?? '发布失败')
        return next
      })
      setWorkflows(current => current.map(workflow => workflow.id === value.id ? value : workflow))
      setDraftSaveState('saved')
      setLogs(current => [`工作流已发布 · ${value.draft.name} v${value.published.at(-1)?.revision ?? 1}`, ...current])
    } catch (error) {
      setDraftSaveState('error')
      setLogs(current => [`发布失败 · ${error instanceof Error ? error.message : String(error)}`, ...current])
    } finally { setWorkflowBusyId(null) }
  }
  const publishSelectedWorkflow = () => {
    if (selectedWorkflow) void publishWorkflow(selectedWorkflow)
  }
  const updateSelected = (changes: Partial<WorkflowNode>) => setNodes(current => current.map(node => node.id === selectedId ? { ...node, ...changes } : node))
  const setPrimaryInput = (targetId: string, sourceId: string) => {
    setEdges(current => {
      const withoutInputs = current.filter(edge => edge.to !== targetId)
      return sourceId ? [...withoutInputs, { from: sourceId, to: targetId }] : withoutInputs
    })
    const source = nodes.find(node => node.id === sourceId)
    updateSelected({ input: source?.output })
  }
  const actOnRun = async (action: 'approve' | 'reject' | 'cancel') => {
    if (!runId) return
    const response = await fetch(`/api/runs/${runId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
    if (response.ok) syncRun(await response.json() as Run)
    else setLogs(current => [`操作失败 · ${action}`, ...current])
  }
  const addNode = (preset: typeof nodePresets[number]) => {
    const id = `${preset.kind.toLowerCase()}-${Date.now()}`
    setNodes(current => [...current, { ...preset, id, state: 'idle', x: 340, y: 310 }])
    setSelectedId(id)
  }
  const arrangeWorkflow = () => {
    const arranged = arrangeWorkflowNodes(nodes, edges)
    setNodes(arranged)
    return arranged
  }
  const deleteNode = () => {
    if (!selected || !window.confirm(`删除节点“${selected.title}”？与该节点相连的连线也会一并删除。`)) return
    setNodes(current => current.filter(node => node.id !== selected.id))
    setEdges(current => current.filter(edge => edge.from !== selected.id && edge.to !== selected.id))
    setSelectedId('')
  }
  const connectSelectedTo = (targetId: string) => {
    if (!selectedId || selectedId === targetId) return
    setEdges(current => current.some(edge => edge.from === selectedId && edge.to === targetId) ? current : [...current, { from: selectedId, to: targetId }])
  }
  const exportWorkflow = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, nodes: nodes.map(({ state: _state, ...node }) => node), edges }, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'artifact-workflow.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }
  const importWorkflow = async (file: File) => {
    try {
      const value = JSON.parse(await file.text()) as { nodes?: Omit<WorkflowNode, 'state'>[]; edges?: Edge[] }
      if (!selectedWorkflowId || !value.nodes || !value.edges) throw new Error('请选择工作流并提供有效的节点和连线')
      const saved = await queueWorkflowWrite(async () => {
        const response = await fetch('/api/workflow', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...value, id: selectedWorkflowId }) })
        const next = await response.json() as WorkflowRecordView & { error?: string }
        if (!response.ok) throw new Error(next.error ?? '导入失败')
        return next
      })
      setWorkflows(current => current.map(workflow => workflow.id === saved.id ? saved : workflow))
      applyWorkflowRecord(saved)
      setDraftSaveState('saved')
    } catch (error) {
      setLogs(current => [`导入失败 · ${error instanceof Error ? error.message : String(error)}`, ...current])
    }
  }
  const incomingNodes = selected ? edges.filter(edge => edge.to === selected.id).map(edge => nodes.find(node => node.id === edge.from)).filter((node): node is WorkflowNode => Boolean(node)) : []
  const primaryInputId = incomingNodes[0]?.id ?? ''
  const configurableExecutors = executorOptions
  const hasInspector = activeView === 'workflow' && workflowMode === 'editor' && inspectorVisible
  const activeNavItem = navItems.find(item => item.id === activeView)
  const selectedCommandApproval = pendingCommandApproval?.nodeId === selected?.id ? pendingCommandApproval : null

  return <div ref={shellRef} className={`app-shell view-${activeView} workflow-${workflowMode} ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${hasInspector ? 'has-inspector' : ''}`} style={{ '--primary-sidebar-width': `${sidebarWidth}px`, '--inspector-width': `${inspectorWidth}px` } as CSSProperties}>
    <aside className="activity-bar" aria-label="主导航">
      <div className="activity-brand"><span className="brand-mark">A</span></div>
      <nav className="activity-nav">
        {navItems.map(item => { const Icon = item.icon; return <button key={item.id} title={item.label} aria-label={item.label} aria-current={activeView === item.id ? 'page' : undefined} className={activeView === item.id ? 'activity-item active' : 'activity-item'} onClick={() => selectView(item.id)}><Icon aria-hidden="true" /></button> })}
      </nav>
      <div className="activity-bottom"><button className="activity-item" title="收起或展开侧栏" aria-label="收起或展开侧栏" onClick={() => setSidebarCollapsed(value => !value)}>{sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}</button></div>
    </aside>
    <aside className="sidebar" aria-label={`${activeNavItem?.label ?? '工作区'}侧栏`}>
      <div className="side-brand"><span className="brand-name">artifact</span><span className="beta">ALPHA</span><button className="sidebar-toggle" onClick={() => setSidebarCollapsed(true)} aria-label="收起侧栏" title="收起侧栏 (⌘B)"><PanelLeftClose aria-hidden="true" /></button></div>
      <button className="project-switcher" onClick={() => openSetup(project ? 'environment' : 'project')} aria-label={project ? `切换或查看项目 ${project.name}` : '选择项目'}><span className="project-avatar">{project ? project.name.slice(0, 1).toUpperCase() : <Plus aria-hidden="true" />}</span><span><b>{projectName}</b><small>{project ? '命令按需授权' : '选择本地 Git 项目'}</small></span><ChevronRight className="chevron" aria-hidden="true" /></button>
      <div className="side-label">{activeNavItem?.label ?? '工作区'}</div>
      <div className="sidebar-context">
        {activeView === 'workflow' && workflowMode === 'library' && <><div className="context-summary"><span className="context-icon"><Workflow aria-hidden="true" /></span><div><b>工作流库</b><small>{workflows.length} 个草稿 · {workflows.filter(workflow => workflow.published.length).length} 个已发布</small></div></div><button className="context-action" onClick={() => selectView('runs')}>运行已发布版本 <ChevronRight aria-hidden="true" /></button></>}
        {activeView === 'workflow' && workflowMode === 'editor' && <><div className="context-summary"><span className="context-icon"><Workflow aria-hidden="true" /></span><div><b>{selectedWorkflow?.draft.name ?? '工作流编辑器'}</b><small>{nodes.length} 个节点 · {edges.length} 条连接</small></div></div><div className="context-metrics"><span>完成 <b>{completed}</b></span><span>状态 <b>{draftSaveState === 'saving' ? '保存中' : draftSaveState === 'error' ? '保存失败' : '已保存'}</b></span></div><button className="context-action" onClick={openWorkflowLibrary}>返回工作流库 <ChevronRight aria-hidden="true" /></button></>}
        {activeView === 'runs' && <><div className="context-summary"><span className="context-icon"><History aria-hidden="true" /></span><div><b>运行工作台</b><small>{runId ? `当前 ${runStatusLabel(runStatus)}` : '选择已发布版本开始'}</small></div></div><button className="context-action" onClick={openWorkflowLibrary}>打开工作流库 <ChevronRight aria-hidden="true" /></button></>}
        {activeView === 'artifacts' && <><div className="context-summary"><span className="context-icon"><Package aria-hidden="true" /></span><div><b>Artifact Registry</b><small>按 Schema 和运行保存产物</small></div></div><button className="context-action" onClick={() => selectView('runs')}>查看来源运行 <ChevronRight aria-hidden="true" /></button></>}
        {activeView === 'settings' && <><button className={`context-item ${settingsPage === 'overview' ? 'active' : ''}`} onClick={() => setSettingsPage('overview')}><span className="context-icon"><FolderCog aria-hidden="true" /></span><span><b>项目与环境</b><small>项目、Worktree 与命令</small></span></button><button className={`context-item ${settingsPage === 'executors' ? 'active' : ''}`} onClick={() => setSettingsPage('executors')}><span className="context-icon"><Bot aria-hidden="true" /></span><span><b>执行器</b><small>连接和管理 Agent Runtime</small></span></button></>}
      </div>
      <div className="sidebar-bottom"><div className="runtime"><span className="online" />本地运行时</div></div>
    </aside>
    <button className="sidebar-resizer" type="button" role="separator" aria-label="调整主侧栏宽度" aria-orientation="vertical" aria-valuemin={minSidebarWidth} aria-valuemax={maxSidebarWidth} aria-valuenow={sidebarWidth} tabIndex={sidebarCollapsed ? -1 : 0} onPointerDown={startSidebarResize} onPointerMove={resizeSidebar} onPointerUp={finishSidebarResize} onPointerCancel={finishSidebarResize} onKeyDown={adjustSidebarWidth} onDoubleClick={() => updateSidebarWidth(defaultSidebarWidth)} />
    <main className="workspace">
      <header className="workspace-header"><div className="header-leading"><div className="breadcrumb"><span>{projectName}</span><i>/</i><b>{activeNavItem?.label}</b>{activeView === 'workflow' && workflowMode === 'editor' && selectedWorkflow && <><i>/</i><b>{selectedWorkflow.draft.name}</b></>}</div></div>{activeView === 'workflow' && workflowMode === 'editor' && <span className={`saved ${draftSaveState}`}><i />{draftSaveState === 'saving' ? '保存中' : draftSaveState === 'error' ? '保存失败' : '已保存'}</span>}<input ref={importInputRef} type="file" accept="application/json" hidden onChange={event => { const file = event.target.files?.[0]; if (file) void importWorkflow(file); event.currentTarget.value = '' }} /></header>
      {activeView === 'workflow' && workflowMode === 'library' ? <WorkflowLibraryView workflows={workflows} templates={templates} busyId={workflowBusyId} onCreate={template => void createWorkflow(template)} onEdit={openWorkflowEditor} onPublish={workflow => void publishWorkflow(workflow)} onLaunch={() => selectView('runs')} /> : activeView === 'workflow' ? <WorkflowView workflowName={selectedWorkflow?.draft.name ?? '工作流'} publishedRevision={selectedWorkflow?.published.at(-1)?.revision} saveState={draftSaveState} nodes={nodes} edges={edges} selectedId={selectedId} logs={logs} workflowReady={workflowReady && Boolean(selectedWorkflowId)} inspectorVisible={hasInspector} dragRef={dragRef} onSelect={setSelectedId} onMove={setNodes} onConnect={connectSelectedTo} onAddNode={addNode} onArrange={arrangeWorkflow} onImport={() => importInputRef.current?.click()} onExport={exportWorkflow} onToggleInspector={() => setInspectorVisible(value => !value)} onBack={openWorkflowLibrary} onPublish={publishSelectedWorkflow} publishing={workflowBusyId === `publish:${selectedWorkflowId}`} /> : activeView === 'runs' ? <RunWorkspace workflows={workflows} onEditWorkflow={openWorkflowEditor} /> : activeView === 'artifacts' ? <ArtifactView /> : settingsPage === 'executors' ? <ExecutorSettings onBack={() => setSettingsPage('overview')} /> : <SettingsOverview onExecutors={() => setSettingsPage('executors')} onOpenWorkflow={openWorkflowLibrary} executorConfigured={executorOptions.some(executor => executor.connected)} />}
      <footer className="status-bar"><div className="status-group"><span className="status-item project-status"><i />{projectName}</span><span className="status-item">{runStatus ? runStatusLabel(runStatus) : '就绪'}</span></div><div className="status-group"><span className="status-item">本地运行时</span><span className="status-item">Artifact 0.1.0</span></div></footer>
    </main>
    {hasInspector && <>
      <button className="inspector-resizer" type="button" role="separator" aria-label="调整节点编辑器宽度" aria-orientation="vertical" aria-valuemin={minInspectorWidth} aria-valuemax={maxInspectorWidth} aria-valuenow={inspectorWidth} tabIndex={0} onPointerDown={startInspectorResize} onPointerMove={resizeInspector} onPointerUp={finishInspectorResize} onPointerCancel={finishInspectorResize} onKeyDown={adjustInspectorWidth} onDoubleClick={() => updateInspectorWidth(defaultInspectorWidth)} />
      <aside className="inspector">
        <div className="inspector-head"><div><span className={`inspector-icon ${selected?.tone ?? ''}`}>{selected?.kind === 'Agent' ? <Bot aria-hidden="true" /> : selected?.kind === '审批' ? <Scan aria-hidden="true" /> : <Package aria-hidden="true" />}</span><div><h2>{selected?.title ?? '未选择节点'}</h2><p>{selected?.subtitle ?? '从画布选择一个节点'}</p></div></div><button className="inspector-close" aria-label="隐藏检查器" title="隐藏检查器" onClick={() => setInspectorVisible(false)}><X aria-hidden="true" /></button></div>
        {selected && <>
          <div className="inspector-body">
            <div className="inspector-section-label">基本信息</div>
            <label>节点名称<input value={selected.title} onChange={event => updateSelected({ title: event.target.value })} /></label>
            {selected.kind === 'Agent' ? <label>执行器<select value={selected.executorId ?? 'codex'} onChange={event => updateSelected({ executorId: event.target.value })}>{configurableExecutors.length ? configurableExecutors.map(executor => <option key={executor.id} value={executor.id}>{executor.name}{executor.connected ? (executor.authentication === 'authenticated' || executor.authentication === 'api_key' ? ' · 可用' : ' · 需要登录') : ' · 需要连接'}</option>) : <option value="codex">Codex · 正在加载</option>}</select><small className="field-help">Codex 与 Claude Code 均已接入真实运行时。</small></label> : <label>处理方式<div className="artifact-input">{selected.kind === '审批' ? '人工确认后继续' : selected.kind === '验证' ? '检测到的项目验证命令会按需授权' : '本地 Artifact Core'}</div></label>}
            <div className="inspector-section-label">数据流</div>
            <label>上游节点<select value={primaryInputId} onChange={event => setPrimaryInput(selected.id, event.target.value)}><option value="">无上游输入</option>{nodes.filter(node => node.id !== selected.id).map(node => <option key={node.id} value={node.id}>{node.title} · {node.output}</option>)}</select><small className="field-help">Artifact 会在 Run 开始时冻结当前上游版本。</small></label>
            <label>输出 Schema<select value={selected.output} onChange={event => updateSelected({ output: event.target.value })}>{[...new Set([...outputSchemas, selected.output])].map(schema => <option key={schema} value={schema}>{schema} · v1</option>)}</select></label>
            {(selected.kind === '输入' || selected.kind === 'Agent' || selected.kind === '工具') && <label>{selected.kind === '输入' ? '需求与验收标准' : '节点指令'}<textarea value={selected.prompt ?? ''} onChange={event => updateSelected({ prompt: event.target.value })} placeholder="输入该节点需要执行的具体任务" /></label>}
            <div className="inspector-artifacts"><span>当前输入</span>{incomingNodes.length ? incomingNodes.map(node => <button key={node.id} onClick={() => setSelectedId(node.id)}>{node.output}<b>›</b></button>) : <p>此节点从空上下文开始。</p>}</div>
          </div>
          {runStatus === 'awaiting_approval' && (selected.id === 'approval' || selectedCommandApproval) && <div className="approval-footer">{selectedCommandApproval && <div className="command-approval"><b>允许执行此命令？</b><code>{selectedCommandApproval.command.command}</code><small>将在隔离 Worktree 的 {selectedCommandApproval.command.cwd} 中执行，超时 {Math.round(selectedCommandApproval.command.timeoutMs / 1000)} 秒。允许后会保存为该项目的默认授权。</small></div>}<button className="reject-btn" onClick={() => void actOnRun('reject')}>{selectedCommandApproval ? '拒绝命令' : '拒绝'}</button><button className="approve-btn" onClick={() => void actOnRun('approve')}>{selectedCommandApproval ? '允许并继续' : '批准并继续'}</button></div>}
          <div className="inspector-danger"><span>危险操作</span><button className="delete-node" onClick={deleteNode}>删除此节点</button></div>
        </>}
      </aside>
    </>}
  </div>
}

function WorkflowView(props: { workflowName: string; publishedRevision?: number; saveState: 'saved' | 'saving' | 'error'; publishing: boolean; nodes: WorkflowNode[]; edges: Edge[]; selectedId: string; logs: string[]; workflowReady: boolean; inspectorVisible: boolean; dragRef: React.MutableRefObject<DragState | null>; onSelect: (id: string) => void; onMove: React.Dispatch<React.SetStateAction<WorkflowNode[]>>; onConnect: (id: string) => void; onAddNode: (preset: typeof nodePresets[number]) => void; onArrange: () => WorkflowNode[]; onImport: () => void; onExport: () => void; onToggleInspector: () => void; onBack: () => void; onPublish: () => void }) {
  const [viewport, setViewport] = useState<CanvasViewport>({ x: 0, y: 0, zoom: 1 })
  const [viewportMoving, setViewportMoving] = useState(true)
  const [panning, setPanning] = useState(false)
  const [spacePressed, setSpacePressed] = useState(false)
  const [showLibrary, setShowLibrary] = useState(false)
  const [showWorkflowMenu, setShowWorkflowMenu] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [logPanelHeight, setLogPanelHeight] = useState(defaultLogPanelHeight)
  const [logPanelVisible, setLogPanelVisible] = useState(true)
  const [logPanelResizing, setLogPanelResizing] = useState(false)
  const canvasRef = useRef<HTMLElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const edgePathRefs = useRef(new Map<string, SVGPathElement>())
  const viewportRef = useRef<CanvasViewport>(viewport)
  const panRef = useRef<CanvasPanState | null>(null)
  const spacePanRef = useRef(false)
  const viewportTimerRef = useRef<number | null>(null)
  const initialFitDoneRef = useRef(false)
  const logPanelHeightRef = useRef(defaultLogPanelHeight)
  const logPanelResizeRef = useRef<LogPanelResizeState | null>(null)

  const constrainLogPanelHeight = (height: number) => Math.max(minLogPanelHeight, Math.min(maxLogPanelHeight, Math.round(height)))
  const updateLogPanelHeight = (height: number, persist = true) => {
    const next = constrainLogPanelHeight(height)
    logPanelHeightRef.current = next
    setLogPanelHeight(next)
    if (persist) window.localStorage.setItem('artifact.log-panel.height', String(next))
  }

  const startLogPanelResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    logPanelResizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: logPanelHeightRef.current }
    setLogPanelResizing(true)
  }

  const resizeLogPanel = (event: React.PointerEvent<HTMLButtonElement>) => {
    const resize = logPanelResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    updateLogPanelHeight(resize.startHeight + resize.startY - event.clientY, false)
  }

  const finishLogPanelResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const resize = logPanelResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    logPanelResizeRef.current = null
    setLogPanelResizing(false)
    updateLogPanelHeight(logPanelHeightRef.current)
  }

  const adjustLogPanelHeight = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowUp') { event.preventDefault(); updateLogPanelHeight(logPanelHeightRef.current + 16); return }
    if (event.key === 'ArrowDown') { event.preventDefault(); updateLogPanelHeight(logPanelHeightRef.current - 16); return }
    if (event.key === 'Home') { event.preventDefault(); updateLogPanelHeight(minLogPanelHeight); return }
    if (event.key === 'End') { event.preventDefault(); updateLogPanelHeight(maxLogPanelHeight) }
  }

  const applyViewport = useCallback((next: CanvasViewport, animate = false) => {
    const value = { x: next.x, y: next.y, zoom: Math.max(minCanvasZoom, Math.min(maxCanvasZoom, next.zoom)) }
    viewportRef.current = value
    setViewport(value)
    setViewportMoving(!animate)
    if (viewportTimerRef.current !== null) window.clearTimeout(viewportTimerRef.current)
    if (!animate) viewportTimerRef.current = window.setTimeout(() => setViewportMoving(false), 48)
  }, [])

  const fitView = useCallback((animate = false, nodesOverride = props.nodes) => {
    const canvas = canvasRef.current
    if (!canvas || !nodesOverride.length) return
    const rect = canvas.getBoundingClientRect()
    const left = Math.min(...nodesOverride.map(node => node.x))
    const top = Math.min(...nodesOverride.map(node => node.y))
    const right = Math.max(...nodesOverride.map(node => node.x + flowNodeWidth))
    const bottom = Math.max(...nodesOverride.map(node => node.y + flowNodeHeight))
    const padding = 64
    const zoom = Math.max(minCanvasZoom, Math.min(maxCanvasZoom, Math.min((rect.width - padding * 2) / (right - left), (rect.height - padding * 2) / (bottom - top))))
    applyViewport({ x: (rect.width - (right - left) * zoom) / 2 - left * zoom, y: (rect.height - (bottom - top) * zoom) / 2 - top * zoom, zoom }, animate)
  }, [applyViewport, props.nodes])

  const resetZoom = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const current = viewportRef.current
    const centerX = (rect.width / 2 - current.x) / current.zoom
    const centerY = (rect.height / 2 - current.y) / current.zoom
    applyViewport({ x: rect.width / 2 - centerX, y: rect.height / 2 - centerY, zoom: 1 })
  }, [applyViewport])

  const focusSelected = useCallback((animate = false) => {
    const selected = props.nodes.find(node => node.id === props.selectedId)
    const canvas = canvasRef.current
    if (!selected || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const { zoom } = viewportRef.current
    applyViewport({ x: rect.width / 2 - (selected.x + flowNodeWidth / 2) * zoom, y: rect.height / 2 - (selected.y + flowNodeHeight / 2) * zoom, zoom }, animate)
  }, [applyViewport, props.nodes, props.selectedId])

  const updateDraggedEdges = (nodeId: string, x: number, y: number) => {
    props.edges.forEach(edge => {
      if (edge.from !== nodeId && edge.to !== nodeId) return
      const from = edge.from === nodeId ? { x, y } : props.nodes.find(node => node.id === edge.from)
      const to = edge.to === nodeId ? { x, y } : props.nodes.find(node => node.id === edge.to)
      const path = edgePathRefs.current.get(`${edge.from}-${edge.to}`)
      if (from && to && path) path.setAttribute('d', edgePath(from, to))
    })
  }

  const move = (event: React.PointerEvent<HTMLElement>) => {
    const pan = panRef.current
    if (pan && pan.pointerId === event.pointerId) {
      applyViewport({ ...viewportRef.current, x: pan.originX + event.clientX - pan.startX, y: pan.originY + event.clientY - pan.startY })
      return
    }
    const drag = props.dragRef.current
    if (!drag) return
    const canvas = event.currentTarget.getBoundingClientRect()
    const current = viewportRef.current
    const nextX = Math.max(14, (event.clientX - canvas.left - current.x) / current.zoom - drag.dx)
    const nextY = Math.max(20, (event.clientY - canvas.top - current.y) / current.zoom - drag.dy)
    drag.finalX = nextX
    drag.finalY = nextY
    drag.element.style.transform = `translate3d(${nextX - drag.startX}px, ${nextY - drag.startY}px, 0)`
    updateDraggedEdges(drag.id, nextX, nextY)
  }
  const finishMove = (event?: React.PointerEvent<HTMLElement>) => {
    const drag = props.dragRef.current
    if (!drag) return
    if (event && drag.element.hasPointerCapture(event.pointerId)) drag.element.releasePointerCapture(event.pointerId)
    drag.element.style.transform = ''
    drag.element.classList.remove('dragging')
    if (drag.startX !== drag.finalX || drag.startY !== drag.finalY) props.onMove(current => current.map(node => node.id === drag.id ? { ...node, x: drag.finalX, y: drag.finalY } : node))
    props.dragRef.current = null
  }

  const finishPointer = (event?: React.PointerEvent<HTMLElement>) => {
    const pan = panRef.current
    if (pan && (!event || pan.pointerId === event.pointerId)) {
      if (event && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      panRef.current = null
      setPanning(false)
      return
    }
    finishMove(event)
  }

  const startPan = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 1 && !(event.button === 0 && spacePanRef.current)) {
      if (event.button === 0) props.onSelect('')
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: viewportRef.current.x, originY: viewportRef.current.y }
    setPanning(true)
  }

  const zoomCanvas = (event: React.WheelEvent<HTMLElement>) => {
    event.preventDefault()
    const canvas = event.currentTarget.getBoundingClientRect()
    const current = viewportRef.current
    if (event.ctrlKey || event.metaKey) {
      const nextZoom = Math.max(minCanvasZoom, Math.min(maxCanvasZoom, current.zoom * Math.exp(-event.deltaY * 0.0015)))
      const pointX = (event.clientX - canvas.left - current.x) / current.zoom
      const pointY = (event.clientY - canvas.top - current.y) / current.zoom
      applyViewport({ x: event.clientX - canvas.left - pointX * nextZoom, y: event.clientY - canvas.top - pointY * nextZoom, zoom: nextZoom })
      return
    }
    applyViewport({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY })
  }

  useEffect(() => {
    if (!showLibrary && !showWorkflowMenu && !showShortcuts) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolbarRef.current?.contains(event.target)) {
        setShowLibrary(false)
        setShowWorkflowMenu(false)
        setShowShortcuts(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowLibrary(false)
        setShowWorkflowMenu(false)
        setShowShortcuts(false)
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [showLibrary, showWorkflowMenu, showShortcuts])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntryTarget(event.target)) return
      if (event.code === 'Space') {
        if (!event.repeat) {
          spacePanRef.current = true
          setSpacePressed(true)
        }
        event.preventDefault()
        return
      }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === '0') { event.preventDefault(); fitView(); return }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === '1') { event.preventDefault(); resetZoom(); return }
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'f') { event.preventDefault(); focusSelected(); return }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); props.onPublish() }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        spacePanRef.current = false
        setSpacePressed(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [fitView, focusSelected, props.onPublish, resetZoom])

  useEffect(() => {
    if (initialFitDoneRef.current || !props.nodes.length) return
    const frame = window.requestAnimationFrame(() => {
      initialFitDoneRef.current = true
      fitView()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [fitView, props.nodes.length])

  useEffect(() => () => { if (viewportTimerRef.current !== null) window.clearTimeout(viewportTimerRef.current) }, [])

  useEffect(() => {
    const saved = Number.parseInt(window.localStorage.getItem('artifact.log-panel.height') ?? '', 10)
    if (Number.isFinite(saved)) updateLogPanelHeight(saved, false)
    setLogPanelVisible(window.localStorage.getItem('artifact.log-panel.visible') !== 'false')
  }, [])

  useEffect(() => {
    window.localStorage.setItem('artifact.log-panel.visible', String(logPanelVisible))
  }, [logPanelVisible])

  const toggleLibrary = () => {
    setShowLibrary(current => !current)
    setShowWorkflowMenu(false)
    setShowShortcuts(false)
  }
  const toggleWorkflowMenu = () => {
    setShowWorkflowMenu(current => !current)
    setShowLibrary(false)
    setShowShortcuts(false)
  }
  const addNode = (preset: typeof nodePresets[number]) => {
    props.onAddNode(preset)
    setShowLibrary(false)
  }
  const arrangeNodes = () => {
    const arranged = props.onArrange()
    fitView(true, arranged)
  }
  const runLabel = props.publishing ? '发布中…' : props.publishedRevision ? '发布新版本' : '发布'
  const viewportTransform = `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`

  return <>
    <section className={`workflow-readiness ${props.saveState === 'error' ? 'needs-action' : 'ready'}`}>
      <div><span>工作流草稿</span><strong>{props.saveState === 'saving' ? '正在保存更改' : props.saveState === 'error' ? '保存需要重试' : '编辑器已准备就绪'}</strong><p>发布后会生成不可变版本；运行工作台只允许使用已发布版本。</p></div>
      <div className="workflow-readiness-actions"><button className="ghost-btn" onClick={props.onBack}>返回工作流库</button></div>
    </section>
    <div ref={toolbarRef} className="canvas-toolbar workflow-toolbar">
      <div className="workflow-toolbar-title"><button className="header-icon-button workflow-back-button" onClick={props.onBack} aria-label="返回工作流库" title="返回工作流库"><ChevronLeft aria-hidden="true" /></button><span className="flow-icon"><Workflow aria-hidden="true" /></span><div><b>{props.workflowName}</b><small>{props.publishedRevision ? `已发布 v${props.publishedRevision}` : '草稿'} · {props.nodes.length} 个节点 · {props.edges.length} 条连接</small></div><span className={`draft-save-indicator ${props.saveState}`} aria-live="polite">{props.saveState === 'saving' ? '保存中' : props.saveState === 'error' ? '保存失败' : '已保存'}</span></div>
      <div className="toolbar-group workflow-actions">
        <div className="toolbar-menu"><button className="toolbar-primary-action" onClick={toggleLibrary} aria-haspopup="menu" aria-expanded={showLibrary}><Plus aria-hidden="true" /><span>添加节点</span></button>{showLibrary && <div className="node-library" role="menu" aria-label="节点库">{nodePresets.map(preset => <button key={preset.title} role="menuitem" onClick={() => addNode(preset)}><span className={`library-dot ${preset.tone}`} /><span><b>{preset.title}</b><small>{preset.subtitle}</small></span><Plus aria-hidden="true" /></button>)}</div>}</div>
        <div className="toolbar-utility-group" aria-label="画布与面板工具">
          <button className="header-icon-button arrange-button" onClick={arrangeNodes} aria-label="一键整理流水线" title="一键整理流水线"><AlignHorizontalSpaceAround aria-hidden="true" /></button>
          <button className="header-icon-button canvas-command" onClick={() => fitView(true)} aria-label="居中显示全部节点" title="居中显示全部节点 (0)"><Scan aria-hidden="true" /></button>
          <button className="header-icon-button canvas-command" onClick={() => focusSelected(true)} aria-label="聚焦选中节点" title="聚焦选中节点 (F)" disabled={!props.selectedId}><Focus aria-hidden="true" /></button>
          <span className="toolbar-separator" aria-hidden="true" />
          <button className={`header-icon-button log-panel-toggle ${logPanelVisible ? 'active' : ''}`} onClick={() => setLogPanelVisible(value => !value)} aria-label={logPanelVisible ? '收起编辑活动' : '显示编辑活动'} title={logPanelVisible ? '收起编辑活动' : '显示编辑活动'}><PanelBottom aria-hidden="true" /></button>
          <button className={`header-icon-button inspector-toggle ${props.inspectorVisible ? 'active' : ''}`} onClick={props.onToggleInspector} aria-label={props.inspectorVisible ? '隐藏节点检查器' : '显示节点检查器'} title={props.inspectorVisible ? '隐藏节点检查器' : '显示节点检查器'}><PanelRight aria-hidden="true" /></button>
        <div className="toolbar-menu"><button className="header-icon-button" onClick={toggleWorkflowMenu} aria-haspopup="menu" aria-expanded={showWorkflowMenu} aria-label="工作流更多操作" title="工作流更多操作"><Ellipsis aria-hidden="true" /></button>{showWorkflowMenu && <div className="workflow-menu" role="menu" aria-label="工作流操作"><button role="menuitem" onClick={() => { setShowWorkflowMenu(false); props.onImport() }}>导入工作流</button><button role="menuitem" onClick={() => { setShowWorkflowMenu(false); props.onExport() }}>导出工作流</button><button role="menuitem" onClick={() => { setShowWorkflowMenu(false); setShowShortcuts(true) }}>快捷键</button></div>}{showShortcuts && <div className="shortcut-popover" role="dialog" aria-label="流程编辑快捷键"><div><b>画布快捷键</b><button onClick={() => setShowShortcuts(false)} aria-label="关闭快捷键"><X aria-hidden="true" /></button></div><p><kbd>0</kbd><span>居中显示全部节点</span></p><p><kbd>1</kbd><span>恢复为 100% 缩放</span></p><p><kbd>F</kbd><span>聚焦选中节点</span></p><p><kbd>Space</kbd><span>按住后拖拽平移</span></p><p><kbd>⌘/Ctrl</kbd><kbd>Enter</kbd><span>发布当前草稿</span></p><p><kbd>⌘/Ctrl</kbd><kbd>B</kbd><span>收起或展开侧栏</span></p></div>}</div>
        </div><button className="run-btn" onClick={props.onPublish} disabled={props.publishing || !props.workflowReady}><Upload aria-hidden="true" />{runLabel}</button>
      </div>
    </div>
    <section ref={canvasRef} className={`canvas-area ${panning ? 'panning' : ''} ${spacePressed ? 'pan-ready' : ''}`} data-viewport-moving={viewportMoving} onPointerDown={startPan} onPointerMove={move} onPointerUp={finishPointer} onPointerCancel={finishPointer} onWheel={zoomCanvas}>
      <div className="canvas-grid" />
      <div className="flow-canvas" style={{ transform: viewportTransform }}><svg className="edges" viewBox={`0 0 ${flowWidth} ${flowHeight}`} preserveAspectRatio="none">{props.edges.map(edge => { const from = props.nodes.find(node => node.id === edge.from); const to = props.nodes.find(node => node.id === edge.to); const key = `${edge.from}-${edge.to}`; return from && to ? <path key={key} ref={element => { if (element) edgePathRefs.current.set(key, element); else edgePathRefs.current.delete(key) }} d={edgePath(from, to)} /> : null })}</svg>{props.nodes.map(node => <button key={node.id} className={`flow-node ${node.tone} ${props.selectedId === node.id ? 'selected' : ''}`} style={{ left: node.x, top: node.y }} onClick={() => props.onSelect(node.id)} onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.stopPropagation(); if (event.shiftKey) { props.onConnect(node.id); props.onSelect(node.id); return }; const canvas = canvasRef.current?.getBoundingClientRect(); if (!canvas) return; const current = viewportRef.current; const pointerX = (event.clientX - canvas.left - current.x) / current.zoom; const pointerY = (event.clientY - canvas.top - current.y) / current.zoom; const element = event.currentTarget; props.dragRef.current = { id: node.id, dx: pointerX - node.x, dy: pointerY - node.y, startX: node.x, startY: node.y, finalX: node.x, finalY: node.y, element }; element.classList.add('dragging'); element.setPointerCapture(event.pointerId); props.onSelect(node.id) }}><span className="node-kind">{node.kind}</span><span className="node-title">{node.title}</span><span className="node-subtitle">{node.subtitle}</span><span className={`node-status ${node.state}`}><i />{stateLabel(node.state)}</span><span className="node-output">{node.output}<b>›</b></span></button>)}</div>
      <div className="canvas-hint">拖拽移动节点 · 空格+拖拽或中键平移 · ⌘/Ctrl+滚轮缩放 · Shift+点击目标节点连线</div>
      <div className="canvas-zoom" aria-label={`当前缩放 ${Math.round(viewport.zoom * 100)}%`}>{Math.round(viewport.zoom * 100)}%</div>
    </section>
    {logPanelVisible && <section className={`bottom-panel ${logPanelResizing ? 'resizing' : ''}`} style={{ '--log-panel-height': `${logPanelHeight}px` } as CSSProperties}><button className="log-panel-resizer" type="button" role="separator" aria-label="调整编辑活动高度" aria-orientation="horizontal" aria-valuemin={minLogPanelHeight} aria-valuemax={maxLogPanelHeight} aria-valuenow={logPanelHeight} title="拖动调整编辑活动高度；双击恢复默认" tabIndex={0} onPointerDown={startLogPanelResize} onPointerMove={resizeLogPanel} onPointerUp={finishLogPanelResize} onPointerCancel={finishLogPanelResize} onKeyDown={adjustLogPanelHeight} onDoubleClick={() => updateLogPanelHeight(defaultLogPanelHeight)} /><div className="panel-tabs"><span className="panel-tab active">编辑活动 <span>{props.logs.length}</span></span><button className="log-panel-close" type="button" onClick={() => setLogPanelVisible(false)} aria-label="收起编辑活动" title="收起编辑活动"><X aria-hidden="true" /></button></div><div className="log-content"><div className="logs">{props.logs.slice(0, 8).map((log, index) => <div className="log-line" key={`${log}-${index}`}><span className={index === 0 ? 'log-dot active' : 'log-dot'} />{log}</div>)}</div><div className="run-summary"><div><span className="summary-label">草稿状态</span><strong>{props.saveState === 'saving' ? '保存中' : props.saveState === 'error' ? '保存失败' : '已保存'}</strong></div><div><span className="summary-label">节点</span><strong>{props.nodes.length}</strong></div><div><span className="summary-label">发布版本</span><strong className="mono">{props.publishedRevision ? `v${props.publishedRevision}` : '未发布'}</strong></div></div></div></section>}
  </>
}

function ArtifactView() {
  const [artifacts, setArtifacts] = useState<Array<Artifact & { runId: string }>>([])
  const [status, setStatus] = useState('all')
  const [detail, setDetail] = useState<{ artifact: Artifact & { runId: string }; payload: unknown } | null>(null)
  const load = useCallback(() => {
    void fetch('/api/runs')
      .then(response => response.ok ? response.json() : [])
      .then((runs: Run[]) => setArtifacts(runs.flatMap(run => (run.artifacts ?? []).map(artifact => ({ ...artifact, runId: run.id })))))
  }, [])
  useEffect(() => { load(); const timer = window.setInterval(load, 2_000); return () => window.clearInterval(timer) }, [load])
  const open = async (artifact: Artifact & { runId: string }) => {
    const response = await fetch(`/api/runs/${artifact.runId}/artifacts/${artifact.id}`)
    if (response.ok) setDetail({ artifact, payload: await response.json() })
  }
  const filtered = status === 'all' ? artifacts : artifacts.filter(artifact => artifact.status === status)
  return <section className="content-view"><div className="view-heading"><div><span className="section-kicker">ARTIFACT REGISTRY</span><h1>Artifacts</h1><p>Schema 校验、内容哈希和上游血缘均随 Run 持久化。</p></div><label className="table-filter">状态<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="valid">已验证</option><option value="awaiting_approval">待审批</option><option value="invalid">无效</option><option value="rejected">已拒绝</option></select></label></div><div className="stats-row"><div><span>总产物</span><strong>{artifacts.length}</strong></div><div><span>已验证</span><strong className="green-text">{artifacts.filter(item => item.status === 'valid').length}</strong></div><div><span>无效</span><strong>{artifacts.filter(item => item.status === 'invalid').length}</strong></div><div><span>待审批</span><strong className="amber-text">{artifacts.filter(item => item.status === 'awaiting_approval').length}</strong></div></div><div className="table-wrap"><div className="table-head"><span>类型</span><span>节点</span><span>Hash</span><span>状态</span><span>Schema</span><span /></div>{filtered.length ? filtered.map(artifact => <div className="table-row" key={artifact.id}><span>{artifact.type} v{artifact.version ?? 1}</span><b>{artifact.nodeId}</b><span className="mono">{artifact.contentHash.slice(0, 12)}</span><span><em className={`status-pill ${artifact.status === 'valid' ? 'valid' : artifact.status === 'invalid' || artifact.status === 'rejected' ? 'failed' : 'pending'}`}>{artifact.status}</em></span><span className="muted-text">v{artifact.schemaVersion ?? 1}</span><button className="row-action" onClick={() => void open(artifact)}>查看</button></div>) : <div className="empty-state">没有匹配此状态的 Artifact。</div>}</div>{detail && <DetailPanel title={`${detail.artifact.type} v${detail.artifact.version ?? 1}`} onClose={() => setDetail(null)}><div className="artifact-detail-meta"><span>Run</span><code>{detail.artifact.runId}</code><span>上游输入</span><div className="lineage-list">{detail.artifact.inputArtifactIds?.length ? detail.artifact.inputArtifactIds.map(id => <button key={id} onClick={() => { const upstream = artifacts.find(artifact => artifact.id === id); if (upstream) void open(upstream) }}>{id}</button>) : <em>无上游 Artifact</em>}</div></div><pre>{JSON.stringify(detail.payload, null, 2)}</pre></DetailPanel>}</section>
}

function RunsView({ onOpenWorkflow }: { onOpenWorkflow: (run: Run, nodeId?: string) => void }) {
  const [runs, setRuns] = useState<Run[]>([])
  const [selected, setSelected] = useState<Run | null>(null)
  const [retryingNode, setRetryingNode] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const load = useCallback(() => {
    void fetch('/api/runs')
      .then(response => response.ok ? response.json() : [])
      .then((items: Run[]) => { setRuns(items); setSelected(current => current ? items.find(item => item.id === current.id) ?? current : null) })
  }, [])
  useEffect(() => { load(); const timer = window.setInterval(load, 1_500); return () => window.clearInterval(timer) }, [load])
  const retry = async (runId: string, nodeId: string) => {
    setRetryingNode(nodeId)
    setActionError(null)
    try {
      const response = await fetch(`/api/runs/${runId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retry', nodeId }) })
      const run = await response.json() as Run & { error?: string }
      if (!response.ok) throw new Error(run.error ?? '重试请求失败')
      setSelected(run)
      load()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '重试请求失败')
    } finally {
      setRetryingNode(null)
    }
  }
  const cancel = async (runId: string) => {
    setActionError(null)
    const response = await fetch(`/api/runs/${runId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }) })
    if (!response.ok) { setActionError('取消运行失败'); return }
    setSelected(await response.json() as Run)
    load()
  }
  const showWorktree = async (path: string) => { await window.artifactDesktop?.showItem(path) }
  return <section className="content-view"><div className="view-heading"><div><span className="section-kicker">EXECUTION HISTORY</span><h1>运行记录</h1><p>查看 Worktree、恢复状态、节点 Attempt 和交付结果。</p></div></div><div className="run-list">{runs.length === 0 ? <div className="empty-state">还没有运行记录。</div> : runs.map(run => { const recovered = hasRecoveredAttempt(run); return <button className="run-row run-row-button" key={run.id} onClick={() => setSelected(run)}><span className={`run-state ${run.status === 'succeeded' ? 'success' : run.status === 'failed' ? 'failed' : 'pending'}`}><i /></span><div><b>{run.id}</b><small>{new Date(run.startedAt).toLocaleString('zh-CN')}{recovered ? ' · 已从服务重启恢复' : ''}</small></div><span className="run-progress">{run.nodes.filter(node => node.state === 'success').length} / {run.nodes.length}</span><em className={`status-pill ${run.status === 'failed' ? 'failed' : run.status === 'succeeded' ? 'valid' : 'pending'}`}>{runStatusLabel(run.status)}</em><span>›</span></button> })}</div>{selected && <DetailPanel title={selected.id} onClose={() => setSelected(null)}>{hasRecoveredAttempt(selected) && <div className="recovery-notice"><b>已恢复此运行</b><span>服务重启后，未完成的 Attempt 已标记为 process_lost 并从可运行节点继续。</span></div>}{actionError && <div className="executor-notice error">{actionError}</div>}<div className="run-detail-actions"><button className="ghost-btn" onClick={() => onOpenWorkflow(selected)}>在工作流中查看</button>{['running', 'preparing', 'awaiting_approval'].includes(selected.status) && <button className="reject-btn" onClick={() => void cancel(selected.id)}>取消运行</button>}</div><div className="run-detail-meta"><b>Worktree</b><div className="path-with-action"><code>{selected.worktreePath ?? '准备中'}</code>{selected.worktreePath && window.artifactDesktop && <button className="ghost-btn" title="在 Finder 中显示 Worktree" onClick={() => void showWorktree(selected.worktreePath!)}>在 Finder 中显示</button>}</div><b>Branch</b><code>{selected.branchName ?? '—'}</code><b>状态</b><code>{runStatusLabel(selected.status)}</code></div><div className="attempt-list">{selected.nodes.map(node => <div className="attempt-row" key={node.id}><div><b>{node.id}</b><small>{stateLabel(node.state as NodeState)} · {node.attempts?.length ?? 0} Attempts</small>{node.attempts?.at(-1)?.exitReason && <p>{node.attempts.at(-1)?.exitReason}</p>}</div><div className="attempt-actions"><button className="text-btn" onClick={() => onOpenWorkflow(selected, node.id)}>定位节点</button>{['failed', 'skipped', 'cancelled'].includes(node.state) && <button className="ghost-btn" disabled={retryingNode === node.id} onClick={() => void retry(selected.id, node.id)}>{retryingNode === node.id ? '重试中…' : '从此节点重试'}</button>}</div></div>)}</div><pre>{selected.logs.join('\n')}</pre></DetailPanel>}</section>
}

function DetailPanel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const [closing, setClosing] = useState(false)
  const panelRef = useRef<HTMLElement>(null)
  const closeTimer = useRef<number | null>(null)
  const closingRef = useRef(false)
  const previousFocus = useRef<Element | null>(null)
  const onCloseRef = useRef(onClose)
  const closeRef = useRef<() => void>(() => undefined)
  onCloseRef.current = onClose
  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null
      onCloseRef.current()
    }, 240)
  }, [])
  closeRef.current = close
  useEffect(() => {
    previousFocus.current = document.activeElement
    panelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current() }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
      if (previousFocus.current instanceof HTMLElement) previousFocus.current.focus()
    }
  }, [])
  return <div className={`detail-overlay ${closing ? 'closing' : ''}`} onClick={close}><aside ref={panelRef} className="detail-panel" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={event => event.stopPropagation()}><header><h2>{title}</h2><button aria-label="关闭详情" onClick={close}>×</button></header>{children}</aside></div>
}

function hasRecoveredAttempt(run: Run): boolean { return run.nodes.some(node => node.attempts?.some(attempt => attempt.exitReason === 'process_lost')) }
function stateLabel(state: NodeState): string { return ({ idle: '未运行', running: '执行中', paused: '已暂停', success: '已完成', waiting: '待审批', failed: '失败', cancelled: '已取消', skipped: '已跳过' })[state] ?? state }
function runStatusLabel(status: string | null): string { return ({ preparing: '准备中', running: '运行中', paused: '已暂停', awaiting_approval: '待审批', succeeded: '已完成', failed: '失败', cancelled: '已取消' })[status ?? ''] ?? (status ?? '尚未开始') }
