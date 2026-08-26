import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('artifactDesktop', {
  isDesktop: true,
  pickProject: () => ipcRenderer.invoke('artifact:pick-project'),
  pickProjectLocation: () => ipcRenderer.invoke('artifact:pick-project-location'),
  createProject: (parentPath: string, name: string) => ipcRenderer.invoke('artifact:create-project', parentPath, name),
  showItem: (path: string) => ipcRenderer.invoke('artifact:show-item', path),
  diagnoseProject: (path: string) => ipcRenderer.invoke('artifact:diagnose-project', path),
  getAppInfo: () => ipcRenderer.invoke('artifact:app-info'),
  onProjectUpdated: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('artifact:project-updated', listener)
    return () => ipcRenderer.removeListener('artifact:project-updated', listener)
  },
})
