import type { ProjectConfig, ProjectDiagnostic } from '../project'

type ProjectPickerResult =
  | { canceled: true }
  | { canceled: false; project: ProjectConfig }

type ProjectLocationPickerResult =
  | { canceled: true }
  | { canceled: false; path: string }

type TerminalSessionInfo = { ok: true; sessionId: string; cwd: string; shell: string; pid: number }
type TerminalCreationFailure = { ok: false; error: string }
type TerminalExitEvent = { sessionId: string; exitCode: number; signal?: number }
type EmbeddedBrowserState = { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean; error: string | null }

declare global {
  interface Window {
    artifactDesktop?: {
      readonly isDesktop: true
      getPreference: (key: string) => string | null
      setPreference: (key: string, value: string) => boolean
      removePreference: (key: string) => boolean
      pickProject: () => Promise<ProjectPickerResult>
      pickProjectLocation: () => Promise<ProjectLocationPickerResult>
      createProject: (parentPath: string, name: string) => Promise<ProjectConfig>
      showItem: (path: string) => Promise<{ ok: true }>
      diagnoseProject: (path: string) => Promise<ProjectDiagnostic>
      getAppInfo: () => Promise<{ version: string; stateDirectory: string }>
      createTerminal: (cwd?: string) => Promise<TerminalSessionInfo | TerminalCreationFailure>
      writeTerminal: (sessionId: string, data: string) => void
      resizeTerminal: (sessionId: string, cols: number, rows: number) => void
      closeTerminal: (sessionId: string) => Promise<{ ok: boolean }>
      onTerminalData: (callback: (event: { sessionId: string; data: string }) => void) => () => void
      onTerminalExit: (callback: (event: TerminalExitEvent) => void) => () => void
      showBrowser: () => Promise<EmbeddedBrowserState>
      setBrowserBounds: (bounds: { x: number; y: number; width: number; height: number }) => void
      hideBrowser: () => void
      navigateBrowser: (url: string) => Promise<EmbeddedBrowserState>
      browserBack: () => Promise<EmbeddedBrowserState>
      browserForward: () => Promise<EmbeddedBrowserState>
      browserReload: () => Promise<EmbeddedBrowserState>
      browserStop: () => Promise<EmbeddedBrowserState>
      openBrowserExternal: () => Promise<{ ok: boolean }>
      onBrowserState: (callback: (state: EmbeddedBrowserState) => void) => () => void
      onProjectUpdated: (callback: () => void) => () => void
    }
  }
}

export {}
