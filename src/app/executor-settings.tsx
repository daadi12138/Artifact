'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { AlertTriangle, ArrowLeft, ArrowUp, Check, Copy, Download, ExternalLink, HardDrive, Moon, RefreshCw, ScanSearch, Sun, Trash2 } from 'lucide-react'

type ExecutorEnvironmentState = 'ready' | 'discovered' | 'update_available' | 'not_installed' | 'error'
type ExecutorAuthenticationState = 'authenticated' | 'api_key' | 'needs_login' | 'unknown'
type ExecutorModelOption = { value: string; label: string }
type ExecutorModelCatalog = { source: 'codex-cli-catalog' | 'claude-cli-help'; discoveredAt: string; cliVersion: string; modelOptions: ExecutorModelOption[]; availabilityNote: string }
type ExecutorEnvironment = { id: string; name: string; type: string; icon: string; tone: string; command: string; platform: string; state: ExecutorEnvironmentState; connected: boolean; executablePath?: string; currentVersion?: string; latestVersion?: string; error?: string; installPlan?: { display: string }; model: string; modelOptions: ExecutorModelOption[]; modelCatalog?: ExecutorModelCatalog; authentication: ExecutorAuthenticationState }
type ExecutorEnvironmentReport = { scannedAt: string; executors: ExecutorEnvironment[]; updateCount: number }
type ExecutorInstallationDiagnostic = { checkedAt: string; conflicts: Array<{ id: string; name: string; command: string; paths: string[] }> }
type CommandSpec = { command: string; cwd: string; timeoutMs: number; workspaceRoot?: string; evidence?: string[] }
type CommandApproval = CommandSpec & { approvedAt: string }
type Project = { name: string; repositoryPath: string; gitRoot: string; status: string; environment: { version: number; confirmedByUser: boolean; detectedStack: Array<{ name: string; version?: string }>; workspaceRoots?: Array<{ path: string; ecosystem: string; manager: string; evidence: string[] }>; commands: Record<string, CommandSpec | undefined>; commandAllowlist: Record<string, CommandApproval | undefined> } }
type RecentProject = Pick<Project, 'name' | 'repositoryPath' | 'gitRoot'> & { updatedAt: string }
type StorageOverview = { stateDirectory: string; runsDirectory: string; worktreesDirectory: string; retainedArtifactsDirectory: string; totalBytes: number; runBytes: number; attemptBytes: number; artifactBytes: number; worktreeBytes: number; retainedArtifactBytes: number; cleanupEligibleCount: number; protectedRunCount: number }
type StorageCleanupPreview = { runIds: string[]; protectedRunIds: string[]; totalBytes: number; artifactBytes: number; reclaimedBytes: number; retainArtifacts: boolean }
const commandKeys = ['install', 'typecheck', 'test', 'build', 'lint'] as const
const commandLabels: Record<(typeof commandKeys)[number], string> = { install: '安装依赖', typecheck: '类型检查', test: '运行测试', build: '生产构建', lint: '代码检查' }
const futureExecutors = [
  { id: 'gemini', name: 'Gemini CLI', type: 'Google Coding Agent', icon: 'G', tone: 'cyan', focus: '模型、认证和非交互命令协议' },
  { id: 'grok', name: 'Grok Build', type: 'xAI Coding Agent', icon: 'X', tone: 'rose', focus: '可审计的执行协议与输出解析' },
  { id: 'opencode', name: 'OpenCode', type: 'Open Coding Agent', icon: 'O', tone: 'slate', focus: '本地模型配置与 Worktree 策略' },
  { id: 'pi', name: 'Pi', type: 'Extensible Coding Agent', icon: 'P', tone: 'green', focus: '扩展管理、取消与恢复协议' },
] as const

type SetupStep = 1 | 2 | 3
type ProjectMode = 'idle' | 'create' | 'manual-import'
type InterfaceTheme = 'dark' | 'light'
type FeedbackNotice = { kind: 'success' | 'error'; text: string }
type FeedbackNoticeState = FeedbackNotice & { id: number }
type SettingsOverviewProps = {
  onExecutors: () => void
  onOpenWorkflow: () => void
  executorConfigured: boolean
  theme: InterfaceTheme
  onThemeChange: (theme: InterfaceTheme) => void
}

function useTransientNotice(durationMs = 2_000) {
  const [notice, setNoticeState] = useState<FeedbackNoticeState | null>(null)
  const nextNoticeId = useRef(0)

  const setNotice = (next: FeedbackNotice | null) => {
    if (!next) {
      setNoticeState(null)
      return
    }
    nextNoticeId.current += 1
    setNoticeState({ ...next, id: nextNoticeId.current })
  }

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => {
      setNoticeState(current => current === notice ? null : current)
    }, durationMs)
    return () => window.clearTimeout(timer)
  }, [durationMs, notice])

  return [notice, setNotice] as const
}

