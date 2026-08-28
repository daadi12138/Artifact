'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from 'react'
import { AlertTriangle, ArrowLeft, Check, CirclePause, CirclePlay, Clock3, Copy, FileCode2, FileText, FolderOpen, GitBranch, ImagePlus, LoaderCircle, Package, Paperclip, Play, RotateCcw, Search, Send, Square, Terminal, Waypoints, X } from 'lucide-react'
import { defaultRunMetricColumnWeights, minimumRunMetricColumnWidths, normalizeRunMetricColumnWeights, parseRunMetricColumnWeights, resizeRunMetricColumnPair, serializeRunMetricColumnWeights, type RunMetricColumnValues } from './run-metric-layout'
import type { WorkflowRecordView } from './workflow-library'

type CommandSpec = { command: string; cwd: string; timeoutMs: number }
type PendingCommandApproval = { nodeId: string; commandKey: string; command: CommandSpec; requestedAt: string }
type RunAttachment = { id: string; name: string; mediaType: string; byteLength: number; dataUrl?: string; sourceUrl?: string }
type RunArtifact = { id: string; nodeId: string; type: string; version: number; schemaId: string; schemaVersion: number; status: 'valid' | 'awaiting_approval' | 'rejected' | 'invalid'; contentHash: string; inputArtifactIds: string[]; validationErrors: string[]; createdAt: string }
type RunEvent = { id: string; occurredAt: string; type: 'run-created' | 'run-state' | 'node-state' | 'command' | 'executor' | 'artifact' | 'operator' | 'activity' | 'error'; message: string; nodeId?: string; attemptId?: string; details?: Record<string, string | number | boolean | null> }
type RunAttempt = { id: string; attempt: number; executorId: string; status: string; startedAt: string; endedAt?: string; exitReason?: string; output?: string; inputArtifactIds?: string[] }
type RunNode = { id: string; kind: string; executorId?: string; prompt?: string; outputType?: string; state: string; attempts: RunAttempt[] }
export type RunWorkspaceRun = { id: string; status: string; startedAt: string; endedAt?: string; worktreePath?: string; branchName?: string; workflow?: { workflowId: string; workflowName: string; revision: number; publishedAt: string }; input: { text: string; attachments: RunAttachment[]; submittedAt?: string }; pendingCommandApproval?: PendingCommandApproval; nodes: RunNode[]; edges: Array<{ from: string; to: string }>; logs: string[]; events: RunEvent[]; artifacts: RunArtifact[] }

type PublishedDefinition = { revision: number; publishedAt: string; definition: { id: string; name: string; nodes: Array<{ id: string; kind: string; executorId?: string; prompt?: string; output: string }>; edges: Array<{ from: string; to: string }> } }
type AttachmentDraft = RunAttachment & { preview?: string }
type RunPanelResizeKind = 'history-width' | 'context-width' | 'history-height'
type RunPanelResizeState = { kind: RunPanelResizeKind; pointerId: number; startPosition: number; startSize: number }
type RunPanelMaximums = { historyWidth: number; contextWidth: number; historyHeight: number }
type RunMetricResizeState = { dividerIndex: number; pointerId: number; startX: number; startWidths: RunMetricColumnValues }

const maxAttachmentCount = 12
const maxAttachmentBytes = 8 * 1024 * 1024
const maxTotalAttachmentBytes = 24 * 1024 * 1024
const defaultRunHistoryWidth = 286
const minRunHistoryWidth = 220
const maxRunHistoryWidth = 420
const defaultRunContextWidth = 286
const minRunContextWidth = 240
const maxRunContextWidth = 420
const defaultRunHistoryHeight = 288
const minRunHistoryHeight = 140
const maxRunHistoryHeight = 480
const minRunStepsHeight = 180
const runMetricColumnStorageKey = 'artifact.run-workspace.metric-widths.v1'
const runMetricColumnLabels = ['状态', '节点进度', '持续时间', '分支', '产物'] as const
const runMetricResizerWidth = 9

function stateLabel(state: string) {
  return ({ idle: '等待中', running: '执行中', paused: '已暂停', success: '已完成', waiting: '待处理', failed: '失败', cancelled: '已取消', skipped: '已跳过' })[state] ?? state
}

function runStatusLabel(status: string) {
  return ({ preparing: '准备中', running: '运行中', paused: '已暂停', awaiting_approval: '待审批', succeeded: '已完成', failed: '失败', cancelled: '已取消' })[status] ?? status
}

function isActive(status: string) {
  return ['preparing', 'running', 'awaiting_approval', 'paused'].includes(status)
}

function statusClass(status: string) {
  if (status === 'succeeded' || status === 'success') return 'success'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  if (status === 'paused' || status === 'awaiting_approval' || status === 'waiting') return 'waiting'
  return 'running'
}

function shortId(value: string) { return value.replace(/^run-/, '').slice(0, 12) }

function formatDuration(startedAt: string, endedAt?: string) {
  const started = Date.parse(startedAt)
  const ended = endedAt ? Date.parse(endedAt) : Date.now()
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return '—'
  const seconds = Math.floor((ended - started) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function latestPublished(workflow: WorkflowRecordView): PublishedDefinition | undefined {
  return workflow.published.at(-1) as PublishedDefinition | undefined
}

async function fileToAttachment(file: File, index: number): Promise<AttachmentDraft> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('无法读取附件'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(file)
  })
  return { id: `attachment-${Date.now()}-${index}`, name: file.name, mediaType: file.type || 'application/octet-stream', byteLength: file.size, dataUrl, ...(file.type.startsWith('image/') ? { preview: dataUrl } : {}) }
}

function RunHistoryRail({ runs, selectedRunId, onSelect, className = '', children, panelId, listId, panelRef, listRef, style, listStyle }: { runs: RunWorkspaceRun[]; selectedRunId: string | null | undefined; onSelect: (id: string) => void; className?: string; children?: ReactNode; panelId?: string; listId?: string; panelRef?: Ref<HTMLElement>; listRef?: Ref<HTMLDivElement>; style?: CSSProperties; listStyle?: CSSProperties }) {
  return <aside id={panelId} ref={panelRef} style={style} className={`run-history-rail ${className}`.trim()}>
    <header className="run-history-heading"><div><span className="section-kicker">RUN HISTORY</span><h2>最近运行</h2></div><span className="run-history-total" title={`${runs.length} 条运行记录`}>{runs.length}</span></header>
    {runs.length ? <div id={listId} ref={listRef} style={listStyle} className="recent-run-list">{runs.map(run => {
      const status = statusClass(run.status)
      const workflowName = run.workflow?.workflowName ?? '未命名工作流'
      const branchName = run.branchName ?? '尚未创建分支'
      const duration = formatDuration(run.startedAt, run.endedAt)
      const artifactCount = run.artifacts.length
      return <button key={run.id} className={`recent-run ${run.id === selectedRunId ? 'selected' : ''}`} aria-current={run.id === selectedRunId ? 'page' : undefined} aria-label={`查看运行 ${run.id}，${runStatusLabel(run.status)}，分支 ${branchName}，时长 ${duration}，${artifactCount} 个产物`} onClick={() => onSelect(run.id)}><span className="recent-run-track" aria-hidden="true"><span className={`recent-run-dot ${status}`} /></span><span className="recent-run-content"><span className="recent-run-header"><b title={workflowName}>{workflowName}</b><span className={`recent-run-status ${status}`} title={runStatusLabel(run.status)}><i aria-hidden="true" />{runStatusLabel(run.status)}</span></span><code className="recent-run-id" title={run.id}>{shortId(run.id)}</code><span className="recent-run-meta"><span className="recent-run-branch" title={branchName}><GitBranch aria-hidden="true" /><span>{branchName}</span></span><span title={`运行时长 ${duration}`}><Clock3 aria-hidden="true" />{duration}</span><span title={`${artifactCount} 个 Artifact`}><Package aria-hidden="true" />{artifactCount}</span></span></span></button>
    })}</div> : <p className="run-history-empty">运行后，这里会按时间保留可回看的历史记录。</p>}
    {children}
  </aside>
}

