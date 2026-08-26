import type { ProjectConfig, ProjectDiagnostic } from '../project'

type ProjectPickerResult =
  | { canceled: true }
  | { canceled: false; project: ProjectConfig }

type ProjectLocationPickerResult =
  | { canceled: true }
  | { canceled: false; path: string }

declare global {
  interface Window {
    artifactDesktop?: {
      readonly isDesktop: true
      pickProject: () => Promise<ProjectPickerResult>
      pickProjectLocation: () => Promise<ProjectLocationPickerResult>
      createProject: (parentPath: string, name: string) => Promise<ProjectConfig>
      showItem: (path: string) => Promise<{ ok: true }>
      diagnoseProject: (path: string) => Promise<ProjectDiagnostic>
      getAppInfo: () => Promise<{ version: string; stateDirectory: string }>
      onProjectUpdated: (callback: () => void) => () => void
    }
  }
}

export {}
