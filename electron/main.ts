import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, screen, shell, WebContentsView, type OpenDialogOptions, type Rectangle } from 'electron'
import { spawn as spawnPty, type IPty } from 'node-pty'
import { createProject, diagnoseProject, importProject, loadProject } from '../src/core/index'
import { fitWindowBounds, parseDesktopWindowState, type DesktopWindowState } from '../src/window-state'
import { managedTerminalDirectory } from '../src/run-worktree'

let mainWindow: BrowserWindow | null = null
let serverProcess: ChildProcess | null = null
let serverUrl = process.env.ARTIFACT_SERVER_URL ?? null
let pendingProjectPath = projectArgument(process.argv)

const stateDirectory = process.env.ARTIFACT_STATE_DIR || join(app.getPath('userData'), 'artifact-state')
const windowStatePath = join(stateDirectory, 'window-state.json')
const preferencesPath = join(stateDirectory, 'preferences.json')
const sessionToken = process.env.ARTIFACT_SESSION_TOKEN || randomUUID()
let preferences: Record<string, string> | null = null
const terminalSessions = new Map<string, { ownerId: number; process: IPty; cwd: string; shell: string }>()
const closingTerminalOwners = new Set<number>()
let embeddedBrowserView: WebContentsView | null = null
let embeddedBrowserOwnerId: number | null = null
let embeddedBrowserLoading = false
let embeddedBrowserError: string | null = null
process.env.ARTIFACT_STATE_DIR = stateDirectory
process.env.ARTIFACT_SESSION_TOKEN = sessionToken

const singleInstance = app.requestSingleInstanceLock({ projectPath: pendingProjectPath ?? '' })
if (!singleInstance) app.quit()

app.on('second-instance', (_event, argv, _workingDirectory, data) => {
  const projectPath = projectArgument(argv) ?? projectPathFromData(data)
  if (projectPath) void openProject(projectPath)
  focusMainWindow()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverUrl) createWindow(serverUrl)
  else focusMainWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  closeAllTerminalSessions()
  disposeEmbeddedBrowser()
  serverProcess?.kill('SIGTERM')
  serverProcess = null
})

if (singleInstance) {
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(__dirname, '..', '..', 'build', 'icon.png'))
    registerDesktopHandlers()
    if (pendingProjectPath) {
      await openProject(pendingProjectPath, false)
      pendingProjectPath = null
    }
    serverUrl = serverUrl ?? await startApplicationServer()
    createWindow(serverUrl)
  }).catch(error => {
    dialog.showErrorBox('Artifact 无法启动', error instanceof Error ? error.message : String(error))
    app.quit()
  })
}