function RunMetricsStrip({ status, completedNodeCount, nodeCount, progress, startedAt, endedAt, branchName, artifactCount }: { status: string; completedNodeCount: number; nodeCount: number; progress: number; startedAt: string; endedAt?: string; branchName?: string; artifactCount: number }) {
  const [columnWeights, setColumnWeights] = useState<RunMetricColumnValues>(() => [...defaultRunMetricColumnWeights])
  const [columnWidths, setColumnWidths] = useState<RunMetricColumnValues | null>(null)
  const [resizingDivider, setResizingDivider] = useState<number | null>(null)
  const metricRefs = useRef<Array<HTMLElement | null>>([])
  const columnWeightsRef = useRef<RunMetricColumnValues>([...defaultRunMetricColumnWeights])
  const resizeRef = useRef<RunMetricResizeState | null>(null)

  const updateColumnWeights = (weights: readonly number[], persist: boolean) => {
    const next = normalizeRunMetricColumnWeights(weights)
    columnWeightsRef.current = next
    setColumnWeights(next)
    if (persist) {
      try {
        window.localStorage.setItem(runMetricColumnStorageKey, serializeRunMetricColumnWeights(next))
      } catch {
        // Storage can be unavailable in privacy-restricted browser contexts.
      }
    }
  }
  const readColumnWidths = (): RunMetricColumnValues | null => {
    const widths = metricRefs.current.map(element => element?.getBoundingClientRect().width ?? Number.NaN)
    return widths.length === runMetricColumnLabels.length && widths.every(value => Number.isFinite(value) && value > 0) ? widths as RunMetricColumnValues : null
  }
  const syncColumnWidths = () => {
    const next = readColumnWidths()
    if (!next) return
    setColumnWidths(current => current?.every((value, index) => Math.abs(value - next[index]) < 0.5) ? current : next)
  }
  const startResize = (dividerIndex: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current || event.button !== 0) return
    const startWidths = readColumnWidths()
    if (!startWidths) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      resizeRef.current = null
      setResizingDivider(null)
      return
    }
    resizeRef.current = { dividerIndex, pointerId: event.pointerId, startX: event.clientX, startWidths }
    setColumnWidths(startWidths)
    setResizingDivider(dividerIndex)
  }
  const resize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const activeResize = resizeRef.current
    if (!activeResize || activeResize.pointerId !== event.pointerId) return
    const delta = event.clientX - activeResize.startX
    const nextWidths = resizeRunMetricColumnPair(activeResize.startWidths, activeResize.dividerIndex, delta)
    updateColumnWeights(nextWidths, false)
    setColumnWidths(nextWidths)
  }
  const finishResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const activeResize = resizeRef.current
    if (!activeResize || activeResize.pointerId !== event.pointerId) return
    resizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setResizingDivider(null)
    updateColumnWeights(columnWeightsRef.current, true)
    window.requestAnimationFrame(syncColumnWidths)
  }
  const adjustWithKeyboard = (dividerIndex: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const widths = readColumnWidths()
    if (!widths) return
    const step = event.shiftKey ? 32 : 16
    let delta: number | null = null
    if (event.key === 'ArrowLeft') delta = -step
    else if (event.key === 'ArrowRight') delta = step
    else if (event.key === 'Home') delta = minimumRunMetricColumnWidths[dividerIndex] - widths[dividerIndex]
    else if (event.key === 'End') delta = widths[dividerIndex + 1] - minimumRunMetricColumnWidths[dividerIndex + 1]
    if (delta === null) return
    event.preventDefault()
    const nextWidths = resizeRunMetricColumnPair(widths, dividerIndex, delta)
    updateColumnWeights(nextWidths, true)
    setColumnWidths(nextWidths)
    window.requestAnimationFrame(syncColumnWidths)
  }
  const resetColumnWeights = () => updateColumnWeights(defaultRunMetricColumnWeights, true)

  const cancelResize = () => {
    if (!resizeRef.current) return
    resizeRef.current = null
    setResizingDivider(null)
    updateColumnWeights(columnWeightsRef.current, true)
  }

  useEffect(() => {
    let restored = [...defaultRunMetricColumnWeights] as RunMetricColumnValues
    try {
      restored = parseRunMetricColumnWeights(window.localStorage.getItem(runMetricColumnStorageKey))
    } catch {
      // Keep the default layout when storage is unavailable.
    }
    columnWeightsRef.current = restored
    setColumnWeights(restored)
  }, [])
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const elements = metricRefs.current.filter((element): element is HTMLElement => Boolean(element))
    if (!elements.length) return
    syncColumnWidths()
    const observer = new ResizeObserver(syncColumnWidths)
    elements.forEach(element => observer.observe(element))
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    window.addEventListener('blur', cancelResize)
    return () => {
      window.removeEventListener('blur', cancelResize)
      resizeRef.current = null
    }
  }, [])

  const columnTemplate = columnWeights.flatMap((weight, index) => [
    `minmax(${minimumRunMetricColumnWidths[index]}px, ${weight}fr)`,
    ...(index < columnWeights.length - 1 ? [`${runMetricResizerWidth}px`] : []),
  ]).join(' ')
  const renderResizer = (dividerIndex: number) => {
    const leftWidth = Math.round(columnWidths?.[dividerIndex] ?? minimumRunMetricColumnWidths[dividerIndex])
    const rightWidth = Math.round(columnWidths?.[dividerIndex + 1] ?? minimumRunMetricColumnWidths[dividerIndex + 1])
    const pairTotal = leftWidth + rightWidth
    const leftMaximum = Math.max(minimumRunMetricColumnWidths[dividerIndex], pairTotal - minimumRunMetricColumnWidths[dividerIndex + 1])
    return <button
      className="run-metric-resizer"
      type="button"
      role="separator"
      aria-label={`调整${runMetricColumnLabels[dividerIndex]}和${runMetricColumnLabels[dividerIndex + 1]}宽度`}
      aria-orientation="vertical"
      aria-controls={`run-metric-${dividerIndex} run-metric-${dividerIndex + 1}`}
      aria-valuemin={minimumRunMetricColumnWidths[dividerIndex]}
      aria-valuemax={leftMaximum}
      aria-valuenow={Math.max(minimumRunMetricColumnWidths[dividerIndex], Math.min(leftMaximum, leftWidth))}
      aria-valuetext={`${runMetricColumnLabels[dividerIndex]} ${leftWidth} 像素，${runMetricColumnLabels[dividerIndex + 1]} ${rightWidth} 像素`}
      title="拖动调整相邻指标；双击恢复默认列宽"
      onPointerDown={event => startResize(dividerIndex, event)}
      onPointerMove={resize}
      onPointerUp={finishResize}
      onPointerCancel={finishResize}
      onLostPointerCapture={finishResize}
      onKeyDown={event => adjustWithKeyboard(dividerIndex, event)}
      onDoubleClick={resetColumnWeights}
    />
  }

  return <section className="run-metrics-strip" aria-label="运行指标" data-resizing={resizingDivider === null ? undefined : 'true'} style={{ '--run-metric-columns': columnTemplate } as CSSProperties}>
    <article id="run-metric-0" ref={element => { metricRefs.current[0] = element }} className="run-metric run-metric-status"><span className={`metric-status-dot ${statusClass(status)}`} /><div><span>状态</span><strong>{runStatusLabel(status)}</strong></div></article>
    {renderResizer(0)}
    <article id="run-metric-1" ref={element => { metricRefs.current[1] = element }} className="run-metric run-metric-progress"><div className="metric-heading"><span>节点进度</span><strong>{completedNodeCount}/{nodeCount}</strong></div><div className="run-progress-track" role="progressbar" aria-label="节点进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }} /></div><small>{progress}% 已完成</small></article>
    {renderResizer(1)}
    <article id="run-metric-2" ref={element => { metricRefs.current[2] = element }} className="run-metric"><Clock3 aria-hidden="true" /><div><span>持续时间</span><strong>{formatDuration(startedAt, endedAt)}</strong></div></article>
    {renderResizer(2)}
    <article id="run-metric-3" ref={element => { metricRefs.current[3] = element }} className="run-metric"><GitBranch aria-hidden="true" /><div><span>分支</span><strong className="mono" title={branchName ?? '—'}>{branchName ?? '—'}</strong></div></article>
    {renderResizer(3)}
    <article id="run-metric-4" ref={element => { metricRefs.current[4] = element }} className="run-metric"><Package aria-hidden="true" /><div><span>产物</span><strong>{artifactCount}</strong></div></article>
  </section>
}

