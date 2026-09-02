'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, ArrowRight, ChevronDown, Columns2, ExternalLink, FileCode2, FileText, Folder, FolderOpen, Globe2, LoaderCircle, Pencil, RefreshCcw, RotateCw, Save, Search, Shield, SquareTerminal, StopCircle, Trash2, Eye } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type WorkbenchMode = 'documents' | 'terminal'
export type ArtifactWorkbenchTarget = { runId: string; artifactId: string }

type ArtifactMetadata = {
  id: string
  nodeId: string
  type: string
  version?: number
  schemaId?: string
  schemaVersion?: number
  status: string
  contentHash: string
  createdAt: string
  inputArtifactIds?: string[]
  runId: string
  runStartedAt: string
  workflowName: string
}

type RunSummary = {
  id: string
  startedAt: string
  workflow?: { workflowName?: string }
  artifacts?: Array<Omit<ArtifactMetadata, 'runId' | 'runStartedAt' | 'workflowName'>>
}

type DocumentDraft = {
  payload: Record<string, unknown>
  summary: string
  content: string
  originalSummary: string
  originalContent: string
}

type EmbeddedBrowserState = {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  error: string | null
}

const modeItems = [
  { id: 'documents' as const, label: '文档', icon: FileText },
  { id: 'terminal' as const, label: '终端', icon: SquareTerminal },
]

const emptyBrowserState: EmbeddedBrowserState = {
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  error: null,
}

function artifactKey(artifact: Pick<ArtifactMetadata, 'runId' | 'id'>): string {
  return `${artifact.runId}:${artifact.id}`
}