function createWindow(url: string): void {
  const savedState = loadWindowState()
  const savedBounds = savedState
    ? fitWindowBounds(savedState.bounds, screen.getAllDisplays().map(display => display.workArea), 1080, 720)
    : { width: 1480, height: 940 }
  const window = new BrowserWindow({
    ...savedBounds,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#080c14',
    show: false,
    title: 'Artifact',
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })
  const ownerId = window.webContents.id
  mainWindow = window
  restoreWindowMode(window, savedState)
  registerWindowStatePersistence(window)
  window.once('ready-to-show', () => window.show())
  window.on('close', () => {
    closingTerminalOwners.add(ownerId)
    closeTerminalSessionsForOwner(ownerId)
    disposeEmbeddedBrowser()
  })
  window.on('closed', () => {
    closeTerminalSessionsForOwner(ownerId)
    disposeEmbeddedBrowser()
    if (mainWindow === window) mainWindow = null
  })
  window.webContents.on('render-process-gone', () => closeTerminalSessionsForOwner(ownerId))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.session.webRequest.onBeforeSendHeaders({ urls: [`${new URL(url).origin}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'x-artifact-session': sessionToken } })
  })
  void window.loadURL(url)
}

function loadWindowState(): DesktopWindowState | null {
  try { return parseDesktopWindowState(JSON.parse(readFileSync(windowStatePath, 'utf8')) as unknown) } catch { return null }
}

function restoreWindowMode(window: BrowserWindow, state: DesktopWindowState | null): void {
  if (!state) return
  if (state.fullScreen) window.setFullScreen(true)
  else if (state.maximized) window.maximize()
}

function registerWindowStatePersistence(window: BrowserWindow): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const save = () => {
    if (window.isDestroyed()) return
    const state: DesktopWindowState = {
      version: 1,
      bounds: window.getNormalBounds(),
      maximized: window.isMaximized(),
      fullScreen: window.isFullScreen(),
    }
    try { atomicWriteSync(windowStatePath, JSON.stringify(state, null, 2)) } catch { /* Window persistence must never prevent closing the app. */ }
  }
  const queueSave = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = null; save() }, 250)
  }
  window.on('move', queueSave)
  window.on('resize', queueSave)
  window.on('maximize', queueSave)
  window.on('unmaximize', queueSave)
  window.on('enter-full-screen', queueSave)
  window.on('leave-full-screen', queueSave)
  window.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    save()
  })
}

function atomicWriteSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, content, 'utf8')
  renameSync(temporary, path)
}

function registerDesktopHandlers(): void {
  ipcMain.on('artifact:preference:get', (event, key: unknown) => {
    event.returnValue = validPreferenceKey(key) ? loadPreferences()[key] ?? null : null
  })
  ipcMain.on('artifact:preference:set', (event, key: unknown, value: unknown) => {
    if (!validPreferenceKey(key) || typeof value !== 'string' || value.length > 4_096) { event.returnValue = false; return }
    const next = { ...loadPreferences(), [key]: value }
    try { atomicWriteSync(preferencesPath, JSON.stringify(next, null, 2)); preferences = next; event.returnValue = true } catch { event.returnValue = false }
  })
  ipcMain.on('artifact:preference:remove', (event, key: unknown) => {
    if (!validPreferenceKey(key)) { event.returnValue = false; return }
    const next = { ...loadPreferences() }
    delete next[key]
    try { atomicWriteSync(preferencesPath, JSON.stringify(next, null, 2)); preferences = next; event.returnValue = true } catch { event.returnValue = false }
  })

  ipcMain.handle('artifact:pick-project', async () => {
    const options: OpenDialogOptions = {
      title: '选择 Git 项目',
      buttonLabel: '导入项目',
      properties: ['openDirectory'],
    }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return { canceled: true as const }
    const project = await importProject(result.filePaths[0])
    mainWindow?.webContents.send('artifact:project-updated', project)
    return { canceled: false as const, project }
  })

  ipcMain.handle('artifact:pick-project-location', async () => {
    const options: OpenDialogOptions = {
      title: '选择新项目的位置',
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory'],
    }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    return result.canceled || !result.filePaths[0]
      ? { canceled: true as const }
      : { canceled: false as const, path: result.filePaths[0] }
  })

  ipcMain.handle('artifact:create-project', async (_event, parentPath: unknown, name: unknown) => {
    if (typeof parentPath !== 'string' || typeof name !== 'string') throw new Error('Project location and name are required')
    const project = await createProject(parentPath, name)
    mainWindow?.webContents.send('artifact:project-updated', project)
    return project
  })

  ipcMain.handle('artifact:show-item', async (_event, requestedPath: unknown) => {
    if (typeof requestedPath !== 'string' || !requestedPath.trim()) throw new Error('A path is required')
    const target = await realpath(resolve(requestedPath))
    const project = await loadProject()
    const allowedRoots = [stateDirectory, project?.gitRoot, project?.repositoryPath].filter((value): value is string => Boolean(value))
    const resolvedRoots = await Promise.all(allowedRoots.map(root => realpath(root).catch(() => resolve(root))))
    if (!resolvedRoots.some(root => isWithin(root, target))) throw new Error('The requested path is outside Artifact managed locations')
    shell.showItemInFolder(target)
    return { ok: true }
  })

  ipcMain.handle('artifact:diagnose-project', async (_event, path: unknown) => {
    if (typeof path !== 'string') throw new Error('A path is required')
    return diagnoseProject(path)
  })

  ipcMain.handle('artifact:app-info', () => ({ version: app.getVersion(), stateDirectory }))

  ipcMain.handle('artifact:terminal:create', async (event, requestedPath: unknown) => {
    if (terminalOwnerUnavailable(event.sender)) return terminalCreationFailure('窗口正在关闭，未启动终端。')
    try {
      const cwd = await terminalDirectory(requestedPath)
      if (terminalOwnerUnavailable(event.sender)) return terminalCreationFailure('窗口正在关闭，未启动终端。')
      const shellPath = terminalShell()
      const sessionId = `terminal-${randomUUID()}`
      let process: IPty
      try {
        process = spawnPty(shellPath, [], {
          name: 'xterm-256color',
          cols: 100,
          rows: 30,
          cwd,
          env: terminalEnvironment(),
        })
      } catch (error) {
        return terminalCreationFailure(terminalSpawnError(error, shellPath, cwd))
      }
      if (terminalOwnerUnavailable(event.sender)) {
        closeTerminalProcess(process)
        return terminalCreationFailure('窗口正在关闭，未启动终端。')
      }
      terminalSessions.set(sessionId, { ownerId: event.sender.id, process, cwd, shell: shellPath })
      process.onData(data => {
        if (!event.sender.isDestroyed()) event.sender.send('artifact:terminal:data', { sessionId, data })
      })
      process.onExit(({ exitCode, signal }) => {
        if (!event.sender.isDestroyed()) event.sender.send('artifact:terminal:exit', { sessionId, exitCode, signal })
        terminalSessions.delete(sessionId)
      })
      return { ok: true as const, sessionId, cwd, shell: shellPath, pid: process.pid }
    } catch (error) {
      return terminalCreationFailure(error instanceof Error ? error.message : '无法启动终端。')
    }
  })
  ipcMain.on('artifact:terminal:write', (event, sessionId: unknown, data: unknown) => {
    const session = ownedTerminalSession(event.sender.id, sessionId)
    if (session && typeof data === 'string' && data.length <= 65_536) session.process.write(data)
  })
  ipcMain.on('artifact:terminal:resize', (event, sessionId: unknown, cols: unknown, rows: unknown) => {
    const session = ownedTerminalSession(event.sender.id, sessionId)
    if (!session || typeof cols !== 'number' || typeof rows !== 'number') return
    session.process.resize(Math.max(20, Math.min(500, Math.round(cols))), Math.max(5, Math.min(200, Math.round(rows))))
  })
  ipcMain.handle('artifact:terminal:close', (event, sessionId: unknown) => {
    const session = ownedTerminalSession(event.sender.id, sessionId)
    if (!session || typeof sessionId !== 'string') return { ok: false }
    terminalSessions.delete(sessionId)
    closeTerminalProcess(session.process)
    return { ok: true }
  })

  ipcMain.handle('artifact:browser:show', event => {
    const view = ensureEmbeddedBrowser(event.sender.id)
    view.setVisible(true)
    return embeddedBrowserState()
  })
  ipcMain.on('artifact:browser:set-bounds', (event, value: unknown) => {
    if (event.sender.id !== embeddedBrowserOwnerId || !embeddedBrowserView) return
    const bounds = browserBounds(value)
    if (!bounds) { embeddedBrowserView.setVisible(false); return }
    embeddedBrowserView.setBounds(bounds)
    embeddedBrowserView.setVisible(true)
  })
  ipcMain.on('artifact:browser:hide', event => {
    if (event.sender.id === embeddedBrowserOwnerId) embeddedBrowserView?.setVisible(false)
  })
  ipcMain.handle('artifact:browser:navigate', async (event, value: unknown) => {
    const view = ensureEmbeddedBrowser(event.sender.id)
    const url = normalizedBrowserUrl(value)
    embeddedBrowserError = null
    view.setVisible(true)
    await view.webContents.loadURL(url)
    return embeddedBrowserState()
  })
  ipcMain.handle('artifact:browser:back', event => {
    if (event.sender.id === embeddedBrowserOwnerId && embeddedBrowserView?.webContents.navigationHistory.canGoBack()) embeddedBrowserView.webContents.navigationHistory.goBack()
    return embeddedBrowserState()
  })
  ipcMain.handle('artifact:browser:forward', event => {
    if (event.sender.id === embeddedBrowserOwnerId && embeddedBrowserView?.webContents.navigationHistory.canGoForward()) embeddedBrowserView.webContents.navigationHistory.goForward()
    return embeddedBrowserState()
  })
  ipcMain.handle('artifact:browser:reload', event => {
    if (event.sender.id === embeddedBrowserOwnerId && embeddedBrowserView) embeddedBrowserView.webContents.reload()
    return embeddedBrowserState()
  })
  ipcMain.handle('artifact:browser:stop', event => {
    if (event.sender.id === embeddedBrowserOwnerId && embeddedBrowserView) embeddedBrowserView.webContents.stop()
    return embeddedBrowserState()
  })
  ipcMain.handle('artifact:browser:open-external', async event => {
    const url = event.sender.id === embeddedBrowserOwnerId ? embeddedBrowserView?.webContents.getURL() : ''
    if (!url || !/^https?:/i.test(url)) return { ok: false }
    await shell.openExternal(url)
    return { ok: true }
  })
}

async function terminalDirectory(requestedPath: unknown): Promise<string> {
  const project = await loadProject()
  if (!project) throw new Error('请先导入项目再打开终端')
  const roots = await Promise.all([project.gitRoot, project.repositoryPath].map(path => realpath(path).catch(() => resolve(path))))
  const requested = typeof requestedPath === 'string' && requestedPath.trim() ? requestedPath : project.gitRoot
  const target = await realpath(resolve(requested)).catch(() => null)
  if (target) {
    if (roots.some(root => isWithin(root, target))) return target
    return managedTerminalDirectory(requested, project.gitRoot, stateDirectory)
  }
  if (typeof requestedPath === 'string' && requestedPath.trim()) throw new Error('指定的终端工作目录不存在，请刷新 Run 状态')
  const projectRoot = roots.find(root => {
    try { return statSync(root).isDirectory() } catch { return false }
  })
  if (projectRoot) return projectRoot
  throw new Error('当前项目目录不可用，无法启动终端')
}

function terminalShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash'].filter((path): path is string => Boolean(path))
  const executable = candidates.find(path => {
    try {
      const stat = statSync(path)
      return stat.isFile() && (stat.mode & 0o111) !== 0
    } catch { return false }
  })
  if (!executable) throw new Error('找不到可执行的交互式 Shell，请确认 /bin/zsh 或 /bin/bash 可用')
  return executable
}

function terminalOwnerUnavailable(sender: Electron.WebContents): boolean {
  return sender.isDestroyed() || closingTerminalOwners.has(sender.id)
}

function terminalCreationFailure(error: string) {
  return { ok: false as const, error }
}

function terminalSpawnError(error: unknown, shellPath: string, cwd: string): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `无法启动终端（${shellPath}，工作目录：${cwd}）。${detail}`
}

function terminalEnvironment(): Record<string, string> {
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  delete environment.ARTIFACT_SESSION_TOKEN
  environment.TERM = 'xterm-256color'
  environment.COLORTERM = 'truecolor'
  return environment
}

function ownedTerminalSession(ownerId: number, sessionId: unknown) {
  if (typeof sessionId !== 'string') return null
  const session = terminalSessions.get(sessionId)
  return session?.ownerId === ownerId ? session : null
}

function closeTerminalSessionsForOwner(ownerId: number): void {
  for (const [sessionId, session] of terminalSessions) {
    if (session.ownerId !== ownerId) continue
    terminalSessions.delete(sessionId)
    closeTerminalProcess(session.process)
  }
}

function closeAllTerminalSessions(): void {
  for (const session of terminalSessions.values()) {
    closeTerminalProcess(session.process)
  }
  terminalSessions.clear()
}

function closeTerminalProcess(process: IPty): void {
  try { process.kill() } catch { /* The shell may already have exited. */ }
}

function ensureEmbeddedBrowser(ownerId: number): WebContentsView {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('主窗口不可用')
  if (embeddedBrowserView && embeddedBrowserOwnerId === ownerId) return embeddedBrowserView
  disposeEmbeddedBrowser()
  const view = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, partition: 'persist:artifact-browser' } })
  embeddedBrowserView = view
  embeddedBrowserOwnerId = ownerId
  view.setBackgroundColor('#ffffff')
  view.setVisible(false)
  mainWindow.contentView.addChildView(view)
  const sendState = () => sendEmbeddedBrowserState()
  view.webContents.on('did-start-loading', () => { embeddedBrowserLoading = true; embeddedBrowserError = null; sendState() })
  view.webContents.on('did-stop-loading', () => { embeddedBrowserLoading = false; sendState() })
  view.webContents.on('did-navigate', sendState)
  view.webContents.on('did-navigate-in-page', sendState)
  view.webContents.on('page-title-updated', sendState)
  view.webContents.on('did-fail-load', (_event, code, description) => {
    if (code !== -3) embeddedBrowserError = description
    embeddedBrowserLoading = false
    sendState()
  })
  view.webContents.setWindowOpenHandler(details => {
    try { void view.webContents.loadURL(normalizedBrowserUrl(details.url)) } catch { /* Invalid popup URLs stay blocked. */ }
    return { action: 'deny' }
  })
  view.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  return view
}

function browserBounds(value: unknown): Rectangle | null {
  if (!value || typeof value !== 'object') return null
  const bounds = value as Partial<Rectangle>
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(item => typeof item === 'number' && Number.isFinite(item))) return null
  const width = Math.max(0, Math.round(bounds.width!))
  const height = Math.max(0, Math.round(bounds.height!))
  if (width < 40 || height < 40) return null
  return { x: Math.max(0, Math.round(bounds.x!)), y: Math.max(0, Math.round(bounds.y!)), width, height }
}

function normalizedBrowserUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('请输入网页地址')
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`
  const url = new URL(candidate)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('内置浏览器仅支持 HTTP 和 HTTPS 地址')
  return url.toString()
}

function embeddedBrowserState() {
  const contents = embeddedBrowserView?.webContents
  return {
    url: contents?.getURL() || '',
    title: contents?.getTitle() || '',
    canGoBack: contents?.navigationHistory.canGoBack() ?? false,
    canGoForward: contents?.navigationHistory.canGoForward() ?? false,
    loading: embeddedBrowserLoading,
    error: embeddedBrowserError,
  }
}

function sendEmbeddedBrowserState(): void {
  if (!mainWindow || mainWindow.isDestroyed() || embeddedBrowserOwnerId !== mainWindow.webContents.id) return
  mainWindow.webContents.send('artifact:browser:state', embeddedBrowserState())
}

function disposeEmbeddedBrowser(): void {
  if (!embeddedBrowserView) return
  try { mainWindow?.contentView.removeChildView(embeddedBrowserView) } catch { /* The parent window may already be gone. */ }
  if (!embeddedBrowserView.webContents.isDestroyed()) embeddedBrowserView.webContents.close()
  embeddedBrowserView = null
  embeddedBrowserOwnerId = null
  embeddedBrowserLoading = false
  embeddedBrowserError = null
}

function loadPreferences(): Record<string, string> {
  if (preferences) return preferences
  try {
    const value = JSON.parse(readFileSync(preferencesPath, 'utf8')) as unknown
    preferences = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key, item]) => validPreferenceKey(key) && typeof item === 'string' && item.length <= 4_096))
      : {}
  } catch { preferences = {} }
  return preferences
}