export function RunWorkspace({ workflows, onEditWorkflow, onRunContextChange }: { workflows: WorkflowRecordView[]; onEditWorkflow: (workflow: WorkflowRecordView) => void; onRunContextChange?: (run: Pick<RunWorkspaceRun, 'id' | 'status' | 'branchName' | 'workflow'> | null) => void }) {
  const [runs, setRuns] = useState<RunWorkspaceRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null | undefined>(undefined)
  const [workflowId, setWorkflowId] = useState('')
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([])
  const [referenceUrl, setReferenceUrl] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState('')
  const [tab, setTab] = useState<'input' | 'activity' | 'artifacts' | 'diff'>('input')
  const [artifactPayload, setArtifactPayload] = useState<{ id: string; payload: unknown } | null>(null)
  const [steeringNote, setSteeringNote] = useState('')
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const attachmentInputRef = useRef<HTMLInputElement>(null)
  const copyTimerRef = useRef<number | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [logQuery, setLogQuery] = useState('')
  const [runHistoryWidth, setRunHistoryWidth] = useState(defaultRunHistoryWidth)
  const [runContextWidth, setRunContextWidth] = useState(defaultRunContextWidth)
  const [runHistoryHeight, setRunHistoryHeight] = useState(defaultRunHistoryHeight)
  const [runPanelMaximums, setRunPanelMaximums] = useState<RunPanelMaximums>({ historyWidth: maxRunHistoryWidth, contextWidth: maxRunContextWidth, historyHeight: maxRunHistoryHeight })
  const [panelResizing, setPanelResizing] = useState<RunPanelResizeKind | null>(null)
  const runConsoleRef = useRef<HTMLDivElement>(null)
  const runHistoryRailRef = useRef<HTMLElement>(null)
  const runHistoryListRef = useRef<HTMLDivElement>(null)
  const runContextPanelRef = useRef<HTMLElement>(null)
  const runHistoryWidthRef = useRef(defaultRunHistoryWidth)
  const runContextWidthRef = useRef(defaultRunContextWidth)
  const runHistoryHeightRef = useRef(defaultRunHistoryHeight)
  const panelResizeRef = useRef<RunPanelResizeState | null>(null)

  const constrainPanelSize = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)))
  const getRunPanelWidthMax = (kind: Extract<RunPanelResizeKind, 'history-width' | 'context-width'>) => {
    const minimum = kind === 'history-width' ? minRunHistoryWidth : minRunContextWidth
    const maximum = kind === 'history-width' ? maxRunHistoryWidth : maxRunContextWidth
    const consoleWidth = runConsoleRef.current?.getBoundingClientRect().width ?? 0
    const available = consoleWidth > 0 ? Math.floor(consoleWidth * 0.34) : maximum
    return Math.max(minimum, Math.min(maximum, available))
  }
  const constrainRunPanelWidth = (kind: Extract<RunPanelResizeKind, 'history-width' | 'context-width'>, value: number) => {
    const minimum = kind === 'history-width' ? minRunHistoryWidth : minRunContextWidth
    return constrainPanelSize(value, minimum, getRunPanelWidthMax(kind))
  }
  const getRunHistoryHeightMax = () => {
    const rail = runHistoryRailRef.current
    const railHeight = rail?.getBoundingClientRect().height ?? 0
    const headingHeight = rail?.querySelector<HTMLElement>('.run-history-heading')?.getBoundingClientRect().height ?? 58
    const splitterHeight = rail?.querySelector<HTMLElement>('.run-history-splitter')?.getBoundingClientRect().height ?? 9
    const available = railHeight > 0 ? railHeight - headingHeight - splitterHeight - minRunStepsHeight : maxRunHistoryHeight
    return Math.max(minRunHistoryHeight, Math.min(maxRunHistoryHeight, Math.floor(available)))
  }
  const constrainRunHistoryHeight = (value: number) => constrainPanelSize(value, minRunHistoryHeight, getRunHistoryHeightMax())
  const previewRunPanelSize = (kind: RunPanelResizeKind, value: number) => {
    if (kind === 'history-width') {
      const next = constrainRunPanelWidth(kind, value)
      runHistoryWidthRef.current = next
      runConsoleRef.current?.style.setProperty('--run-history-width', `${next}px`)
      return next
    }
    if (kind === 'context-width') {
      const next = constrainRunPanelWidth(kind, value)
      runContextWidthRef.current = next
      runConsoleRef.current?.style.setProperty('--run-context-width', `${next}px`)
      return next
    }
    const next = constrainRunHistoryHeight(value)
    runHistoryHeightRef.current = next
    if (runHistoryListRef.current) {
      runHistoryListRef.current.style.flexBasis = `${next}px`
      runHistoryListRef.current.style.maxHeight = `${next}px`
    }
    return next
  }
  const commitRunPanelSize = (kind: RunPanelResizeKind, value: number) => {
    const next = previewRunPanelSize(kind, value)
    if (kind === 'history-width') {
      setRunHistoryWidth(next)
      window.localStorage.setItem('artifact.run-workspace.history-width', String(next))
    } else if (kind === 'context-width') {
      setRunContextWidth(next)
      window.localStorage.setItem('artifact.run-workspace.context-width', String(next))
    } else {
      setRunHistoryHeight(next)
      window.localStorage.setItem('artifact.run-workspace.history-height', String(next))
    }
  }
  const startRunPanelResize = (kind: RunPanelResizeKind, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (panelResizeRef.current || event.button !== 0) return
    event.preventDefault()
    const target = kind === 'history-width' ? runHistoryRailRef.current : kind === 'context-width' ? runContextPanelRef.current : runHistoryListRef.current
    const rect = target?.getBoundingClientRect()
    const startSize = kind === 'history-height' ? rect?.height ?? runHistoryHeightRef.current : rect?.width ?? (kind === 'history-width' ? runHistoryWidthRef.current : runContextWidthRef.current)
    const startPosition = kind === 'history-height' ? event.clientY : event.clientX
    panelResizeRef.current = { kind, pointerId: event.pointerId, startPosition, startSize }
    event.currentTarget.setPointerCapture(event.pointerId)
    setPanelResizing(kind)
  }
  const resizeRunPanel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = panelResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const position = resize.kind === 'history-height' ? event.clientY : event.clientX
    const delta = position - resize.startPosition
    const next = previewRunPanelSize(resize.kind, resize.kind === 'context-width' ? resize.startSize - delta : resize.startSize + delta)
    event.currentTarget.setAttribute('aria-valuenow', String(next))
  }
  const finishRunPanelResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = panelResizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    panelResizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setPanelResizing(null)
    const value = resize.kind === 'history-width' ? runHistoryWidthRef.current : resize.kind === 'context-width' ? runContextWidthRef.current : runHistoryHeightRef.current
    commitRunPanelSize(resize.kind, value)
  }
  const adjustRunPanelSize = (kind: RunPanelResizeKind, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 32 : 16
    const minimum = kind === 'history-width' ? minRunHistoryWidth : kind === 'context-width' ? minRunContextWidth : minRunHistoryHeight
    const maximum = kind === 'history-width' ? getRunPanelWidthMax(kind) : kind === 'context-width' ? getRunPanelWidthMax(kind) : getRunHistoryHeightMax()
    const preferred = kind === 'history-width' ? runHistoryWidthRef.current : kind === 'context-width' ? runContextWidthRef.current : runHistoryHeightRef.current
    const current = Math.min(preferred, maximum)
    let next: number | null = null
    if (event.key === 'Home') next = minimum
    else if (event.key === 'End') next = maximum
    else if (kind === 'history-height' && event.key === 'ArrowUp') next = current - step
    else if (kind === 'history-height' && event.key === 'ArrowDown') next = current + step
    else if (kind === 'context-width' && event.key === 'ArrowLeft') next = current + step
    else if (kind === 'context-width' && event.key === 'ArrowRight') next = current - step
    else if (kind === 'history-width' && event.key === 'ArrowLeft') next = current - step
    else if (kind === 'history-width' && event.key === 'ArrowRight') next = current + step
    if (next === null) return
    event.preventDefault()
    commitRunPanelSize(kind, next)
  }

  useEffect(() => {
    const readSize = (key: string, fallback: number, min: number, max: number) => {
      const value = Number.parseInt(window.localStorage.getItem(key) ?? '', 10)
      return Number.isFinite(value) ? constrainPanelSize(value, min, max) : fallback
    }
    const historyWidth = readSize('artifact.run-workspace.history-width', defaultRunHistoryWidth, minRunHistoryWidth, maxRunHistoryWidth)
    const contextWidth = readSize('artifact.run-workspace.context-width', defaultRunContextWidth, minRunContextWidth, maxRunContextWidth)
    const historyHeight = readSize('artifact.run-workspace.history-height', defaultRunHistoryHeight, minRunHistoryHeight, maxRunHistoryHeight)
    runHistoryWidthRef.current = historyWidth
    runContextWidthRef.current = contextWidth
    runHistoryHeightRef.current = historyHeight
    setRunHistoryWidth(historyWidth)
    setRunContextWidth(contextWidth)
    setRunHistoryHeight(historyHeight)
  }, [])

  const publishedWorkflows = useMemo(() => workflows.filter(workflow => latestPublished(workflow)), [workflows])
  const selectedRun = useMemo(() => runs.find(run => run.id === selectedRunId) ?? null, [runs, selectedRunId])
  const selectedNode = useMemo(() => selectedRun?.nodes.find(node => node.id === selectedNodeId) ?? selectedRun?.nodes[0] ?? null, [selectedNodeId, selectedRun])
  const chosenWorkflow = useMemo(() => workflows.find(workflow => workflow.id === workflowId) ?? publishedWorkflows[0] ?? null, [publishedWorkflows, workflowId, workflows])
  const selectedRunContext = useMemo(() => selectedRun ? {
    id: selectedRun.id,
    status: selectedRun.status,
    branchName: selectedRun.branchName,
    workflow: selectedRun.workflow,
  } : null, [selectedRun?.id, selectedRun?.status, selectedRun?.branchName, selectedRun?.workflow?.workflowId, selectedRun?.workflow?.workflowName, selectedRun?.workflow?.revision, selectedRun?.workflow?.publishedAt])

  const loadRuns = useCallback(() => {
    void fetch('/api/runs')
      .then(response => response.ok ? response.json() : [])
      .then((items: RunWorkspaceRun[]) => {
        setRuns(items)
        setSelectedRunId(current => {
          if (current === undefined) return items[0]?.id ?? null
          if (current && !items.some(item => item.id === current)) return null
          return current
        })
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => { loadRuns(); const timer = window.setInterval(loadRuns, 900); return () => window.clearInterval(timer) }, [loadRuns])
  useEffect(() => { if (!workflowId && publishedWorkflows[0]) setWorkflowId(publishedWorkflows[0].id) }, [publishedWorkflows, workflowId])
  useEffect(() => { if (selectedRun && !selectedRun.nodes.some(node => node.id === selectedNodeId)) setSelectedNodeId(selectedRun.nodes[0]?.id ?? '') }, [selectedNodeId, selectedRun])
  useEffect(() => { setArtifactPayload(null); setTab('input') }, [selectedNodeId, selectedRunId])
  useEffect(() => { setLogQuery('') }, [selectedRunId])
  useEffect(() => { onRunContextChange?.(selectedRunContext) }, [onRunContextChange, selectedRunContext])
  useEffect(() => () => { onRunContextChange?.(null) }, [onRunContextChange])
  useEffect(() => {
    const consoleElement = runConsoleRef.current
    const historyRail = runHistoryRailRef.current
    if (!selectedRun || !consoleElement || !historyRail || typeof ResizeObserver === 'undefined') return

    const syncPanelSizes = () => {
      if (window.matchMedia('(max-width: 900px)').matches) return
      const next = {
        historyWidth: getRunPanelWidthMax('history-width'),
        contextWidth: getRunPanelWidthMax('context-width'),
        historyHeight: getRunHistoryHeightMax(),
      }
      setRunPanelMaximums(current => current.historyWidth === next.historyWidth && current.contextWidth === next.contextWidth && current.historyHeight === next.historyHeight ? current : next)
    }

    syncPanelSizes()
    const observer = new ResizeObserver(syncPanelSizes)
    observer.observe(consoleElement)
    observer.observe(historyRail)
    return () => observer.disconnect()
  }, [selectedRun?.id])
  useEffect(() => {
    panelResizeRef.current = null
    setPanelResizing(null)
  }, [selectedRun?.id])
  useEffect(() => () => { if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current) }, [])

  const addFiles = async (files: FileList | File[]) => {
    const incoming = Array.from(files)
    if (!incoming.length) return
    const invalid = incoming.find(file => file.size > maxAttachmentBytes)
    if (invalid) { setNotice({ kind: 'error', text: `${invalid.name} 超过单文件 8 MB 限制。` }); return }
    const remaining = maxAttachmentCount - attachments.length
    if (remaining <= 0) { setNotice({ kind: 'error', text: `每次运行最多添加 ${maxAttachmentCount} 个附件。` }); return }
    const accepted = incoming.slice(0, remaining)
    const total = attachments.reduce((sum, item) => sum + item.byteLength, 0) + accepted.reduce((sum, file) => sum + file.size, 0)
    if (total > maxTotalAttachmentBytes) { setNotice({ kind: 'error', text: '附件总大小不能超过 24 MB。' }); return }
    try {
      setBusy('attachments')
      const next = await Promise.all(accepted.map(fileToAttachment))
      setAttachments(current => [...current, ...next])
      setNotice(null)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '读取附件失败。' })
    } finally { setBusy(null) }
  }

  const attachReference = () => {
    try {
      const url = new URL(referenceUrl.trim())
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('仅支持 HTTP(S) 网页地址。')
      if (attachments.length >= maxAttachmentCount) throw new Error(`每次运行最多添加 ${maxAttachmentCount} 个附件。`)
      setAttachments(current => [...current, { id: `reference-${Date.now()}`, name: url.hostname + url.pathname, mediaType: 'text/uri-list', byteLength: 0, sourceUrl: url.toString() }])
      setReferenceUrl('')
      setNotice({ kind: 'success', text: '网页参考已加入本次运行。链接会作为冻结输入保存。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '网页地址无效。' })
    }
  }

  const startRun = async () => {
    const publication = chosenWorkflow && latestPublished(chosenWorkflow)
    if (!chosenWorkflow || !publication) { setNotice({ kind: 'error', text: '请先选择一个已发布的工作流。' }); return }
    setBusy('start')
    setNotice(null)
    try {
      const response = await fetch('/api/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          nodes: publication.definition.nodes.map(node => ({ id: node.id, kind: node.kind, executorId: node.executorId, prompt: node.prompt, outputType: node.output })),
          edges: publication.definition.edges,
          input: { text, attachments: attachments.map(({ preview: _preview, ...attachment }) => attachment) },
          workflow: { workflowId: chosenWorkflow.id, workflowName: publication.definition.name, revision: publication.revision, publishedAt: publication.publishedAt },
        }),
      })
      const value = await response.json() as RunWorkspaceRun & { error?: string }
      if (!response.ok) throw new Error(value.error ?? '运行启动失败。')
      setRuns(current => [value, ...current.filter(run => run.id !== value.id)])
      setSelectedRunId(value.id)
      setSelectedNodeId(value.nodes[0]?.id ?? '')
      setText('')
      setAttachments([])
      setNotice({ kind: 'success', text: '运行已创建；输入与工作流版本已冻结。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '运行启动失败。' })
    } finally { setBusy(null) }
  }

  const runAction = async (action: 'approve' | 'reject' | 'cancel' | 'pause' | 'resume' | 'retry' | 'steer', extra: Record<string, string> = {}) => {
    if (!selectedRun) return
    setBusy(action)
    setNotice(null)
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) })
      const value = await response.json() as RunWorkspaceRun & { error?: string }
      if (!response.ok) throw new Error(value.error ?? '操作没有完成。')
      setRuns(current => current.map(run => run.id === value.id ? value : run))
      setSelectedRunId(value.id)
      if (action === 'steer') { setSteeringNote(''); setNotice({ kind: 'success', text: '补充说明已冻结，会在继续执行时作为下一次 Attempt 的输入。' }) }
      if (action === 'resume') setNotice({ kind: 'success', text: '运行已恢复，将从暂停节点创建新的 Attempt。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '操作没有完成。' })
    } finally { setBusy(null) }
  }

  const openArtifact = async (artifact: RunArtifact) => {
    if (!selectedRun) return
    setBusy(`artifact:${artifact.id}`)
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}/artifacts/${artifact.id}`)
      if (!response.ok) throw new Error('无法读取此产物。')
      setArtifactPayload({ id: artifact.id, payload: await response.json() })
      setTab(artifact.type === 'code-diff' ? 'diff' : 'artifacts')
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '无法读取此产物。' })
    } finally { setBusy(null) }
  }

  const showWorktree = async () => { if (selectedRun?.worktreePath) await window.artifactDesktop?.showItem(selectedRun.worktreePath) }
  const selectedArtifacts = useMemo(() => selectedRun && selectedNode ? selectedRun.artifacts.filter(artifact => artifact.nodeId === selectedNode.id) : [], [selectedNode, selectedRun])
  const selectedEvents = useMemo(() => selectedRun ? selectedRun.events.filter(event => !selectedNode || !event.nodeId || event.nodeId === selectedNode.id).slice().reverse() : [], [selectedNode, selectedRun])
  const selectedDiff = useMemo(() => selectedArtifacts.find(artifact => artifact.type === 'code-diff') ?? null, [selectedArtifacts])
  const completedNodeCount = selectedRun?.nodes.filter(node => ['success', 'failed', 'cancelled', 'skipped'].includes(node.state)).length ?? 0
  const runProgress = selectedRun?.nodes.length ? Math.round((completedNodeCount / selectedRun.nodes.length) * 100) : 0
  const selectedAttempt = selectedNode?.attempts.at(-1)
  const artifactPayloadText = artifactPayload ? JSON.stringify(artifactPayload.payload, null, 2) : ''
  const diffPayloadText = artifactPayload && artifactPayload.id === selectedDiff?.id ? payloadContent(artifactPayload.payload) : ''
  const filteredLogs = useMemo(() => {
    const logs = selectedRun?.logs ?? []
    const query = logQuery.trim().toLocaleLowerCase()
    return query ? logs.filter(line => line.toLocaleLowerCase().includes(query)) : logs
  }, [logQuery, selectedRun?.logs])
  const visibleLogs = filteredLogs.slice(0, 250)
  const logText = visibleLogs.join('\n')

  const copyText = async (value: string, key: string) => {
    if (!value) return
    if (!navigator.clipboard?.writeText) { setNotice({ kind: 'error', text: '当前环境不支持复制到剪贴板。' }); return }
    try {
      await navigator.clipboard.writeText(value)
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
      setCopiedKey(key)
      copyTimerRef.current = window.setTimeout(() => setCopiedKey(current => current === key ? null : current), 1500)
    } catch {
      setNotice({ kind: 'error', text: '复制失败，请检查浏览器剪贴板权限。' })
    }
  }

  return <section className="run-workspace">
    <header className="run-workspace-header">
      <div className="run-workspace-title"><span className="section-kicker">RUN WORKSPACE</span><h1>{selectedRun ? selectedRun.workflow?.workflowName ?? '历史运行' : '运行工作流'}</h1><p>{selectedRun ? <><span className="mono" title={selectedRun.id}>运行 {shortId(selectedRun.id)}</span> · {new Date(selectedRun.startedAt).toLocaleString('zh-CN')}</> : '选择已发布版本，提交需求，然后在独立 Worktree 中查看每一步。'}</p></div>
      {selectedRun && <button className="ghost-btn" onClick={() => setSelectedRunId(null)}><ArrowLeft aria-hidden="true" />新建运行</button>}
    </header>

    {notice && <div className={`run-notice ${notice.kind}`} role="status">{notice.kind === 'error' ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}<span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X aria-hidden="true" /></button></div>}

    {!selectedRun ? <div className="run-launcher">
      <RunHistoryRail runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
      <section className="run-launch-main">
        <div className="launcher-step"><span>01</span><div><h2>选择发布版本</h2><p>草稿不可运行。每次运行固定使用发布时的节点、连线和指令。</p></div></div>
        <div className="workflow-launch-list">{publishedWorkflows.length ? publishedWorkflows.map(workflow => {
          const published = latestPublished(workflow)!
          return <button className={`workflow-launch-option ${workflow.id === chosenWorkflow?.id ? 'selected' : ''}`} key={workflow.id} onClick={() => setWorkflowId(workflow.id)}><span className="workflow-launch-icon"><Waypoints aria-hidden="true" /></span><span><b>{published.definition.name}</b><small>v{published.revision} · 发布于 {new Date(published.publishedAt).toLocaleDateString('zh-CN')}</small></span><span className="workflow-launch-count">{published.definition.nodes.length} 节点</span></button>
        }) : <div className="launcher-empty"><FileCode2 aria-hidden="true" /><div><b>还没有已发布的工作流</b><span>先在工作流库中创建模板并发布一个版本。</span></div>{workflows[0] && <button className="ghost-btn" onClick={() => onEditWorkflow(workflows[0])}>编辑草稿</button>}</div>}</div>

        <div className="launcher-step"><span>02</span><div><h2>提交需求</h2><p>文字、文件和网页参考会被保存为此次运行的输入包。</p></div></div>
        <label className="run-requirement-label">需求<textarea value={text} onChange={event => setText(event.target.value)} placeholder="说明目标、范围、验收标准和已有约束…" maxLength={40000} /></label>
        <div className="run-attachment-tools"><button className="attachment-add" disabled={busy === 'attachments'} onClick={() => attachmentInputRef.current?.click()}><ImagePlus aria-hidden="true" />添加文件</button><div className="reference-input"><input value={referenceUrl} onChange={event => setReferenceUrl(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); attachReference() } }} placeholder="粘贴网页参考地址" /><button className="header-icon-button" title="添加网页参考" aria-label="添加网页参考" onClick={attachReference}><Send aria-hidden="true" /></button></div><input ref={attachmentInputRef} type="file" multiple hidden onChange={event => { if (event.target.files) void addFiles(event.target.files); event.currentTarget.value = '' }} /></div>
        {attachments.length > 0 && <div className="run-attachment-list">{attachments.map(attachment => <article key={attachment.id} className="run-attachment"><span>{attachment.preview ? <img src={attachment.preview} alt="" /> : attachment.sourceUrl ? <Waypoints aria-hidden="true" /> : <Paperclip aria-hidden="true" />}</span><div><b title={attachment.name}>{attachment.name}</b><small>{attachment.sourceUrl ? '网页参考' : `${attachment.mediaType} · ${formatBytes(attachment.byteLength)}`}</small></div><button aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments(current => current.filter(item => item.id !== attachment.id))}><X aria-hidden="true" /></button></article>)}</div>}
        <footer className="run-launch-footer"><span>{attachments.length}/{maxAttachmentCount} 附件 · 总计 {formatBytes(attachments.reduce((sum, item) => sum + item.byteLength, 0))}</span><button className="run-btn run-launch-button" disabled={busy === 'start' || !publishedWorkflows.length} onClick={() => void startRun()}>{busy === 'start' ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}开始运行</button></footer>
      </section>
    </div> : <>
      <RunMetricsStrip status={selectedRun.status} completedNodeCount={completedNodeCount} nodeCount={selectedRun.nodes.length} progress={runProgress} startedAt={selectedRun.startedAt} endedAt={selectedRun.endedAt} branchName={selectedRun.branchName} artifactCount={selectedRun.artifacts.length} />
      {selectedRun.status === 'awaiting_approval' && <section className="approval-banner" role="alert"><div className="approval-banner-icon"><AlertTriangle aria-hidden="true" /></div><div className="approval-banner-copy"><span className="section-kicker">HUMAN APPROVAL REQUIRED</span><b>{selectedRun.pendingCommandApproval ? '允许在隔离 Worktree 中执行此命令？' : '此运行正在等待人工审批。'}</b>{selectedRun.pendingCommandApproval ? <><code title={selectedRun.pendingCommandApproval.command.command}>$ {selectedRun.pendingCommandApproval.command.command}</code><small><span title={selectedRun.pendingCommandApproval.command.cwd}>cwd: {selectedRun.pendingCommandApproval.command.cwd}</span> · timeout {Math.round(selectedRun.pendingCommandApproval.command.timeoutMs / 1000)}s</small></> : <small>确认当前节点的产物后继续流程。</small>}</div><div className="approval-banner-actions"><button className="reject-btn" disabled={Boolean(busy)} onClick={() => void runAction('reject')}>拒绝</button><button className="approve-btn" disabled={Boolean(busy)} onClick={() => void runAction('approve')}>批准执行</button></div></section>}
      <div ref={runConsoleRef} className="run-console" data-resizing={panelResizing ?? undefined} style={{ '--run-history-width': `${runHistoryWidth}px`, '--run-context-width': `${runContextWidth}px` } as CSSProperties}>
        <RunHistoryRail runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} className="run-history-rail-active" panelId="run-history-panel" listId="run-history-list" panelRef={runHistoryRailRef} listRef={runHistoryListRef} listStyle={{ flexBasis: runHistoryHeight, maxHeight: runHistoryHeight }}>
          <button className="run-history-splitter" type="button" role="separator" aria-label="调整最近运行与当前步骤的高度" aria-orientation="horizontal" aria-controls="run-history-list run-steps-panel" aria-valuemin={minRunHistoryHeight} aria-valuemax={runPanelMaximums.historyHeight} aria-valuenow={Math.min(runHistoryHeight, runPanelMaximums.historyHeight)} title="拖动调整上下区域；双击恢复默认" onPointerDown={event => startRunPanelResize('history-height', event)} onPointerMove={resizeRunPanel} onPointerUp={finishRunPanelResize} onPointerCancel={finishRunPanelResize} onLostPointerCapture={finishRunPanelResize} onKeyDown={event => adjustRunPanelSize('history-height', event)} onDoubleClick={() => commitRunPanelSize('history-height', defaultRunHistoryHeight)} />
          <section id="run-steps-panel" className="run-history-steps" aria-label="当前运行步骤"><div className="run-console-rail-heading"><span className="section-kicker">STEPS</span><span className={`run-status-pill ${statusClass(selectedRun.status)}`}><i className="status-pill-dot" />{runStatusLabel(selectedRun.status)}</span></div><div className="run-node-list">{selectedRun.nodes.map((node, index) => <button key={node.id} className={`run-node-item ${node.id === selectedNode?.id ? 'selected' : ''}`} aria-current={node.id === selectedNode?.id ? 'step' : undefined} onClick={() => setSelectedNodeId(node.id)}><span className={`run-node-state ${statusClass(node.state)}`}>{index + 1}</span><span className="run-node-copy"><b title={node.id}>{node.id}</b><small>{stateLabel(node.state)} · {node.attempts.length} Attempt{node.attempts.length === 1 ? '' : 's'}</small><em title={node.outputType ?? 'artifact'}><Terminal aria-hidden="true" />{node.outputType ?? 'artifact'}</em></span></button>)}</div><div className="run-rail-actions">{isActive(selectedRun.status) && selectedRun.status !== 'paused' && <button className="ghost-btn" disabled={Boolean(busy)} onClick={() => void runAction('pause', selectedNode ? { nodeId: selectedNode.id } : {})}><CirclePause aria-hidden="true" />暂停</button>}{selectedRun.status === 'paused' && <button className="run-btn" disabled={Boolean(busy)} onClick={() => void runAction('resume')}><CirclePlay aria-hidden="true" />继续</button>}{!['succeeded', 'failed', 'cancelled'].includes(selectedRun.status) && <button className="danger-inline" disabled={Boolean(busy)} onClick={() => void runAction('cancel')}><Square aria-hidden="true" />取消</button>}</div></section>
        </RunHistoryRail>
        <button className="run-panel-resizer run-panel-resizer-left" type="button" role="separator" aria-label="调整运行历史栏宽度" aria-orientation="vertical" aria-controls="run-history-panel run-review-panel" aria-valuemin={minRunHistoryWidth} aria-valuemax={runPanelMaximums.historyWidth} aria-valuenow={Math.min(runHistoryWidth, runPanelMaximums.historyWidth)} title="拖动调整运行历史栏；双击恢复默认" onPointerDown={event => startRunPanelResize('history-width', event)} onPointerMove={resizeRunPanel} onPointerUp={finishRunPanelResize} onPointerCancel={finishRunPanelResize} onLostPointerCapture={finishRunPanelResize} onKeyDown={event => adjustRunPanelSize('history-width', event)} onDoubleClick={() => commitRunPanelSize('history-width', defaultRunHistoryWidth)} />
        <main id="run-review-panel" className="run-console-main"><header className="run-console-main-heading"><div><span className="section-kicker">{selectedNode?.kind ?? 'RUN'}</span><h2 title={selectedNode?.id}>{selectedNode?.id ?? '选择节点'}</h2><p title={selectedNode?.prompt}>{selectedNode?.prompt || '该节点没有单独的指令。'}</p>{selectedAttempt && <small className="run-attempt-context">Attempt {selectedAttempt.attempt} · {selectedAttempt.executorId} · {stateLabel(selectedAttempt.status)}</small>}</div><div className="run-console-tabs" role="tablist" aria-label="运行审查视图"><button id="run-tab-input" role="tab" aria-selected={tab === 'input'} aria-controls="run-tabpanel" className={tab === 'input' ? 'active' : ''} onClick={() => setTab('input')}>输入</button><button id="run-tab-activity" role="tab" aria-selected={tab === 'activity'} aria-controls="run-tabpanel" className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>活动 <span>{selectedEvents.length}</span></button><button id="run-tab-artifacts" role="tab" aria-selected={tab === 'artifacts'} aria-controls="run-tabpanel" className={tab === 'artifacts' ? 'active' : ''} onClick={() => setTab('artifacts')}>产物 <span>{selectedArtifacts.length}</span></button><button id="run-tab-diff" role="tab" aria-selected={tab === 'diff'} aria-controls="run-tabpanel" className={tab === 'diff' ? 'active' : ''} onClick={() => setTab('diff')} disabled={!selectedDiff}>Diff</button></div></header>
          <section id="run-tabpanel" className="run-console-content" role="tabpanel" aria-labelledby={`run-tab-${tab}`}>
            {tab === 'input' && <div className="run-input-inspector"><article><div className="code-surface-heading"><span>运行需求</span><button className="run-copy-button" title="复制运行需求" aria-label="复制运行需求" onClick={() => void copyText(selectedRun.input.text, 'input')}>{copiedKey === 'input' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button></div><pre>{selectedRun.input.text || '未提交文字需求。'}</pre></article><article><span>冻结附件</span>{selectedRun.input.attachments.length ? <div className="console-attachment-list">{selectedRun.input.attachments.map(attachment => <div key={attachment.id}><Paperclip aria-hidden="true" /><span title={attachment.name}>{attachment.name}</span><small>{attachment.sourceUrl ?? `${attachment.mediaType} · ${formatBytes(attachment.byteLength)}`}</small></div>)}</div> : <p>没有附件。</p>}</article>{selectedNode?.attempts.at(-1)?.inputArtifactIds?.length ? <article><span>本次 Attempt 使用的上游 Artifact</span><div className="artifact-id-list">{selectedNode.attempts.at(-1)?.inputArtifactIds?.map(id => <code key={id} title={id}>{id}</code>)}</div></article> : null}</div>}
            {tab === 'activity' && <div className="run-event-list">{selectedEvents.length ? selectedEvents.map(event => <article key={event.id} className={`run-event ${event.type}`}><span className="event-time">{new Date(event.occurredAt).toLocaleTimeString('zh-CN', { hour12: false })}</span><span className="event-type">{eventTypeLabel(event.type)}</span><div><b>{event.message}</b>{event.details && <pre>{Object.entries(event.details).map(([key, value]) => `${key}: ${String(value)}`).join('\n')}</pre>}</div></article>) : <p className="console-empty">该节点尚未产生可公开展示的活动。</p>}</div>}
            {tab === 'artifacts' && <div className="console-artifact-list">{selectedArtifacts.length ? selectedArtifacts.map(artifact => <button key={artifact.id} className={`console-artifact ${artifactPayload?.id === artifact.id ? 'selected' : ''}`} title={`${artifact.schemaId} v${artifact.schemaVersion}`} onClick={() => void openArtifact(artifact)}><span className="console-artifact-icon"><FileText aria-hidden="true" /></span><span><b>{artifact.type} v{artifact.version}</b><small>{artifact.schemaId} · {new Date(artifact.createdAt).toLocaleTimeString('zh-CN')}</small></span><em className={statusClass(artifact.status)}>{artifact.status}</em></button>) : <p className="console-empty">该节点尚未生成 Artifact。</p>}{artifactPayload && <div className="code-surface"><div className="code-surface-heading"><span>Artifact payload</span><button className="run-copy-button" title="复制产物内容" aria-label="复制产物内容" onClick={() => void copyText(artifactPayloadText, 'artifact')}>{copiedKey === 'artifact' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button></div><pre className="artifact-payload">{artifactPayloadText}</pre></div>}</div>}
            {tab === 'diff' && <div className="diff-panel">{selectedDiff ? <>{artifactPayload?.id !== selectedDiff.id && <button className="ghost-btn" onClick={() => void openArtifact(selectedDiff)}><FileCode2 aria-hidden="true" />读取代码 Diff</button>}{artifactPayload?.id === selectedDiff.id && <div className="code-surface"><div className="code-surface-heading"><span>代码 Diff</span><button className="run-copy-button" title="复制代码 Diff" aria-label="复制代码 Diff" onClick={() => void copyText(diffPayloadText, 'diff')}>{copiedKey === 'diff' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button></div><pre>{diffPayloadText}</pre></div>}</> : <p className="console-empty">此节点没有代码 Diff。代码 Agent 完成修改后会在这里生成可审核内容。</p>}</div>}
          </section>
        </main>
        <button className="run-panel-resizer run-panel-resizer-right" type="button" role="separator" aria-label="调整运行上下文栏宽度" aria-orientation="vertical" aria-controls="run-review-panel run-context-panel" aria-valuemin={minRunContextWidth} aria-valuemax={runPanelMaximums.contextWidth} aria-valuenow={Math.min(runContextWidth, runPanelMaximums.contextWidth)} title="拖动调整运行上下文栏；双击恢复默认" onPointerDown={event => startRunPanelResize('context-width', event)} onPointerMove={resizeRunPanel} onPointerUp={finishRunPanelResize} onPointerCancel={finishRunPanelResize} onLostPointerCapture={finishRunPanelResize} onKeyDown={event => adjustRunPanelSize('context-width', event)} onDoubleClick={() => commitRunPanelSize('context-width', defaultRunContextWidth)} />
        <aside id="run-context-panel" ref={runContextPanelRef} className="run-context-panel"><section><span className="section-kicker">RUN CONTEXT</span><dl><div><dt>运行 ID</dt><dd><code title={selectedRun.id}>{selectedRun.id}</code></dd></div><div><dt>工作流版本</dt><dd title={selectedRun.workflow ? `${selectedRun.workflow.workflowName} v${selectedRun.workflow.revision}` : '历史运行'}>{selectedRun.workflow ? `${selectedRun.workflow.workflowName} v${selectedRun.workflow.revision}` : '历史运行'}</dd></div><div><dt>Worktree</dt><dd>{selectedRun.worktreePath ? <div className="context-path"><code title={selectedRun.worktreePath}>{selectedRun.worktreePath}</code><button className="path-button" title="在 Finder 中显示 Worktree" aria-label="在 Finder 中显示 Worktree" onClick={() => void showWorktree()}><FolderOpen aria-hidden="true" /></button></div> : '准备中'}</dd></div><div><dt>Branch</dt><dd><code title={selectedRun.branchName ?? '—'}>{selectedRun.branchName ?? '—'}</code></dd></div></dl></section>
          {selectedRun.status === 'paused' && <section className="run-steering-card"><span className="section-kicker">STEER NEXT ATTEMPT</span><b>补充方向</b><textarea value={steeringNote} onChange={event => setSteeringNote(event.target.value)} placeholder="说明新的约束、优先级或希望 Agent 调整的方向…" maxLength={16000} /><div><button className="ghost-btn" disabled={!steeringNote.trim() || Boolean(busy)} onClick={() => void runAction('steer', { nodeId: selectedNode?.id ?? '', note: steeringNote })}>保存说明</button><button className="run-btn" disabled={Boolean(busy)} onClick={() => void runAction('resume')}>继续执行</button></div></section>}
          {['failed', 'cancelled'].includes(selectedRun.status) && selectedNode && <section className="run-retry-card"><b>从当前节点重试</b><p>会复用已有 Worktree 和有效产物，并为受影响节点创建新的 Attempt。</p><button className="ghost-btn" disabled={busy === 'retry'} onClick={() => void runAction('retry', { nodeId: selectedNode.id })}><RotateCcw aria-hidden="true" />从此节点重试</button></section>}
          <section className="run-log-card"><div className="code-surface-heading"><span className="section-kicker">RUN LOG</span><div className="run-log-actions"><label className="run-log-filter"><Search aria-hidden="true" /><input type="search" value={logQuery} onChange={event => setLogQuery(event.target.value)} placeholder="过滤日志" aria-label="过滤运行日志" />{logQuery && <button type="button" title="清除日志过滤" aria-label="清除日志过滤" onClick={() => setLogQuery('')}><X aria-hidden="true" /></button>}</label><button className="run-copy-button" title="复制当前日志" aria-label="复制当前日志" onClick={() => void copyText(filteredLogs.join('\n'), 'log')}>{copiedKey === 'log' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button></div></div><div className="run-log-summary"><span>{logQuery ? `${filteredLogs.length}/${selectedRun.logs.length}` : `${selectedRun.logs.length}`} 行</span>{filteredLogs.length > visibleLogs.length && <span>显示前 {visibleLogs.length} 行</span>}</div><pre>{logText || (selectedRun.logs.length ? '没有匹配的日志行。' : '暂无日志。')}</pre></section>
        </aside>
      </div>
    </>}
  </section>
}

function eventTypeLabel(type: RunEvent['type']) {
  return ({ 'run-created': '运行', 'run-state': '状态', 'node-state': '节点', command: '命令', executor: '执行器', artifact: '产物', operator: '操作员', activity: '活动', error: '错误' })[type]
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function payloadContent(payload: unknown) {
  if (payload && typeof payload === 'object' && 'content' in payload && typeof (payload as { content?: unknown }).content === 'string') return (payload as { content: string }).content
  return JSON.stringify(payload, null, 2)
}
