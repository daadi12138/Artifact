import { isAbsolute, relative, sep } from 'node:path'

export type PermissionMode = 'read_only' | 'workspace_write'
export type ToolKind = 'shell' | 'agent' | 'file_read' | 'file_write'
export type ToolRisk = 'low' | 'medium' | 'high'
export type PermissionDecision = 'allow' | 'approval_required' | 'deny'

export type PermissionRequest = {
  tool: ToolKind
  mode: PermissionMode
  cwd?: string
  workspaceRoot?: string
  command?: string
  approved?: boolean
}

export type PermissionResult = {
  decision: PermissionDecision
  risk: ToolRisk
  reason: string
}

export function assessPermission(request: PermissionRequest): PermissionResult {
  const boundary = request.cwd && request.workspaceRoot ? withinWorkspace(request.cwd, request.workspaceRoot) : true
  if (!boundary) return { decision: 'deny', risk: 'high', reason: 'Tool working directory is outside the run Worktree.' }
  if (request.tool === 'file_write' && request.mode === 'read_only') return { decision: 'deny', risk: 'high', reason: 'File writes are not allowed in read-only mode.' }
  if (request.tool === 'shell') {
    const risk = commandRisk(request.command ?? '')
    if (risk === 'high') return { decision: request.approved ? 'allow' : 'approval_required', risk, reason: 'This command can delete files, alter Git history, or access data outside the Worktree.' }
    if (risk === 'medium' && !request.approved) return { decision: 'approval_required', risk, reason: 'This command can change dependencies or project state and needs explicit approval.' }
    return { decision: 'allow', risk, reason: 'Command is within the Worktree policy.' }
  }
  return { decision: 'allow', risk: request.tool === 'agent' ? 'medium' : 'low', reason: 'Tool is allowed by the current permission mode.' }
}

export function withinWorkspace(candidate: string, workspaceRoot: string): boolean {
  const relativePath = relative(workspaceRoot, candidate)
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
}

export function commandRisk(command: string): ToolRisk {
  const normalized = command.trim().toLowerCase()
  if (!normalized) return 'medium'
  if (/(^|[;&|\s])(rm|rmdir|del|format|mkfs|shutdown|reboot)\b/.test(normalized) || /git\s+(reset|clean|checkout|push|commit|rebase)\b/.test(normalized) || /\b(sudo|chmod\s+777|curl\s+[^|]+\|\s*(sh|bash)|wget\s+[^|]+\|\s*(sh|bash))\b/.test(normalized)) return 'high'
  if (/\b(npm|pnpm|yarn|pip|uv|poetry|cargo|go)\s+(install|add|remove|update|upgrade|clean|mod\s+tidy)\b/.test(normalized)) return 'medium'
  return 'low'
}
