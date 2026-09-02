import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('artifactDesktop', {
  isDesktop: true,
  getPreference: (key: string) => ipcRenderer.sendSync('artifact:preference:get', key) as string | null,
  setPreference: (key: string, value: string) => ipcRenderer.sendSync('artifact:preference:set', key, value) as boolean,
  removePreference: (key: string) => ipcRenderer.sendSync('artifact:preference:remove', key) as boolean,
  pickProject: () => ipcRenderer.invoke('artifact:pick-project'),
  pickProjectLocation: () => ipcRenderer.invoke('artifact:pick-project-location'),
  createProject: (parentPath: string, name: string) => ipcRenderer.invoke('artifact:create-project', parentPath, name),
  showItem: (path: string) => ipcRenderer.invoke('artifact:show-item', path),
  diagnoseProject: (path: string) => ipcRenderer.invoke('artifact:diagnose-project', path),
  getAppInfo: () => ipcRenderer.invoke('artifact:app-info'),
  createTerminal: (cwd?: string) => ipcRenderer.invoke('artifact:terminal:create', cwd),
  writeTerminal: (sessionId: string, data: string) => ipcRenderer.send('artifact:terminal:write', sessionId, data),
  resizeTerminal: (sessionId: string, cols: number, rows: number) => ipcRenderer.send('artifact:terminal:resize', sessionId, cols, rows),
  closeTerminal: (sessionId: string) => ipcRenderer.invoke('artifact:terminal:close', sessionId),
  onTerminalData: (callback: (event: { sessionId: string; data: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { sessionId: string; data: string }) => callback(value)
    ipcRenderer.on('artifact:terminal:data', listener)
    return () => ipcRenderer.removeListener('artifact:terminal:data', listener)
  },
  onTerminalExit: (callback: (event: { sessionId: string; exitCode: number; signal?: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { sessionId: string; exitCode: number; signal?: number }) => callback(value)
    ipcRenderer.on('artifact:terminal:exit', listener)
    return () => ipcRenderer.removeListener('artifact:terminal:exit', listener)
  },
  showBrowser: () => ipcRenderer.invoke('artifact:browser:show'),
  setBrowserBounds: (bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.send('artifact:browser:set-bounds', bounds),
  hideBrowser: () => ipcRenderer.send('artifact:browser:hide'),
  navigateBrowser: (url: string) => ipcRenderer.invoke('artifact:browser:navigate', url),
  browserBack: () => ipcRenderer.invoke('artifact:browser:back'),
  browserForward: () => ipcRenderer.invoke('artifact:browser:forward'),
  browserReload: () => ipcRenderer.invoke('artifact:browser:reload'),
  browserStop: () => ipcRenderer.invoke('artifact:browser:stop'),
  openBrowserExternal: () => ipcRenderer.invoke('artifact:browser:open-external'),
  onBrowserState: (callback: (state: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean; error: string | null }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean; error: string | null }) => callback(value)
    ipcRenderer.on('artifact:browser:state', listener)
    return () => ipcRenderer.removeListener('artifact:browser:state', listener)
  },
  onProjectUpdated: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('artifact:project-updated', listener)
    return () => ipcRenderer.removeListener('artifact:project-updated', listener)
  },
})
