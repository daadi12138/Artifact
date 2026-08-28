import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import { createProject, diagnoseProject, importProject, loadProject } from '../src/core/index'

let mainWindow: BrowserWindow | null = null
let serverProcess: ChildProcess | null = null
let serverUrl = process.env.ARTIFACT_SERVER_URL ?? null
let pendingProjectPath = projectArgument(process.argv)

const stateDirectory = process.env.ARTIFACT_STATE_DIR || join(app.getPath('userData'), 'artifact-state')
const sessionToken = process.env.ARTIFACT_SESSION_TOKEN || randomUUID()
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
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
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
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', event => event.preventDefault())
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders({ urls: [`${new URL(url).origin}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'x-artifact-session': sessionToken } })
  })
  void mainWindow.loadURL(url)
}

function registerDesktopHandlers(): void {
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
