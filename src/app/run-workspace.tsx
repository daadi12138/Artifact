'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, CirclePause, CirclePlay, FileCode2, FileText, FolderOpen, ImagePlus, LoaderCircle, Paperclip, Play, RotateCcw, Send, Square, Waypoints, X } from 'lucide-react'
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

const maxAttachmentCount = 12
const maxAttachmentBytes = 8 * 1024 * 1024
const maxTotalAttachmentBytes = 24 * 1024 * 1024

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

export function RunWorkspace({ workflows, onEditWorkflow }: { workflows: WorkflowRecordView[]; onEditWorkflow: (workflow: WorkflowRecordView) => void }) {
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

  const publishedWorkflows = useMemo(() => workflows.filter(workflow => latestPublished(workflow)), [workflows])
  const selectedRun = useMemo(() => runs.find(run => run.id === selectedRunId) ?? null, [runs, selectedRunId])
  const selectedNode = useMemo(() => selectedRun?.nodes.find(node => node.id === selectedNodeId) ?? selectedRun?.nodes[0] ?? null, [selectedNodeId, selectedRun])
  const chosenWorkflow = useMemo(() => workflows.find(workflow => workflow.id === workflowId) ?? publishedWorkflows[0] ?? null, [publishedWorkflows, workflowId, workflows])

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

  return <section className="run-workspace">
    <header className="run-workspace-header">
      <div><span className="section-kicker">RUN WORKSPACE</span><h1>{selectedRun ? selectedRun.workflow?.workflowName ?? '历史运行' : '运行工作流'}</h1><p>{selectedRun ? `运行 ${shortId(selectedRun.id)} · ${new Date(selectedRun.startedAt).toLocaleString('zh-CN')}` : '选择已发布版本，提交需求，然后在独立 Worktree 中查看每一步。'}</p></div>
      {selectedRun && <button className="ghost-btn" onClick={() => setSelectedRunId(null)}><ArrowLeft aria-hidden="true" />新建运行</button>}
    </header>

    {notice && <div className={`run-notice ${notice.kind}`} role="status">{notice.kind === 'error' ? <AlertTriangle aria-hidden="true" /> : <Check aria-hidden="true" />}<span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}><X aria-hidden="true" /></button></div>}

    {!selectedRun ? <div className="run-launcher">
      <section className="run-launch-main">
        <div className="launcher-step"><span>01</span><div><h2>选择发布版本</h2><p>草稿不可运行。每次运行固定使用发布时的节点、连线和指令。</p></div></div>
        <div className="workflow-launch-list">{publishedWorkflows.length ? publishedWorkflows.map(workflow => {
          const published = latestPublished(workflow)!
          return <button className={`workflow-launch-option ${workflow.id === chosenWorkflow?.id ? 'selected' : ''}`} key={workflow.id} onClick={() => setWorkflowId(workflow.id)}><span className="workflow-launch-icon"><Waypoints aria-hidden="true" /></span><span><b>{published.definition.name}</b><small>v{published.revision} · 发布于 {new Date(published.publishedAt).toLocaleDateString('zh-CN')}</small></span><span className="workflow-launch-count">{published.definition.nodes.length} 节点</span></button>
        }) : <div className="launcher-empty"><FileCode2 aria-hidden="true" /><div><b>还没有已发布的工作流</b><span>先在工作流库中创建模板并发布一个版本。</span></div>{workflows[0] && <button className="ghost-btn" onClick={() => onEditWorkflow(workflows[0])}>编辑草稿</button>}</div>}</div>

        <div className="launcher-step"><span>02</span><div><h2>提交需求</h2><p>文字、文件和网页参考会被保存为此次运行的输入包。</p></div></div>
        <label className="run-requirement-label">需求<textarea value={text} onChange={event => setText(event.target.value)} placeholder="说明目标、范围、验收标准和已有约束…" maxLength={40000} /></label>
        <div className="run-attachment-tools"><button className="attachment-add" disabled={busy === 'attachments'} onClick={() => attachmentInputRef.current?.click()}><ImagePlus aria-hidden="true" />添加文件</button><div className="reference-input"><input value={referenceUrl} onChange={event => setReferenceUrl(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); attachReference() } }} placeholder="粘贴网页参考地址" /><button className="header-icon-button" title="添加网页参考" aria-label="添加网页参考" onClick={attachReference}><Send aria-hidden="true" /></button></div><input ref={attachmentInputRef} type="file" multiple hidden onChange={event => { if (event.target.files) void addFiles(event.target.files); event.currentTarget.value = '' }} /></div>
        {attachments.length > 0 && <div className="run-attachment-list">{attachments.map(attachment => <article key={attachment.id} className="run-attachment"><span>{attachment.preview ? <img src={attachment.preview} alt="" /> : attachment.sourceUrl ? <Waypoints aria-hidden="true" /> : <Paperclip aria-hidden="true" />}</span><div><b>{attachment.name}</b><small>{attachment.sourceUrl ? '网页参考' : `${attachment.mediaType} · ${formatBytes(attachment.byteLength)}`}</small></div><button aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments(current => current.filter(item => item.id !== attachment.id))}><X aria-hidden="true" /></button></article>)}</div>}
        <footer className="run-launch-footer"><span>{attachments.length}/{maxAttachmentCount} 附件 · 总计 {formatBytes(attachments.reduce((sum, item) => sum + item.byteLength, 0))}</span><button className="run-btn run-launch-button" disabled={busy === 'start' || !publishedWorkflows.length} onClick={() => void startRun()}>{busy === 'start' ? <LoaderCircle className="spin" aria-hidden="true" /> : <Play aria-hidden="true" />}开始运行</button></footer>
      </section>
      <aside className="run-history-rail"><div><span className="section-kicker">RECENT</span><h2>最近运行</h2></div>{runs.length ? runs.slice(0, 8).map(run => <button key={run.id} className="recent-run" onClick={() => setSelectedRunId(run.id)}><span className={`recent-run-dot ${statusClass(run.status)}`} /><span><b>{run.workflow?.workflowName ?? shortId(run.id)}</b><small>{runStatusLabel(run.status)} · {new Date(run.startedAt).toLocaleString('zh-CN')}</small></span></button>) : <p>运行后，这里会保留最近记录。</p>}</aside>
    </div> : <div className="run-console">
      <aside className="run-node-rail"><div className="run-console-rail-heading"><span className="section-kicker">NODES</span><span className={`run-status-pill ${statusClass(selectedRun.status)}`}>{runStatusLabel(selectedRun.status)}</span></div><div className="run-node-list">{selectedRun.nodes.map((node, index) => <button key={node.id} className={`run-node-item ${node.id === selectedNode?.id ? 'selected' : ''}`} onClick={() => setSelectedNodeId(node.id)}><span className={`run-node-state ${statusClass(node.state)}`}>{index + 1}</span><span><b>{node.id}</b><small>{stateLabel(node.state)} · {node.attempts.length} Attempt{node.attempts.length === 1 ? '' : 's'}</small></span></button>)}</div><div className="run-rail-actions">{isActive(selectedRun.status) && selectedRun.status !== 'paused' && <button className="ghost-btn" disabled={Boolean(busy)} onClick={() => void runAction('pause', selectedNode ? { nodeId: selectedNode.id } : {})}><CirclePause aria-hidden="true" />暂停</button>}{selectedRun.status === 'paused' && <button className="run-btn" disabled={Boolean(busy)} onClick={() => void runAction('resume')}><CirclePlay aria-hidden="true" />继续</button>}{!['succeeded', 'failed', 'cancelled'].includes(selectedRun.status) && <button className="danger-inline" disabled={Boolean(busy)} onClick={() => void runAction('cancel')}><Square aria-hidden="true" />取消</button>}</div></aside>
      <main className="run-console-main"><header className="run-console-main-heading"><div><span className="section-kicker">{selectedNode?.kind ?? 'RUN'}</span><h2>{selectedNode?.id ?? '选择节点'}</h2><p>{selectedNode?.prompt || '该节点没有单独的指令。'}</p></div><div className="run-console-tabs" role="tablist"><button className={tab === 'input' ? 'active' : ''} onClick={() => setTab('input')}>输入</button><button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>活动 <span>{selectedEvents.length}</span></button><button className={tab === 'artifacts' ? 'active' : ''} onClick={() => setTab('artifacts')}>产物 <span>{selectedArtifacts.length}</span></button><button className={tab === 'diff' ? 'active' : ''} onClick={() => setTab('diff')} disabled={!selectedDiff}>Diff</button></div></header>
        <section className="run-console-content">
          {tab === 'input' && <div className="run-input-inspector"><article><span>运行需求</span><pre>{selectedRun.input.text || '未提交文字需求。'}</pre></article><article><span>冻结附件</span>{selectedRun.input.attachments.length ? <div className="console-attachment-list">{selectedRun.input.attachments.map(attachment => <div key={attachment.id}><Paperclip aria-hidden="true" /><span>{attachment.name}</span><small>{attachment.sourceUrl ?? `${attachment.mediaType} · ${formatBytes(attachment.byteLength)}`}</small></div>)}</div> : <p>没有附件。</p>}</article>{selectedNode?.attempts.at(-1)?.inputArtifactIds?.length ? <article><span>本次 Attempt 使用的上游 Artifact</span><div className="artifact-id-list">{selectedNode.attempts.at(-1)?.inputArtifactIds?.map(id => <code key={id}>{id}</code>)}</div></article> : null}</div>}
          {tab === 'activity' && <div className="run-event-list">{selectedEvents.length ? selectedEvents.map(event => <article key={event.id} className={`run-event ${event.type}`}><span className="event-time">{new Date(event.occurredAt).toLocaleTimeString('zh-CN', { hour12: false })}</span><span className="event-type">{eventTypeLabel(event.type)}</span><div><b>{event.message}</b>{event.details && <pre>{Object.entries(event.details).map(([key, value]) => `${key}: ${String(value)}`).join('\n')}</pre>}</div></article>) : <p className="console-empty">该节点尚未产生可公开展示的活动。</p>}</div>}
          {tab === 'artifacts' && <div className="console-artifact-list">{selectedArtifacts.length ? selectedArtifacts.map(artifact => <button key={artifact.id} className={`console-artifact ${artifactPayload?.id === artifact.id ? 'selected' : ''}`} onClick={() => void openArtifact(artifact)}><span className="console-artifact-icon"><FileText aria-hidden="true" /></span><span><b>{artifact.type} v{artifact.version}</b><small>{artifact.schemaId} · {new Date(artifact.createdAt).toLocaleTimeString('zh-CN')}</small></span><em className={statusClass(artifact.status)}>{artifact.status}</em></button>) : <p className="console-empty">该节点尚未生成 Artifact。</p>}{artifactPayload && <pre className="artifact-payload">{JSON.stringify(artifactPayload.payload, null, 2)}</pre>}</div>}
          {tab === 'diff' && <div className="diff-panel">{selectedDiff ? <>{artifactPayload?.id !== selectedDiff.id && <button className="ghost-btn" onClick={() => void openArtifact(selectedDiff)}><FileCode2 aria-hidden="true" />读取代码 Diff</button>}{artifactPayload?.id === selectedDiff.id && <pre>{payloadContent(artifactPayload.payload)}</pre>}</> : <p className="console-empty">此节点没有代码 Diff。代码 Agent 完成修改后会在这里生成可审核内容。</p>}</div>}
        </section>
      </main>
      <aside className="run-context-panel"><section><span className="section-kicker">RUN CONTEXT</span><dl><div><dt>工作流版本</dt><dd>{selectedRun.workflow ? `${selectedRun.workflow.workflowName} v${selectedRun.workflow.revision}` : '历史运行'}</dd></div><div><dt>Worktree</dt><dd>{selectedRun.worktreePath ? <button className="path-button" onClick={() => void showWorktree()}><FolderOpen aria-hidden="true" />在 Finder 中显示</button> : '准备中'}</dd></div><div><dt>Branch</dt><dd><code>{selectedRun.branchName ?? '—'}</code></dd></div></dl></section>
        {selectedRun.status === 'awaiting_approval' && <section className="run-approval-card"><span className="section-kicker">APPROVAL REQUIRED</span>{selectedRun.pendingCommandApproval ? <><b>允许验证命令？</b><code>{selectedRun.pendingCommandApproval.command.command}</code><p>只会在隔离 Worktree 中执行；允许后会记为该项目的默认授权。</p></> : <><b>等待人工审批</b><p>确认当前节点的产物后继续流程。</p></>}<div><button className="reject-btn" disabled={Boolean(busy)} onClick={() => void runAction('reject')}>拒绝</button><button className="approve-btn" disabled={Boolean(busy)} onClick={() => void runAction('approve')}>允许并继续</button></div></section>}
        {selectedRun.status === 'paused' && <section className="run-steering-card"><span className="section-kicker">STEER NEXT ATTEMPT</span><b>补充方向</b><textarea value={steeringNote} onChange={event => setSteeringNote(event.target.value)} placeholder="说明新的约束、优先级或希望 Agent 调整的方向…" maxLength={16000} /><div><button className="ghost-btn" disabled={!steeringNote.trim() || Boolean(busy)} onClick={() => void runAction('steer', { nodeId: selectedNode?.id ?? '', note: steeringNote })}>保存说明</button><button className="run-btn" disabled={Boolean(busy)} onClick={() => void runAction('resume')}>继续执行</button></div></section>}
        {['failed', 'cancelled'].includes(selectedRun.status) && selectedNode && <section className="run-retry-card"><b>从当前节点重试</b><p>会复用已有 Worktree 和有效产物，并为受影响节点创建新的 Attempt。</p><button className="ghost-btn" disabled={busy === 'retry'} onClick={() => void runAction('retry', { nodeId: selectedNode.id })}><RotateCcw aria-hidden="true" />从此节点重试</button></section>}
        <section className="run-log-card"><span className="section-kicker">RUN LOG</span><pre>{selectedRun.logs.slice(0, 12).join('\n')}</pre></section>
      </aside>
    </div>}
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