function targetKey(target: ArtifactWorkbenchTarget): string {
  return `${target.runId}:${target.artifactId}`
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function shortened(value: string, length = 12): string {
  return value.length > length ? value.slice(0, length) : value
}

export function Workbench(props: {
  mode: WorkbenchMode
  onModeChange: (mode: WorkbenchMode) => void
  projectPath?: string
  target?: ArtifactWorkbenchTarget | null
  browserOpen: boolean
  onBrowserOpenChange: (open: boolean) => void
}) {
  const activeItem = modeItems.find(item => item.id === props.mode) ?? modeItems[0]
  const ActiveIcon = activeItem.icon

  return <section className="workbench-root" aria-label="输出物工作台">
    <header className="workbench-modebar">
      <div className="workbench-mode-title"><ActiveIcon aria-hidden="true" /><div><b>{activeItem.label}</b><small>{props.mode === 'documents' ? '项目文件编辑与预览' : '当前项目交互式 Shell'}</small></div></div>
      <div className="workbench-mode-switch" role="tablist" aria-label="工作台工具">
        {modeItems.map(item => { const Icon = item.icon; return <button key={item.id} type="button" role="tab" aria-selected={props.mode === item.id} className={props.mode === item.id ? 'active' : ''} onClick={() => props.onModeChange(item.id)} title={item.label}><Icon aria-hidden="true" /><span>{item.label}</span></button> })}
        <button type="button" role="switch" aria-checked={props.browserOpen} className={props.browserOpen ? 'active browser-toggle' : 'browser-toggle'} onClick={() => props.onBrowserOpenChange(!props.browserOpen)} title="在右侧打开浏览器"><Globe2 aria-hidden="true" /><span>浏览器</span></button>
      </div>
    </header>
    <div className="workbench-stage">
      <div className={`workbench-main ${props.browserOpen ? 'with-browser' : ''}`}>
        <div className={`workbench-primary-panel document-workbench ${props.mode === 'documents' ? 'active' : ''}`} aria-hidden={props.mode !== 'documents'}>
          <DocumentWorkbench projectPath={props.projectPath} target={props.target} />
        </div>
        <div className={`workbench-primary-panel terminal-workbench ${props.mode === 'terminal' ? 'active' : ''}`} aria-hidden={props.mode !== 'terminal'}>
          <TerminalWorkbench active={props.mode === 'terminal'} projectPath={props.projectPath} />
        </div>
        {props.browserOpen && <aside className="workbench-browser-panel" aria-label="右侧浏览器"><BrowserWorkbench active /></aside>}
      </div>
    </div>
  </section>
}

type ProjectFileEntry = { path: string; size: number; modifiedAt: string; binary: boolean }

function formatBytes(size: number): string {
  if (size < 1_024) return `${size} B`
  if (size < 1_024 * 1_024) return `${Math.round(size / 1_024)} KB`
  return `${(size / (1_024 * 1_024)).toFixed(1)} MB`
}

function fileIcon(path: string) {
  return /(^|\/)(README|CHANGELOG|LICENSE)(\.|$)/i.test(path) || /\.(md|mdx|txt)$/i.test(path) ? FileText : FileCode2
}

function ProjectFileWorkbench({ projectPath }: { projectPath?: string }) {
  const [files, setFiles] = useState<ProjectFileEntry[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [viewMode, setViewMode] = useState<'edit' | 'split' | 'preview'>('split')
  const loadFiles = useCallback(async () => {
    try {
      const response = await fetch('/api/project/files')
      const result = await response.json() as { files?: ProjectFileEntry[]; error?: string }
      if (!response.ok || !result.files) throw new Error(result.error ?? '无法读取项目文件。')
      setFiles(result.files)
      setSelectedPath(current => current && result.files!.some(file => file.path === current) ? current : result.files![0]?.path ?? null)
    } catch (error) {
      setFiles([])
      setSelectedPath(null)
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '无法读取项目文件。' })
    }
  }, [])

  useEffect(() => { void loadFiles() }, [loadFiles, projectPath])

  const filteredFiles = useMemo(() => {
    const term = query.trim().toLowerCase()
    return term ? files.filter(file => file.path.toLowerCase().includes(term)) : files
  }, [files, query])
  const selected = files.find(file => file.path === selectedPath) ?? null
  const dirty = loadState === 'ready' && content !== originalContent
  const markdown = Boolean(selected && /\.(md|mdx)$/i.test(selected.path))

  useEffect(() => {
    if (!selectedPath) { setLoadState('ready'); setContent(''); setOriginalContent(''); return }
    const controller = new AbortController()
    setLoadState('loading')
    setNotice(null)
    void fetch(`/api/project/files?path=${encodeURIComponent(selectedPath)}`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json() as { content?: string; error?: string }
        if (!response.ok || typeof result.content !== 'string') throw new Error(result.error ?? '无法读取文件内容。')
        setContent(result.content)
        setOriginalContent(result.content)
        setLoadState('ready')
      })
      .catch(error => {
        if (controller.signal.aborted) return
        setLoadState('error')
        setContent('')
        setOriginalContent('')
        setNotice({ tone: 'error', text: error instanceof Error ? error.message : '无法读取文件内容。' })
      })
    return () => controller.abort()
  }, [selectedPath])

  const save = async () => {
    if (!selected || !dirty || saving) return
    setSaving(true)
    setNotice(null)
    try {
      const response = await fetch('/api/project/files', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: selected.path, content }) })
      const result = await response.json() as { file?: ProjectFileEntry; error?: string }
      if (!response.ok || !result.file) throw new Error(result.error ?? '保存文件失败。')
      setFiles(current => current.map(file => file.path === selected.path ? result.file! : file))
      setOriginalContent(content)
      setNotice({ tone: 'success', text: '文件已保存到当前项目。' })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '保存文件失败。' })
    } finally { setSaving(false) }
  }

  const grouped = useMemo(() => {
    const groups = new Map<string, ProjectFileEntry[]>()
    filteredFiles.forEach(file => {
      const root = file.path.split('/')[0] ?? file.path
      const group = groups.get(root) ?? []
      group.push(file)
      groups.set(root, group)
    })
    return [...groups.entries()]
  }, [filteredFiles])

  return <div className="project-file-workbench">
    <aside className="project-file-rail" aria-label="项目文件">
      <div className="project-file-heading"><div><b>项目文件</b><span>{files.length}</span></div><small>{projectPath ? '当前项目目录' : '请先导入项目'}</small></div>
      <label className="workbench-search"><Search aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文件" aria-label="搜索项目文件" /></label>
      <div className="project-file-list">
        {grouped.map(([root, group]) => <div className="project-file-group" key={root}>
          {group.length > 1 && <div className="project-file-group-heading"><ChevronDown aria-hidden="true" /><FolderOpen aria-hidden="true" /><b>{root}</b><span>{group.length}</span></div>}
          {group.map(file => { const Icon = fileIcon(file.path); return <button key={file.path} type="button" className={file.path === selectedPath ? 'active' : ''} disabled={file.binary} onClick={() => setSelectedPath(file.path)} title={file.binary ? '二进制文件不可编辑' : file.path}><Icon aria-hidden="true" /><span>{file.path}</span><small>{formatBytes(file.size)}</small></button> })}
        </div>)}
        {!grouped.length && <div className="workbench-list-empty">{files.length ? '没有匹配文件' : '暂无项目文件'}</div>}
      </div>
    </aside>
    <main className="project-file-editor-shell">
      {!selected ? <div className="workbench-empty"><Folder aria-hidden="true" /><b>暂无项目文件</b><span>导入项目后，文件内容会显示在右侧。</span></div> : <>
        <header className="document-toolbar">
          <div className="project-file-identity"><FileCode2 aria-hidden="true" /><code title={selected.path}>{selected.path}</code>{dirty && <i title="有未保存修改" />}</div>
          <div className="document-toolbar-actions">
            <div className="document-view-switch" role="tablist" aria-label="文件视图"><button type="button" role="tab" aria-selected={viewMode === 'edit'} className={viewMode === 'edit' ? 'active' : ''} onClick={() => setViewMode('edit')} title="编辑"><Pencil aria-hidden="true" /><span>编辑</span></button><button type="button" role="tab" aria-selected={viewMode === 'split'} className={viewMode === 'split' ? 'active' : ''} onClick={() => setViewMode('split')} title="编辑与预览"><Columns2 aria-hidden="true" /><span>分栏</span></button><button type="button" role="tab" aria-selected={viewMode === 'preview'} className={viewMode === 'preview' ? 'active' : ''} onClick={() => setViewMode('preview')} title="预览"><Eye aria-hidden="true" /><span>预览</span></button></div>
            <button className="workbench-primary-button" type="button" disabled={!dirty || saving} onClick={() => void save()} title="保存文件">{saving ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}<span>{saving ? '保存中' : '保存'}</span></button>
          </div>
        </header>
        {notice && <div className={`workbench-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
        {loadState === 'loading' ? <div className="workbench-loading"><LoaderCircle className="spin" aria-hidden="true" />正在读取文件</div> : loadState === 'error' ? <div className="workbench-empty"><FileText aria-hidden="true" /><b>文件无法打开</b><span>请从左侧选择其他文件。</span></div> : <div className={`file-content-surface mode-${viewMode}`}>
          {viewMode !== 'preview' && <section className="file-editor-pane"><div className="document-pane-label"><span>文件内容</span><small>{content.length.toLocaleString('zh-CN')} 字符</small></div><textarea value={content} onChange={event => setContent(event.target.value)} spellCheck={false} aria-label="文件内容" /></section>}
          {viewMode !== 'edit' && <section className="file-preview-pane"><div className="document-pane-label"><span>{markdown ? 'Markdown 预览' : '内容预览'}</span><small>{dirty ? '未保存修改' : '当前文件'}</small></div>{markdown ? <article className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></article> : <pre className="file-text-preview">{content}</pre>}</section>}
        </div>}
      </>}
    </main>
  </div>
}

function DocumentWorkbench({ projectPath, target }: { projectPath?: string; target?: ArtifactWorkbenchTarget | null }) {
  const [source, setSource] = useState<'files' | 'artifacts'>(target ? 'artifacts' : 'files')
  useEffect(() => { if (target) setSource('artifacts') }, [target?.artifactId, target?.runId])
  if (source === 'artifacts') return <div className="artifact-editor-mode"><button className="document-source-back" type="button" onClick={() => setSource('files')}><ArrowLeft aria-hidden="true" />返回项目文件</button><ArtifactWorkbench target={target} /></div>
  return <ProjectFileWorkbench projectPath={projectPath} />
}

function ArtifactWorkbench({ target }: { target?: ArtifactWorkbenchTarget | null }) {
  const [artifacts, setArtifacts] = useState<ArtifactMetadata[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(target ? targetKey(target) : null)
  const [query, setQuery] = useState('')
  const [viewMode, setViewMode] = useState<'edit' | 'split' | 'preview'>('split')
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null)
  const [summary, setSummary] = useState('')
  const [content, setContent] = useState('')
  const [originalSummary, setOriginalSummary] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const draftsRef = useRef(new Map<string, DocumentDraft>())

  const loadArtifacts = useCallback(async () => {
    try {
      const response = await fetch('/api/runs')
      if (!response.ok) throw new Error('无法读取 Artifact 列表。')
      const runs = await response.json() as RunSummary[]
      const next = runs.flatMap(run => (run.artifacts ?? []).map(artifact => ({
        ...artifact,
        runId: run.id,
        runStartedAt: run.startedAt,
        workflowName: run.workflow?.workflowName ?? '历史运行',
      }))).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      setArtifacts(next)
      setSelectedKey(current => current && next.some(item => artifactKey(item) === current) ? current : next[0] ? artifactKey(next[0]) : null)
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '无法读取 Artifact 列表。' })
      setArtifacts([])
    }
  }, [])

  useEffect(() => { void loadArtifacts() }, [loadArtifacts])
  useEffect(() => { if (target) setSelectedKey(targetKey(target)) }, [target?.artifactId, target?.runId])

  const selected = useMemo(() => artifacts.find(artifact => artifactKey(artifact) === selectedKey) ?? null, [artifacts, selectedKey])
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return artifacts
    return artifacts.filter(artifact => [artifact.type, artifact.nodeId, artifact.workflowName, artifact.runId].some(value => value.toLowerCase().includes(term)))
  }, [artifacts, query])
  const dirty = loadState === 'ready' && (summary !== originalSummary || content !== originalContent)

  useEffect(() => {
    if (!selectedKey) { setPayload(null); setLoadState('ready'); return }
    const cached = draftsRef.current.get(selectedKey)
    if (cached) {
      setPayload(cached.payload)
      setSummary(cached.summary)
      setContent(cached.content)
      setOriginalSummary(cached.originalSummary)
      setOriginalContent(cached.originalContent)
      setLoadState('ready')
      return
    }
    if (!selected) return
    const controller = new AbortController()
    setLoadState('loading')
    setNotice(null)
    void fetch(`/api/runs/${selected.runId}/artifacts/${selected.id}`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('无法读取此 Artifact。')
        const value = recordValue(await response.json())
        if (!value) throw new Error('此 Artifact 不是可编辑的文档对象。')
        const nextSummary = typeof value.summary === 'string' ? value.summary : ''
        const nextContent = typeof value.content === 'string' ? value.content : JSON.stringify(value, null, 2)
        const draft = { payload: value, summary: nextSummary, content: nextContent, originalSummary: nextSummary, originalContent: nextContent }
        draftsRef.current.set(selectedKey, draft)
        setPayload(value)
        setSummary(nextSummary)
        setContent(nextContent)
        setOriginalSummary(nextSummary)
        setOriginalContent(nextContent)
        setLoadState('ready')
      })
      .catch(error => {
        if (controller.signal.aborted) return
        setPayload(null)
        setLoadState('error')
        setNotice({ tone: 'error', text: error instanceof Error ? error.message : '无法读取此 Artifact。' })
      })
    return () => controller.abort()
  }, [selected, selectedKey])

  useEffect(() => {
    if (!selectedKey || !payload || loadState !== 'ready') return
    draftsRef.current.set(selectedKey, { payload, summary, content, originalSummary, originalContent })
  }, [content, loadState, originalContent, originalSummary, payload, selectedKey, summary])

  const save = async () => {
    if (!selected || !selectedKey || !payload || saving) return
    if (!summary.trim() || !content.trim()) {
      setNotice({ tone: 'error', text: '摘要和正文不能为空。' })
      return
    }
    setSaving(true)
    setNotice(null)
    const nextPayload = { ...payload, summary: summary.trim(), content }
    try {
      const response = await fetch(`/api/runs/${selected.runId}/artifacts/${selected.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: nextPayload }),
      })
      const result = await response.json() as { artifact?: Omit<ArtifactMetadata, 'runId' | 'runStartedAt' | 'workflowName'>; error?: string }
      if (!response.ok || !result.artifact) throw new Error(result.error ?? '保存 Artifact 失败。')
      const revised: ArtifactMetadata = {
        ...result.artifact,
        runId: selected.runId,
        runStartedAt: selected.runStartedAt,
        workflowName: selected.workflowName,
      }
      const revisedKey = artifactKey(revised)
      draftsRef.current.delete(selectedKey)
      draftsRef.current.set(revisedKey, { payload: nextPayload, summary: nextPayload.summary, content, originalSummary: nextPayload.summary, originalContent: content })
      setArtifacts(current => [revised, ...current.filter(item => artifactKey(item) !== revisedKey)].sort((left, right) => right.createdAt.localeCompare(left.createdAt)))
      setSelectedKey(revisedKey)
      setPayload(nextPayload)
      setSummary(nextPayload.summary)
      setOriginalSummary(nextPayload.summary)
      setOriginalContent(content)
      setNotice({ tone: 'success', text: `已创建 ${revised.type} v${revised.version ?? 1}，原版本保持不变。` })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : '保存 Artifact 失败。' })
    } finally {
      setSaving(false)
    }
  }

  return <div className="document-workbench-layout">
    <aside className="document-artifact-rail" aria-label="Artifact 文档列表">
      <div className="artifact-rail-heading"><div><b>输出物</b><span>{artifacts.length}</span></div><small>按修改时间排序</small></div>
      <label className="workbench-search"><Search aria-hidden="true" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索类型、节点或运行" aria-label="搜索 Artifact" /></label>
      <div className="artifact-document-list">
        {filtered.map(artifact => {
          const key = artifactKey(artifact)
          const cached = draftsRef.current.get(key)
          const itemDirty = cached && (cached.summary !== cached.originalSummary || cached.content !== cached.originalContent)
          return <button key={key} type="button" className={key === selectedKey ? 'active' : ''} onClick={() => setSelectedKey(key)}>
            <span className="artifact-document-icon"><FileText aria-hidden="true" /></span>
            <span className="artifact-document-copy"><b title={artifact.type}>{artifact.type}</b><small title={artifact.workflowName}>{artifact.workflowName} · {artifact.nodeId}</small></span>
            <span className="artifact-document-version">v{artifact.version ?? 1}{itemDirty ? <i title="有未保存修改" /> : null}</span>
          </button>
        })}
        {!filtered.length && <div className="workbench-list-empty">{artifacts.length ? '没有匹配的文档' : '暂无 Artifact 文档'}</div>}
      </div>
    </aside>
    <main className="document-editor-shell">
      {!selected ? <div className="workbench-empty"><FileText aria-hidden="true" /><b>暂无可编辑文档</b><span>运行工作流生成 Artifact 后会显示在这里。</span></div> : <>
        <header className="document-toolbar">
          <div className="document-identity"><span>{selected.type}</span><b>v{selected.version ?? 1}</b><code title={selected.id}>{shortened(selected.id, 18)}</code></div>
          <div className="document-toolbar-actions">
            <div className="document-view-switch" role="tablist" aria-label="文档视图">
              <button type="button" role="tab" aria-selected={viewMode === 'edit'} className={viewMode === 'edit' ? 'active' : ''} onClick={() => setViewMode('edit')} title="编辑"><Pencil aria-hidden="true" /><span>编辑</span></button>
              <button type="button" role="tab" aria-selected={viewMode === 'split'} className={viewMode === 'split' ? 'active' : ''} onClick={() => setViewMode('split')} title="分栏"><Columns2 aria-hidden="true" /><span>分栏</span></button>
              <button type="button" role="tab" aria-selected={viewMode === 'preview'} className={viewMode === 'preview' ? 'active' : ''} onClick={() => setViewMode('preview')} title="预览"><Eye aria-hidden="true" /><span>预览</span></button>
            </div>
            <button className="workbench-primary-button" type="button" disabled={!dirty || saving || !summary.trim() || !content.trim()} onClick={() => void save()} title="保存为新 Artifact 版本">{saving ? <LoaderCircle className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />}<span>{saving ? '保存中' : '保存新版本'}</span></button>
          </div>
        </header>
        <label className="document-summary-field"><span>摘要</span><input value={summary} onChange={event => setSummary(event.target.value)} disabled={loadState !== 'ready'} placeholder="文档摘要" /></label>
        {notice && <div className={`workbench-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</div>}
        {loadState === 'loading' ? <div className="workbench-loading"><LoaderCircle className="spin" aria-hidden="true" />正在读取文档</div> : loadState === 'error' ? <div className="workbench-empty"><FileText aria-hidden="true" /><b>文档无法打开</b><span>请从左侧选择其他 Artifact。</span></div> : <div className={`document-surface mode-${viewMode}`}>
          {viewMode !== 'preview' && <section className="markdown-editor-pane"><div className="document-pane-label"><span>MARKDOWN</span><small>{content.length.toLocaleString('zh-CN')} 字符</small></div><textarea value={content} onChange={event => setContent(event.target.value)} spellCheck={false} aria-label="Markdown 正文" /></section>}
          {viewMode !== 'edit' && <section className="markdown-preview-pane"><div className="document-pane-label"><span>预览</span><small>{dirty ? '未保存修改' : '当前版本'}</small></div><article className="markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></article></section>}
        </div>}
      </>}
    </main>
  </div>
}

function TerminalWorkbench({ active, projectPath }: { active: boolean; projectPath?: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)
  const sessionInfoRef = useRef<{ cwd: string; shell: string } | null>(null)
  const pendingDataRef = useRef(new Map<string, string>())
  const startingRef = useRef(false)
  const startGenerationRef = useRef(0)
  const disposedRef = useRef(false)
  const activeRef = useRef(active)
  const projectPathRef = useRef(projectPath)
  const [terminalReady, setTerminalReady] = useState(false)
  const [environmentChecked, setEnvironmentChecked] = useState(false)
  const [sessionInfo, setSessionInfo] = useState<{ cwd: string; shell: string } | null>(null)
  const [status, setStatus] = useState<'idle' | 'starting' | 'running' | 'exited' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  projectPathRef.current = projectPath
  activeRef.current = active

  const fitTerminal = useCallback(() => {
    if (!activeRef.current || !terminalRef.current || !fitRef.current || !containerRef.current) return
    const bounds = containerRef.current.getBoundingClientRect()
    if (bounds.width < 40 || bounds.height < 40) return
    try { fitRef.current.fit() } catch { /* The terminal can be between layout frames. */ }
  }, [])

  const startTerminal = useCallback(async (clear = false) => {
    const desktop = window.artifactDesktop
    const terminal = terminalRef.current
    if (!desktop || !terminal || startingRef.current || disposedRef.current) return
    const generation = ++startGenerationRef.current
    startingRef.current = true
    setStatus('starting')
    setError(null)
    const previous = sessionRef.current
    sessionRef.current = null
    sessionInfoRef.current = null
    setSessionInfo(null)
    if (previous) await desktop.closeTerminal(previous).catch(() => ({ ok: false }))
    if (disposedRef.current || generation !== startGenerationRef.current || !activeRef.current) {
      if (generation === startGenerationRef.current) startingRef.current = false
      return
    }
    if (clear) terminal.clear()
    try {
      const info = await desktop.createTerminal(projectPathRef.current)
      if (disposedRef.current || generation !== startGenerationRef.current || !activeRef.current) {
        if (info.ok) await desktop.closeTerminal(info.sessionId).catch(() => ({ ok: false }))
        return
      }
      if (!info.ok) {
        setStatus('error')
        setError(info.error)
        return
      }
      sessionRef.current = info.sessionId
      sessionInfoRef.current = { cwd: info.cwd, shell: info.shell }
      setSessionInfo({ cwd: info.cwd, shell: info.shell })
      setStatus('running')
      const buffered = pendingDataRef.current.get(info.sessionId)
      if (buffered) { terminal.write(buffered); pendingDataRef.current.delete(info.sessionId) }
      window.requestAnimationFrame(fitTerminal)
    } catch (caught) {
      if (!disposedRef.current && generation === startGenerationRef.current && activeRef.current) {
        setStatus('error')
        setError(caught instanceof Error ? caught.message : '无法启动终端。')
      }
    } finally {
      if (generation === startGenerationRef.current) startingRef.current = false
    }
  }, [fitTerminal])

  useEffect(() => {
    disposedRef.current = false
    setEnvironmentChecked(true)
    const desktop = window.artifactDesktop
    if (!desktop || !containerRef.current) return
    let inputDisposable: { dispose: () => void } | null = null
    let resizeDisposable: { dispose: () => void } | null = null
    let observer: ResizeObserver | null = null
    const unsubscribeData = desktop.onTerminalData(event => {
      if (event.sessionId === sessionRef.current) terminalRef.current?.write(event.data)
      else pendingDataRef.current.set(event.sessionId, `${pendingDataRef.current.get(event.sessionId) ?? ''}${event.data}`.slice(-100_000))
    })
    const unsubscribeExit = desktop.onTerminalExit(event => {
      if (event.sessionId !== sessionRef.current) return
      sessionRef.current = null
      setStatus(event.exitCode === 0 ? 'exited' : 'error')
      if (event.exitCode !== 0) setError(`Shell 已退出，代码 ${event.exitCode}。`)
    })
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([xterm, addon]) => {
      if (disposedRef.current || !containerRef.current) return
      const terminal = new xterm.Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontFamily: '"SFMono-Regular", "Cascadia Code", Menlo, monospace',
        fontSize: 12,
        lineHeight: 1.35,
        scrollback: 5_000,
        allowTransparency: true,
        theme: { background: '#080c14', foreground: '#d8e1ee', cursor: '#818cf8', selectionBackground: '#334155', black: '#0f172a', brightBlack: '#64748b' },
      })
      const fitAddon = new addon.FitAddon()
      terminal.loadAddon(fitAddon)
      terminal.open(containerRef.current)
      terminalRef.current = terminal
      fitRef.current = fitAddon
      inputDisposable = terminal.onData(data => { const sessionId = sessionRef.current; if (sessionId) desktop.writeTerminal(sessionId, data) })
      resizeDisposable = terminal.onResize(size => { const sessionId = sessionRef.current; if (sessionId) desktop.resizeTerminal(sessionId, size.cols, size.rows) })
      observer = new ResizeObserver(() => fitTerminal())
      observer.observe(containerRef.current)
      setTerminalReady(true)
    }).catch(caught => {
      setStatus('error')
      setError(caught instanceof Error ? caught.message : '无法加载终端界面。')
    })
    return () => {
      disposedRef.current = true
      startGenerationRef.current += 1
      startingRef.current = false
      observer?.disconnect()
      inputDisposable?.dispose()
      resizeDisposable?.dispose()
      unsubscribeData()
      unsubscribeExit()
      const sessionId = sessionRef.current
      sessionRef.current = null
      if (sessionId) void desktop.closeTerminal(sessionId)
      terminalRef.current?.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [fitTerminal])

  useEffect(() => {
    if (active && terminalReady && !sessionRef.current && !startingRef.current) void startTerminal(false)
    if (active) window.requestAnimationFrame(fitTerminal)
  }, [active, fitTerminal, startTerminal, terminalReady])

  const statusLabel = status === 'running' ? '运行中' : status === 'starting' ? '启动中' : status === 'exited' ? '已退出' : status === 'error' ? '异常' : '未启动'
  const desktopAvailable = environmentChecked && typeof window !== 'undefined' && Boolean(window.artifactDesktop)

  return <div className="terminal-shell">
    <header className="terminal-toolbar">
      <div className="terminal-session-meta"><span className={`terminal-status-dot ${status}`} /><b>{statusLabel}</b>{sessionInfo && <><code title={sessionInfo.cwd}>{sessionInfo.cwd}</code><small>{sessionInfo.shell.split('/').at(-1)}</small></>}</div>
      <div className="terminal-actions"><button type="button" onClick={() => void startTerminal(true)} disabled={!desktopAvailable || status === 'starting'} title="重启终端" aria-label="重启终端"><RefreshCcw aria-hidden="true" /></button><button type="button" onClick={() => terminalRef.current?.clear()} disabled={!terminalReady} title="清空终端" aria-label="清空终端"><Trash2 aria-hidden="true" /></button></div>
    </header>
    <div className="terminal-viewport" ref={containerRef} />
    {environmentChecked && !desktopAvailable && <div className="desktop-only-placeholder"><SquareTerminal aria-hidden="true" /><b>终端仅在桌面应用中可用</b><span>桌面版会在当前项目目录启动交互式 Shell。</span></div>}
    {error && <div className="terminal-error" role="alert">{error}</div>}
  </div>
}

function BrowserWorkbench({ active }: { active: boolean }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const addressFocusedRef = useRef(false)
  const [environmentChecked, setEnvironmentChecked] = useState(false)
  const [state, setState] = useState(emptyBrowserState)
  const [address, setAddress] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  const syncBounds = useCallback(() => {
    const desktop = window.artifactDesktop
    const element = viewportRef.current
    if (!active || !desktop || !element) return
    const bounds = element.getBoundingClientRect()
    desktop.setBrowserBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
  }, [active])

  const applyState = useCallback((next: EmbeddedBrowserState) => {
    setState(next)
    if (!addressFocusedRef.current && next.url) setAddress(next.url)
    setActionError(next.error)
  }, [])

  useEffect(() => {
    setEnvironmentChecked(true)
    const desktop = window.artifactDesktop
    if (!desktop) return
    const unsubscribe = desktop.onBrowserState(applyState)
    const observer = new ResizeObserver(syncBounds)
    if (viewportRef.current) observer.observe(viewportRef.current)
    window.addEventListener('resize', syncBounds)
    return () => {
      desktop.hideBrowser()
      unsubscribe()
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
    }
  }, [applyState, syncBounds])

  useEffect(() => {
    const desktop = window.artifactDesktop
    if (!desktop) return
    if (!active) { desktop.hideBrowser(); return }
    void desktop.showBrowser().then(next => { applyState(next); window.requestAnimationFrame(syncBounds) }).catch(caught => setActionError(caught instanceof Error ? caught.message : '无法显示浏览器。'))
  }, [active, applyState, syncBounds])

  const navigate = async (event: FormEvent) => {
    event.preventDefault()
    const desktop = window.artifactDesktop
    if (!desktop || !address.trim()) return
    setActionError(null)
    try {
      const next = await desktop.navigateBrowser(address)
      applyState(next)
      window.requestAnimationFrame(syncBounds)
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '无法打开网页。')
    }
  }

  const runAction = async (action: 'back' | 'forward' | 'reload' | 'stop') => {
    const desktop = window.artifactDesktop
    if (!desktop) return
    try {
      const next = action === 'back' ? await desktop.browserBack() : action === 'forward' ? await desktop.browserForward() : action === 'stop' ? await desktop.browserStop() : await desktop.browserReload()
      applyState(next)
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '浏览器操作失败。')
    }
  }

  const desktopAvailable = environmentChecked && typeof window !== 'undefined' && Boolean(window.artifactDesktop)
  const browserHost = (() => { try { return state.url ? new URL(state.url).hostname : '等待输入地址' } catch { return '等待输入地址' } })()

  return <div className="browser-shell">
    <header className="browser-toolbar">
      <div className="browser-navigation">
        <button type="button" disabled={!state.canGoBack} onClick={() => void runAction('back')} title="后退" aria-label="后退"><ArrowLeft aria-hidden="true" /></button>
        <button type="button" disabled={!state.canGoForward} onClick={() => void runAction('forward')} title="前进" aria-label="前进"><ArrowRight aria-hidden="true" /></button>
        <button type="button" disabled={!state.url} onClick={() => void runAction(state.loading ? 'stop' : 'reload')} title={state.loading ? '停止加载' : '重新加载'} aria-label={state.loading ? '停止加载' : '重新加载'}>{state.loading ? <StopCircle aria-hidden="true" /> : <RotateCw aria-hidden="true" />}</button>
      </div>
      <form className="browser-address" onSubmit={event => void navigate(event)}><Shield aria-hidden="true" /><input value={address} onChange={event => setAddress(event.target.value)} onFocus={() => { addressFocusedRef.current = true }} onBlur={() => { addressFocusedRef.current = false }} placeholder="输入网址" aria-label="网页地址" autoCapitalize="off" autoCorrect="off" spellCheck={false} /></form>
      <button className="browser-external" type="button" disabled={!state.url || !desktopAvailable} onClick={() => void window.artifactDesktop?.openBrowserExternal()} title="在系统浏览器中打开" aria-label="在系统浏览器中打开"><ExternalLink aria-hidden="true" /></button>
    </header>
    <div className="browser-page-meta"><b title={state.title || '新标签页'}>{state.title || '新标签页'}</b><span>{state.loading ? '正在加载' : browserHost}</span></div>
    <div className="browser-viewport" ref={viewportRef}>
      {!state.url && <div className="browser-start"><Globe2 aria-hidden="true" /><b>新标签页</b><span>在地址栏输入 HTTP 或 HTTPS 地址。</span></div>}
      {environmentChecked && !desktopAvailable && <div className="desktop-only-placeholder"><Globe2 aria-hidden="true" /><b>内置浏览器仅在桌面应用中可用</b><span>桌面版使用隔离会话加载网页。</span></div>}
    </div>
    {actionError && <div className="browser-error" role="alert">{actionError}</div>}
  </div>
}