function FeedbackToast({ notice }: { notice: FeedbackNoticeState | null }) {
  if (!notice) return null
  const Icon = notice.kind === 'error' ? AlertTriangle : Check
  return <div key={notice.id} className={`feedback-toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'} aria-atomic="true">
    <span className="feedback-toast-icon"><Icon aria-hidden="true" /></span>
    <span className="feedback-toast-message">{notice.text}</span>
  </div>
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`
  if (value < 1_024 * 1_024 * 1_024) return `${(value / (1_024 * 1_024)).toFixed(1)} MB`
  return `${(value / (1_024 * 1_024 * 1_024)).toFixed(1)} GB`
}

export function SettingsOverview({ onExecutors, onOpenWorkflow, executorConfigured, theme, onThemeChange }: SettingsOverviewProps) {
  const [project, setProject] = useState<Project | null>(null)
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([])
  const [path, setPath] = useState('')
  const [activeStep, setActiveStep] = useState<SetupStep>(1)
  const [projectMode, setProjectMode] = useState<ProjectMode>('idle')
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectLocation, setNewProjectLocation] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useTransientNotice()
  const [desktop, setDesktop] = useState(false)
  const [storage, setStorage] = useState<StorageOverview | null>(null)
  const [storageLoading, setStorageLoading] = useState(true)
  const [storageBusy, setStorageBusy] = useState(false)
  const [retainArtifacts, setRetainArtifacts] = useState(true)
  const load = () => { void fetch('/api/project').then(response => response.json()).then((value: { project: Project | null; recentProjects?: RecentProject[] }) => { setProject(value.project); setRecentProjects(value.recentProjects ?? []); setPath(''); setNewProjectLocation(''); if (value.project) setActiveStep(3) }).catch(() => undefined) }
  const loadStorage = async (showError = false) => {
    setStorageLoading(true)
    try {
      const response = await fetch('/api/storage')
      const value = await response.json() as StorageOverview & { error?: string }
      if (!response.ok) throw new Error(value.error ?? '无法读取运行存储')
      setStorage(value)
    } catch (error) {
      if (showError) setNotice({ kind: 'error', text: error instanceof Error ? error.message : '无法读取运行存储' })
    } finally {
      setStorageLoading(false)
    }
  }
  useEffect(() => { setDesktop(Boolean(window.artifactDesktop)) }, [])
  useEffect(load, [])
  useEffect(() => { void loadStorage() }, [])
  const acceptProject = (value: Project) => { setProject(value); setPath(''); setProjectMode('idle'); setActiveStep(3); setRecentProjects(current => [{ name: value.name, repositoryPath: value.repositoryPath, gitRoot: value.gitRoot, updatedAt: new Date().toISOString() }, ...current.filter(item => item.gitRoot !== value.gitRoot)].slice(0, 6)); setNotice({ kind: 'success', text: '项目已导入。确认本机运行时状态后即可开始工作流；命令会在实际运行前按需请求授权。' }); window.dispatchEvent(new Event('artifact-project-updated')) }
  const pickProject = async () => {
    if (!window.artifactDesktop) return
    setBusy(true); setNotice(null)
    try {
      const result = await window.artifactDesktop.pickProject()
      if (!result.canceled) acceptProject(result.project)
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '项目导入失败' }) } finally { setBusy(false) }
  }
  const importProject = async () => {
    setBusy(true); setNotice(null)
    try {
      const response = await fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })
      const value = await response.json() as Project & { error?: string }
      if (!response.ok) throw new Error(value.error ?? '项目导入失败')
      acceptProject(value)
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '项目导入失败' }) } finally { setBusy(false) }
  }
  const pickProjectLocation = async () => {
    if (!window.artifactDesktop) return
    setNotice(null)
    try {
      const result = await window.artifactDesktop.pickProjectLocation()
      if (!result.canceled) setNewProjectLocation(result.path)
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '无法选择项目位置' }) }
  }
  const createProject = async () => {
    setBusy(true); setNotice(null)
    try {
      let parentPath = newProjectLocation
      if (desktop && !parentPath) {
        const result = await window.artifactDesktop?.pickProjectLocation()
        if (!result || result.canceled) return
        parentPath = result.path
        setNewProjectLocation(parentPath)
      }
      const value = window.artifactDesktop
        ? await window.artifactDesktop.createProject(parentPath, newProjectName)
        : await (async () => {
            const response = await fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'create', parentPath, name: newProjectName }) })
            const result = await response.json() as Project & { error?: string }
            if (!response.ok) throw new Error(result.error ?? '项目创建失败')
            return result
          })()
      acceptProject(value)
      setNewProjectName('')
      setProjectMode('idle')
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '项目创建失败' }) } finally { setBusy(false) }
  }
  const selectRecentProject = async (recent: RecentProject) => {
    setPath(recent.repositoryPath)
    setBusy(true); setNotice(null)
    try {
      const response = await fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: recent.repositoryPath }) })
      const value = await response.json() as Project & { error?: string }
      if (!response.ok) throw new Error(value.error ?? '项目导入失败')
      acceptProject(value)
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '项目导入失败' }) } finally { setBusy(false) }
  }
  const manageCommand = async (key: string, action: 'allow' | 'revoke') => {
    setBusy(true); setNotice(null)
    try {
      const response = await fetch('/api/project', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, commandKey: key }) })
      const value = await response.json() as Project & { error?: string }
      if (!response.ok) throw new Error(value.error ?? '命令白名单更新失败')
      setProject(value)
      setNotice({ kind: 'success', text: action === 'allow' ? `已允许 ${commandLabels[key as keyof typeof commandLabels]}；之后会自动执行相同命令。` : `已移除 ${commandLabels[key as keyof typeof commandLabels]} 的默认授权。` })
      window.dispatchEvent(new Event('artifact-project-updated'))
    } catch (error) { setNotice({ kind: 'error', text: error instanceof Error ? error.message : '命令白名单更新失败' }) } finally { setBusy(false) }
  }
  const cleanupCompletedRuns = async () => {
    setStorageBusy(true)
    setNotice(null)
    try {
      const previewResponse = await fetch('/api/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'preview', retainArtifacts }) })
      const preview = await previewResponse.json() as StorageCleanupPreview & { error?: string }
      if (!previewResponse.ok) throw new Error(preview.error ?? '无法预览清理范围')
      if (!preview.runIds.length) {
        setNotice({ kind: 'success', text: '当前没有可清理的已结束运行。等待交付审批和未结束运行会继续保留。' })
        return
      }
      const artifactNote = retainArtifacts ? `运行产物将保留，预计释放 ${formatBytes(preview.reclaimedBytes)}。` : `预计释放 ${formatBytes(preview.reclaimedBytes)}，运行产物也会删除。`
      if (!window.confirm(`将清理 ${preview.runIds.length} 个已结束运行。${artifactNote}\n\n等待交付审批和未结束运行不会被清理。`)) return
      const cleanupResponse = await fetch('/api/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cleanup', runIds: preview.runIds, retainArtifacts }) })
      const result = await cleanupResponse.json() as { cleanedRunIds?: string[]; error?: string }
      if (!cleanupResponse.ok) throw new Error(result.error ?? '运行存储清理失败')
      setNotice({ kind: 'success', text: `已清理 ${result.cleanedRunIds?.length ?? 0} 个已结束运行。${retainArtifacts ? '运行产物已保留在 retained-artifacts 中。' : ''}` })
      await loadStorage()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '运行存储清理失败' })
    } finally {
      setStorageBusy(false)
    }
  }
  const detectedCommands = commandKeys.flatMap(key => project?.environment.commands[key] ? [[key, project.environment.commands[key]!] as const] : [])

  const completedSteps = Number(Boolean(project)) + Number(executorConfigured)
  const canOpenStep = (step: SetupStep) => step === 1 || Boolean(project)
  const openImport = () => {
    if (desktop) void pickProject()
    else setProjectMode('manual-import')
  }
  const handleThemeKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const themes: InterfaceTheme[] = ['dark', 'light']
    const currentIndex = themes.indexOf(theme)
    const nextIndex = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
      ? (currentIndex + themes.length - 1) % themes.length
      : event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? (currentIndex + 1) % themes.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? themes.length - 1
            : null
    if (nextIndex === null) return
    event.preventDefault()
    const nextTheme = themes[nextIndex]
    onThemeChange(nextTheme)
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-theme-option="${nextTheme}"]`)?.focus()
  }

  const stepDetails: Record<SetupStep, { label: string; title: string; description: string }> = {
    1: { label: '项目', title: '选择一个项目', description: '导入已有 Git 仓库，或创建一个新的空项目。' },
    2: { label: '命令', title: '命令白名单', description: '命令只会在实际需要执行时请求授权，也可以在这里提前管理。' },
    3: { label: '运行时', title: '查看运行时', description: '确认本机 Agent Runtime 的状态和登录结果，随后即可开始运行工作流。' },
  }
  const currentStep = stepDetails[activeStep]

  return <section className="content-view setup-view">
    <div className="setup-container">
      <header className="setup-heading">
        <div><span className="section-kicker">WORKSPACE SETUP</span><h1>从项目开始</h1><p>项目和执行器准备好后即可开始；验证命令在使用时再授权。</p></div>
        <span className="setup-count">{completedSteps === 2 ? '已准备就绪' : `${completedSteps}/2 已完成`}</span>
      </header>
      <FeedbackToast notice={notice} />
      <ol className="setup-progress" aria-label="工作空间设置进度">
        {([1, 2, 3] as SetupStep[]).map(step => {
          const item = stepDetails[step]
          const done = step === 1 ? Boolean(project) : step === 2 ? Boolean(project) : executorConfigured
          const state = step === 2 && project ? '按需授权' : done ? '已完成' : activeStep === step ? '正在设置' : '等待前一步'
          return <li key={step} className={done ? 'done' : activeStep === step ? 'active' : ''}><button onClick={() => canOpenStep(step) && setActiveStep(step)} disabled={!canOpenStep(step)} aria-current={activeStep === step ? 'step' : undefined}><span>{done && step !== 2 ? '✓' : step}</span><b>{item.label}</b><small>{state}</small></button></li>
        })}
      </ol>

      <section className="setup-workbench" data-step={activeStep}>
        <header className="setup-stage-heading">
          <span className="setup-stage-number">0{activeStep}</span>
          <div><span className="section-kicker">{currentStep.label}</span><h2>{currentStep.title}</h2><p>{currentStep.description}</p></div>
          {project && <div className="setup-project-context"><span>⌘</span><div><b>{project.name}</b><small>Git 已检测</small></div></div>}
        </header>

        <div className="setup-stage-content" key={activeStep}>
          {activeStep === 1 && (project ? <>
            <div className="setup-project-summary"><span className="setup-summary-icon">✓</span><div><strong>{project.name}</strong><small>项目已识别。确认本机运行时后即可运行；验证命令会在首次实际使用前请求授权。</small><div className="setup-stack-list">{project.environment.detectedStack.map(item => <span key={`${item.name}-${item.version ?? ''}`}>{item.name}{item.version ? ` ${item.version}` : ''}</span>)}{project.environment.workspaceRoots?.map(root => <span key={`${root.ecosystem}-${root.path}`} title={root.evidence.join(' · ')}>{root.manager} · {root.path}</span>)}</div></div></div>
            <div className="setup-stage-actions"><button className="run-btn" onClick={() => setActiveStep(3)}>查看运行时</button><button className="ghost-btn" onClick={() => setActiveStep(2)}>管理命令白名单</button><button className="ghost-btn" onClick={() => void (desktop ? pickProject() : setProjectMode('manual-import'))} disabled={busy}>更换项目</button>{desktop && <button className="text-btn" onClick={() => void window.artifactDesktop?.showItem(project.gitRoot)}>在 Finder 中显示</button>}</div>
          </> : <>
            <div className="setup-choice-copy"><h3>从一个 Git 项目开始</h3><p>Artifact 会读取仓库信息并建议可执行命令；每次运行都将在隔离 Worktree 中完成。</p></div>
            <div className="setup-project-choices"><button className="setup-choice setup-choice-primary" onClick={openImport} disabled={busy}><span className="setup-choice-icon">⌘</span><span><b>{busy ? '正在检测项目…' : '导入 Git 项目'}</b><small>{desktop ? '从本机选择一个已有仓库' : '指定一个已有仓库的位置'}</small></span><i>›</i></button><button className="setup-choice" onClick={() => setProjectMode(projectMode === 'create' ? 'idle' : 'create')} disabled={busy}><span className="setup-choice-icon plus">＋</span><span><b>新建空项目</b><small>创建仓库与初始提交</small></span><i>›</i></button></div>
            <div className="setup-manual"><button className="text-btn" onClick={() => setProjectMode(projectMode === 'manual-import' ? 'idle' : 'manual-import')} disabled={busy}>{projectMode === 'manual-import' ? '收起路径输入' : '手动输入项目路径'}</button><span>仅在无法打开系统选择器时使用</span></div>
            {projectMode === 'manual-import' && <div className="setup-form"><label>Git 项目路径<input autoFocus value={path} onChange={event => setPath(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void importProject() }} placeholder="例如 /Users/you/code/my-git-project" /></label><div className="setup-form-actions"><button className="run-btn" onClick={() => void importProject()} disabled={busy || !path.trim()}>{busy ? '正在检测…' : '导入并检测'}</button><button className="text-btn" onClick={() => setProjectMode('idle')}>取消</button></div></div>}
            {projectMode === 'create' && <div className="setup-form"><label>项目名称<input autoFocus value={newProjectName} onChange={event => setNewProjectName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void createProject() }} placeholder="例如 customer-portal" /></label><label>保存位置<div className="project-location"><input value={newProjectLocation} onChange={event => setNewProjectLocation(event.target.value)} placeholder="选择新项目要保存的文件夹" />{desktop && <button className="ghost-btn" onClick={() => void pickProjectLocation()} disabled={busy}>选择…</button>}</div></label><div className="setup-form-actions"><button className="run-btn" onClick={() => void createProject()} disabled={busy || !newProjectName.trim() || !newProjectLocation.trim()}>{busy ? '创建中…' : '创建并继续'}</button><span>会初始化 Git 与首个提交。</span></div></div>}
            {recentProjects.length > 0 && <div className="setup-recents"><span>最近使用</span>{recentProjects.map(recent => <button key={recent.gitRoot} onClick={() => void selectRecentProject(recent)} disabled={busy}><b>{recent.name}</b><small>Git 项目</small><i>›</i></button>)}</div>}
          </>)}

          {activeStep === 2 && project && <>
            <div className="setup-command-heading"><div><h3>命令白名单</h3><p>无需在导入时做选择。工作流需要运行某条命令时会暂停并显示完整命令；授权后，相同命令会自动执行。</p></div></div>
            {detectedCommands.length > 0 ? <div className="setup-command-list">{detectedCommands.map(([key, command]) => {
              const approval = project.environment.commandAllowlist[key]
              const workspace = command.workspaceRoot ?? command.cwd
              const origin = command.evidence?.join(' · ')
              return <div className="setup-command" key={key}><span><b>{commandLabels[key]}</b><code>{command.command}</code><small title={origin}>{approval ? `已允许 · ${new Date(approval.approvedAt).toLocaleString('zh-CN')}` : '首次运行时请求授权'} · 工作区 {workspace}</small></span><button className={approval ? 'ghost-btn' : 'run-btn'} onClick={() => void manageCommand(key, approval ? 'revoke' : 'allow')} disabled={busy}>{approval ? '撤销允许' : '允许执行'}</button></div>
            })}</div> : <div className="setup-empty"><b>尚未检测到项目命令</b><span>Artifact 会识别 Node、Python、Go 和 Rust 项目的常用验证命令。</span></div>}
            <div className="setup-stage-actions"><button className="run-btn" onClick={() => setActiveStep(3)}>查看运行时</button><span>命令白名单可随时回来管理。</span></div>
          </>}

          {activeStep === 3 && project && <><div className={`setup-executor-status ${executorConfigured ? 'ready' : ''}`}><span>{executorConfigured ? '✓' : '✦'}</span><div><h3>{executorConfigured ? '运行时已发现' : '未发现可用运行时'}</h3><p>{executorConfigured ? '项目与本机运行时均已就绪，可以开始第一个工作流。验证命令将在首次使用时请求授权。' : '安装并登录 Codex 或 Claude Code 后，返回此处刷新状态。'}</p></div></div><div className="setup-stage-actions"><button className="run-btn" onClick={executorConfigured ? onOpenWorkflow : onExecutors}>{executorConfigured ? '进入工作流' : '查看运行时'}</button>{executorConfigured && <button className="ghost-btn" onClick={onExecutors}>查看运行时</button>}</div></>}
        </div>
      </section>

      <section className="storage-governance" aria-labelledby="storage-governance-title">
        <header className="storage-governance-heading">
          <div className="storage-heading-copy"><span className="storage-heading-icon"><HardDrive aria-hidden="true" /></span><div><span className="section-kicker">RUN STORAGE</span><h2 id="storage-governance-title">运行存储</h2><p>运行记录、验证输出和隔离 Worktree 都保存在本机。</p></div></div>
          <button className="ghost-btn" onClick={() => void loadStorage(true)} disabled={storageLoading || storageBusy}><RefreshCw className={storageLoading ? 'spin' : undefined} aria-hidden="true" />{storageLoading ? '读取中…' : '刷新'}</button>
        </header>
        {storage ? <>
          <div className="storage-metrics">
            <div className="storage-primary-metric"><span><small>Artifact 存储</small><b>{formatBytes(storage.totalBytes)}</b><em>运行记录、输出与 Worktree</em></span></div>
            <div><span><small>可清理运行</small><b>{storage.cleanupEligibleCount}</b><em>已结束</em></span></div>
            <div className="storage-protected-metric"><span><small>受保护运行</small><b>{storage.protectedRunCount}</b><em>{storage.protectedRunCount ? '不会被清理' : '当前无保护项'}</em></span></div>
            <div><span><small>隔离 Worktree</small><b>{formatBytes(storage.worktreeBytes)}</b><em>可随运行回收</em></span></div>
          </div>
          <div className="storage-paths">
            <div className="storage-paths-heading"><span>本机位置</span><small>路径仅用于查看，运行数据始终保留在本机。</small></div>
            <span><small>状态目录</small><code title={storage.stateDirectory}>{storage.stateDirectory}</code></span>
            <span><small>Worktree 目录</small><code title={storage.worktreesDirectory}>{storage.worktreesDirectory}</code></span>
            <span><small>保留产物目录</small><code title={storage.retainedArtifactsDirectory}>{storage.retainedArtifactsDirectory}</code></span>
          </div>
          <div className="storage-cleanup-actions">
            <div className="storage-cleanup-copy"><b>清理策略</b><small>等待交付审批、运行中与暂停中的记录始终受保护。</small></div>
            <label className="storage-retention"><input type="checkbox" checked={retainArtifacts} onChange={event => setRetainArtifacts(event.target.checked)} disabled={storageBusy} /><span><b>保留运行产物</b><small>复制产物与运行清单，不保留 Worktree。</small></span></label>
            <button className="ghost-btn storage-cleanup-button" onClick={() => void cleanupCompletedRuns()} disabled={storageBusy || storage.cleanupEligibleCount === 0}><Trash2 aria-hidden="true" /><span>{storageBusy ? '清理中…' : '清理已结束运行'}</span></button>
          </div>
        </> : <div className="storage-empty">{storageLoading ? '正在读取运行存储…' : '暂时无法读取运行存储。'}</div>}
      </section>

      <section className="appearance-theme" aria-labelledby="appearance-theme-title">
        <div className="appearance-theme-copy">
          <span className="section-kicker">INTERFACE</span>
          <h2 id="appearance-theme-title">界面外观</h2>
          <p>选择适合当前环境的主题。</p>
        </div>
        <div className="appearance-theme-options" role="radiogroup" aria-labelledby="appearance-theme-title">
          <button
            type="button"
            className={`appearance-theme-option ${theme === 'dark' ? 'active' : ''}`}
            role="radio"
            aria-checked={theme === 'dark'}
            tabIndex={theme === 'dark' ? 0 : -1}
            data-theme-option="dark"
            onClick={() => onThemeChange('dark')}
            onKeyDown={handleThemeKeyDown}
          >
            <Moon size={16} aria-hidden="true" />
            <span><b>深色</b><small>Mission Control</small></span>
          </button>
          <button
            type="button"
            className={`appearance-theme-option ${theme === 'light' ? 'active' : ''}`}
            role="radio"
            aria-checked={theme === 'light'}
            tabIndex={theme === 'light' ? 0 : -1}
            data-theme-option="light"
            onClick={() => onThemeChange('light')}
            onKeyDown={handleThemeKeyDown}
          >
            <Sun size={16} aria-hidden="true" />
            <span><b>亮色</b><small>Daylight</small></span>
          </button>
        </div>
      </section>
    </div>
  </section>
}

export function ExecutorSettings({ onBack }: { onBack: () => void }) {
  const [report, setReport] = useState<ExecutorEnvironmentReport | null>(null)
  const [scanning, setScanning] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useTransientNotice()
  const [confirmation, setConfirmation] = useState<{ ids: string[]; action: 'install' | 'update' } | null>(null)
  const [diagnostic, setDiagnostic] = useState<ExecutorInstallationDiagnostic | null>(null)
  const [modelDrafts, setModelDrafts] = useState<Record<string, string>>({})
  const [modelCatalogs, setModelCatalogs] = useState<Record<string, ExecutorModelCatalog>>({})

  const scan = async (includeLatest = true) => {
    setScanning(true)
    try {
      const response = await fetch('/api/executors/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ includeLatest }) })
      const value = await response.json() as ExecutorEnvironmentReport & { error?: string }
      if (!response.ok) throw new Error(value.error ?? '本地环境检查失败')
      setReport(value)
      window.dispatchEvent(new Event('artifact-executors-updated'))
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '本地环境检查失败' })
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => { void scan() }, [])

  const connect = async (executor: ExecutorEnvironment) => {
    setBusyId(`connect:${executor.id}`)
    setNotice(null)
    try {
      const response = await fetch(`/api/executors/${executor.id}/probe`, { method: 'POST' })
      const value = await response.json() as { error?: string }
      if (!response.ok) throw new Error(value.error ?? '运行时检查失败')
      setNotice({ kind: 'success', text: `${executor.name} 的本机运行时状态已刷新。` })
      await scan(false)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '运行时检查失败' })
    } finally {
      setBusyId(null)
    }
  }

  const saveModel = async (executor: ExecutorEnvironment) => {
    setBusyId(`model:${executor.id}`)
    setNotice(null)
    try {
      setNotice({ kind: 'success', text: `${executor.name} 的模型选择由 CLI 管理，Artifact 未保存任何配置。` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '模型状态提示失败' })
    } finally {
      setBusyId(null)
    }
  }

  const discoverModels = async (executor: ExecutorEnvironment) => {
    setBusyId(`models:${executor.id}`)
    setNotice(null)
    try {
      const response = await fetch(`/api/executors/${executor.id}/models`, { method: 'POST' })
      const value = await response.json() as { catalog?: ExecutorModelCatalog; error?: string }
      if (!response.ok || !value.catalog) throw new Error(value.error ?? '无法获取模型选项')
      setModelCatalogs(current => ({ ...current, [executor.id]: value.catalog! }))
      setNotice({ kind: 'success', text: `${executor.name} 已刷新 ${value.catalog.modelOptions.length} 个模型选项。${value.catalog.availabilityNote}` })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '无法获取模型选项' })
    } finally {
      setBusyId(null)
    }
  }

  const diagnose = async () => {
    setBusyId('diagnose')
    setNotice(null)
    try {
      await scan(false)
      setDiagnostic({ checkedAt: new Date().toISOString(), conflicts: [] })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '诊断失败' })
    } finally {
      setBusyId(null)
    }
  }

  const executeMaintenance = async () => {
    if (!confirmation) return
    const { ids, action } = confirmation
    setBusyId(action === 'update' && ids.length > 1 ? 'update-all' : `${action}:${ids[0]}`)
    setNotice(null)
    setConfirmation(null)
    try {
      const commands = selectedForMaintenance.map(executor => executor.installPlan?.display).filter((command): command is string => Boolean(command))
      await navigator.clipboard?.writeText(commands.join('\n'))
      setNotice({ kind: 'success', text: action === 'install' ? '安装命令已复制；请在终端中执行后刷新状态。' : '升级命令已复制；请在终端中执行后刷新状态。' })
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : '无法复制 CLI 命令' })
    } finally {
      setBusyId(null)
    }
  }

  const selectedForMaintenance = confirmation ? report?.executors.filter(executor => confirmation.ids.includes(executor.id)) ?? [] : []
  const updateIds = report?.executors.filter(executor => executor.state === 'update_available' && executor.installPlan).map(executor => executor.id) ?? []
  const updateBusy = busyId === 'update-all' || busyId?.startsWith('update:') === true
  const manualCommands = report?.executors.flatMap(executor => executor.installPlan ? [`# ${executor.name}\n${executor.installPlan.display}`] : []) ?? []

  return <section className="executor-page environment-page">
    <div className="environment-shell">
      <header className="environment-header">
        <div>
          <button className="back-link" onClick={onBack}><ArrowLeft aria-hidden="true" />项目设置</button>
          <span className="section-kicker">LOCAL RUNTIME</span>
          <h1>Agent 运行时</h1>
          <p>当前可调度的运行时只有 Codex 与 Claude Code。每张卡片都对应一个已实现的 Run 适配器。</p>
        </div>
        <div className="environment-actions">
          <button className="ghost-btn" onClick={() => void diagnose()} disabled={busyId === 'diagnose'}><ScanSearch aria-hidden="true" />{busyId === 'diagnose' ? '检查中…' : '检查运行时'}</button>
          <button className="ghost-btn" onClick={() => void scan()} disabled={scanning}><RefreshCw className={scanning ? 'spin' : undefined} aria-hidden="true" />{scanning ? '检查中…' : '刷新'}</button>
          <button className="run-btn" onClick={() => setConfirmation({ ids: updateIds, action: 'update' })} disabled={!updateIds.length || updateBusy}><ArrowUp aria-hidden="true" />{updateBusy ? '升级中…' : `全部升级${updateIds.length ? ` (${updateIds.length})` : ''}`}</button>
        </div>
      </header>

      <FeedbackToast notice={notice} />

      <div className={`environment-grid ${scanning && !report ? 'loading' : ''}`} aria-busy={scanning}>
        {(report?.executors ?? Array.from({ length: 2 }, (_, index) => ({ id: `placeholder-${index}` } as ExecutorEnvironment))).map(executor => {
          if (!executor.name) return <div className="environment-card executor-placeholder" key={executor.id}><span /><span /><span /></div>
          const action = primaryAction(executor)
          const actionBusy = busyId === `${action.kind}:${executor.id}` || (action.kind === 'update' && busyId === 'update-all')
          const selectedModel = modelDrafts[executor.id] ?? executor.model
          const modelChanged = selectedModel !== executor.model
          const modelCatalog = modelCatalogs[executor.id] ?? executor.modelCatalog
          const modelOptions = modelCatalog?.modelOptions.length ? modelCatalog.modelOptions : executor.modelOptions
          return <article className={`environment-card ${executor.state}`} key={executor.id}>
            <header>
              <div className="environment-card-title"><span className={`executor-avatar ${executor.tone}`}>{executor.icon}</span><div><h2 title={executor.type}>{executor.name}</h2><small className="executor-type">{executor.type}</small><em>{executor.platform}</em></div></div>
              <span className={`environment-state ${executor.state}`} title={stateLabel(executor.state)}>{stateSymbol(executor.state)}</span>
            </header>
            <dl className="environment-version"><div><dt>本地版本</dt><dd>{executor.currentVersion ?? '未安装'}</dd></div><div><dt>最新版本</dt><dd>{executor.latestVersion ?? (scanning ? '正在检查' : '未检查')}</dd></div></dl>
            {executor.error ? <p className="environment-error">{executor.error}</p> : <p className="environment-path">{executor.executablePath ? executor.connected ? '已连接到 Artifact' : '已发现，尚未连接到 Artifact' : '未在 PATH 中发现'}</p>}
            <section className={`executor-auth ${executor.authentication}`} aria-label={`${executor.name} 授权状态`}><span aria-hidden="true">{authenticationSymbol(executor.authentication)}</span><div><b>{authenticationLabel(executor.authentication)}</b><p>{authenticationDescription(executor)}</p></div></section>
            <details className="executor-auth-guide"><summary>登录与 API Key</summary><div><p>Artifact 不接收、不保存 API Key。推荐使用 CLI 登录；已登录的状态由 {executor.name} 自己管理。</p><div className="executor-command"><code>{loginCommand(executor.id)}</code><button className="text-btn" onClick={() => void navigator.clipboard?.writeText(loginCommand(executor.id))}>复制</button></div>{executor.id === 'claude' && <small>启动 Claude Code 后，在交互界面输入 <code>/login</code> 完成登录。</small>}<p>桌面版建议使用 CLI 登录；终端环境变量可能无法被 App 读取。</p></div></details>
            <section className="executor-model"><label htmlFor={`executor-model-${executor.id}`}>运行模型</label><div><select id={`executor-model-${executor.id}`} value={selectedModel} onChange={event => setModelDrafts(current => ({ ...current, [executor.id]: event.target.value }))} disabled={executor.state === 'not_installed'}>{modelOptions.map(option => <option value={option.value} key={option.value || 'default'}>{option.label}</option>)}</select><button className="ghost-btn" onClick={() => void discoverModels(executor)} disabled={!executor.executablePath || busyId === `models:${executor.id}`}>{busyId === `models:${executor.id}` ? '获取中…' : '获取模型'}</button><button className="ghost-btn" onClick={() => void saveModel(executor)} disabled={!modelChanged || busyId === `model:${executor.id}`}>{busyId === `model:${executor.id}` ? '保存中…' : '保存'}</button></div>{modelCatalog ? <small className="executor-model-source" title={modelCatalog.availabilityNote}>已按 {modelCatalog.cliVersion} 刷新 · {modelCatalog.source === 'codex-cli-catalog' ? 'Codex 模型目录' : 'Claude CLI 模型别名'}</small> : <small className="executor-model-source">获取模型后可查看当前 CLI 提供的选项。</small>}</section>
            <footer>
              <span className={`environment-status-text ${executor.state}`}>{stateLabel(executor.state)}</span>
              {action.kind === 'connect' || action.kind === 'verify' ? <button className="run-btn" onClick={() => void connect(executor)} disabled={actionBusy}><ExternalLink aria-hidden="true" />{actionBusy ? '检查中…' : action.kind === 'verify' ? '重新检查' : '连接'}</button> : action.kind === 'update' ? <button className="run-btn" onClick={() => setConfirmation({ ids: [executor.id], action: 'update' })} disabled={actionBusy}><ArrowUp aria-hidden="true" />{actionBusy ? '升级中…' : '升级'}</button> : action.kind === 'install' ? <button className="ghost-btn" onClick={() => setConfirmation({ ids: [executor.id], action: 'install' })} disabled={actionBusy}><Download aria-hidden="true" />安装</button> : <span className="environment-unmanaged">已可调度</span>}
            </footer>
          </article>
        })}
        {futureExecutors.map(executor => <article className="environment-card future-executor" key={executor.id} aria-label={`${executor.name}，未来扩展能力，暂不可用`}>
          <header>
            <div className="environment-card-title"><span className={`executor-avatar ${executor.tone}`}>{executor.icon}</span><div><h2>{executor.name}</h2><small>{executor.type}</small><em>Future</em></div></div>
            <span className="environment-state future" title="规划中">⌛</span>
          </header>
          <p className="future-executor-summary">此运行时尚未接入 Artifact，不能安装、连接、配置或加入工作流。</p>
          <section className="future-executor-focus"><span>接入前需要完成</span><p>{executor.focus}</p></section>
          <footer><span className="environment-status-text future">暂不可用</span><span className="future-executor-status">规划中</span></footer>
        </article>)}
      </div>

      <details className="executor-manual-commands" open>
        <summary>手动安装命令 <span>仅供复制；Artifact 不会执行这里以外的命令</span></summary>
        <div><div className="manual-command-heading"><span>受支持的 npm 安装计划</span><button className="ghost-btn" onClick={() => { void navigator.clipboard?.writeText(manualCommands.join('\n\n')); setNotice({ kind: 'success', text: '安装命令已复制。' }) }}><Copy aria-hidden="true" />复制</button></div><pre><code>{manualCommands.join('\n\n')}</code></pre></div>
      </details>
    </div>

    {confirmation && <div className="executor-modal-backdrop" role="presentation"><section className="executor-confirmation" role="dialog" aria-modal="true" aria-labelledby="executor-confirmation-title"><span className="confirmation-icon">!</span><h2 id="executor-confirmation-title">获取{confirmation.action === 'install' ? '安装' : '升级'}命令</h2><p>Artifact 不会安装或升级 Agent。确认后会复制以下 CLI 命令，由你在终端中执行。</p><div className="confirmation-commands">{selectedForMaintenance.map(executor => <div key={executor.id}><b>{executor.name}</b><code>{executor.installPlan?.display}</code></div>)}</div><div className="confirmation-actions"><button className="ghost-btn" onClick={() => setConfirmation(null)} disabled={Boolean(busyId)}>取消</button><button className="run-btn" onClick={() => void executeMaintenance()} disabled={Boolean(busyId)}>复制命令</button></div></section></div>}
    {diagnostic && <div className="executor-modal-backdrop" role="presentation"><section className="executor-confirmation diagnostic-dialog" role="dialog" aria-modal="true" aria-labelledby="executor-diagnostic-title"><span className="confirmation-icon">i</span><h2 id="executor-diagnostic-title">运行时检查</h2><p>已重新读取本机运行时、版本和认证状态。Artifact 不检查或修改 CLI 的安装位置与全局配置。</p><div className="confirmation-actions"><span /><button className="run-btn" onClick={() => setDiagnostic(null)}>完成</button></div></section></div>}
  </section>
}