function validPreferenceKey(value: unknown): value is string {
  return typeof value === 'string' && /^artifact\.[a-z0-9.-]{1,100}$/.test(value)
}

async function openProject(path: string, notifyRenderer = true): Promise<void> {
  try {
    const project = await importProject(path)
    if (notifyRenderer) mainWindow?.webContents.send('artifact:project-updated', project)
  } catch (error) {
    if (app.isReady()) dialog.showErrorBox('无法打开项目', error instanceof Error ? error.message : String(error))
  }
}

async function startApplicationServer(): Promise<string> {
  const port = await availablePort()
  const applicationRoot = join(process.resourcesPath, 'app-next')
  const serverEntry = join(applicationRoot, 'server.js')
  const bundledNodeModules = app.isPackaged
    ? join(process.resourcesPath, 'app.asar', 'node_modules')
    : null
  const nodePath = [process.env.NODE_PATH, bundledNodeModules].filter((value): value is string => Boolean(value)).join(delimiter)
  const url = `http://127.0.0.1:${port}`
  await mkdir(stateDirectory, { recursive: true })
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: applicationRoot,
    env: {
      ...process.env,
      ARTIFACT_STATE_DIR: stateDirectory,
      ARTIFACT_SESSION_TOKEN: sessionToken,
      ELECTRON_RUN_AS_NODE: '1',
      HOSTNAME: '127.0.0.1',
      ...(nodePath ? { NODE_PATH: nodePath } : {}),
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const logPath = join(stateDirectory, 'server.log')
  serverProcess.stdout?.on('data', chunk => { void appendFile(logPath, chunk) })
  serverProcess.stderr?.on('data', chunk => { void appendFile(logPath, chunk) })
  await waitForServer(url, serverProcess)
  return url
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 30_000) {
    if (child.exitCode !== null) throw new Error(`Local server exited with code ${child.exitCode}. See ${join(stateDirectory, 'server.log')}`)
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch { /* Server is still starting. */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 150))
  }
  throw new Error(`Local server did not start. See ${join(stateDirectory, 'server.log')}`)
}

function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Unable to allocate a local port')); return }
      server.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}

function projectArgument(argv: string[]): string | null {
  const index = argv.indexOf('--project')
  return index >= 0 && argv[index + 1] ? resolve(argv[index + 1]) : null
}

function projectPathFromData(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('projectPath' in data)) return null
  const value = (data as { projectPath?: unknown }).projectPath
  return typeof value === 'string' && value.trim() ? resolve(value) : null
}

function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}