function primaryAction(executor: ExecutorEnvironment): { kind: 'connect' | 'verify' | 'update' | 'install' | 'none' } {
  if (executor.state === 'update_available' && executor.installPlan) return { kind: 'update' }
  if (executor.state === 'discovered' && !executor.connected) return { kind: 'connect' }
  if (executor.state === 'not_installed' && executor.installPlan) return { kind: 'install' }
  if (executor.state === 'ready' && executor.authentication !== 'authenticated' && executor.authentication !== 'api_key') return { kind: 'verify' }
  return { kind: 'none' }
}

function stateLabel(state: ExecutorEnvironmentState): string {
  return ({ ready: '已就绪', discovered: '等待连接', update_available: '可升级', not_installed: '未安装', error: '检测失败' })[state]
}

function stateSymbol(state: ExecutorEnvironmentState): string {
  return ({ ready: '✓', discovered: '○', update_available: '!', not_installed: '!', error: '×' })[state]
}

function authenticationLabel(state: ExecutorAuthenticationState): string {
  return ({ authenticated: 'CLI 已登录', api_key: '已检测到 API Key', needs_login: '需要登录', unknown: '尚未验证登录状态' })[state]
}

function authenticationSymbol(state: ExecutorAuthenticationState): string {
  return ({ authenticated: '✓', api_key: '✓', needs_login: '!', unknown: '?' })[state]
}

function authenticationDescription(executor: ExecutorEnvironment): string {
  if (executor.authentication === 'authenticated') return '登录状态已由 CLI 检测到。'
  if (executor.authentication === 'api_key') return `已检测到启动环境中的 ${apiKeyName(executor.id)}。`
  if (executor.authentication === 'needs_login') return `先完成 ${executor.name} 的 CLI 登录，再重新检查。`
  return '运行时已找到，但当前版本无法可靠确认登录状态；重新检查或在首次 Run 前验证。'
}

function loginCommand(id: string): string { return id === 'codex' ? 'codex login' : 'claude' }
function apiKeyName(id: string): string { return id === 'codex' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY' }
