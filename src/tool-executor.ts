import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { assessPermission, withinWorkspace, type PermissionDecision, type PermissionMode, type ToolKind, type ToolRisk } from './permission-policy'

export type ToolExecutionContext = {
  cwd: string
  workspaceRoot: string
  mode: PermissionMode
  approved?: boolean
  attemptId?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  processRegistry?: Map<string, ChildProcess>
  onSpawn?: (process: { pid: number; commandHash: string; startedAt: string }) => void | Promise<void>
  onStdoutLine?: (line: string) => void | Promise<void>
}

export type ToolExecutionResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
  risk: ToolRisk
  permission: PermissionDecision
  reason: string
  value?: unknown
}

export type ToolExecutor<TInput = unknown> = {
  kind: ToolKind
  execute(input: TInput, context: ToolExecutionContext): Promise<ToolExecutionResult>
}

export type ShellToolInput = { command: string }
export type FileToolInput = { operation: 'read' | 'write'; path: string; content?: string }
export type AgentToolInput = { runner: (input: unknown) => Promise<unknown>; input: unknown }

const maxOutput = 2_000_000
const maxLineLength = 1_000_000

function commandHash(command: string, cwd: string): string {
  return createHash('sha256').update(JSON.stringify({ command, cwd })).digest('hex')
}

export class ShellTool implements ToolExecutor<ShellToolInput> {
  readonly kind = 'shell' as const

  async execute(input: ShellToolInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const command = typeof input?.command === 'string' ? input.command.trim() : ''
    const permission = assessPermission({
      tool: 'shell',
      mode: context.mode,
      cwd: context.cwd,
      workspaceRoot: context.workspaceRoot,
      command,
      approved: context.approved,
    })
    const startedAt = Date.now()
    if (permission.decision !== 'allow') {
      return { stdout: '', stderr: '', exitCode: null, durationMs: 0, risk: permission.risk, permission: permission.decision, reason: permission.reason }
    }
    if (!command) throw new Error('Shell command is required')
    if (!withinWorkspace(context.cwd, context.workspaceRoot)) throw new Error('Unsafe working directory: outside the run Worktree')
    const timeoutMs = context.timeoutMs ?? 120_000
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) throw new Error('Invalid timeout')
    const shell = process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : process.env.SHELL && isAbsolute(process.env.SHELL) ? process.env.SHELL : '/bin/sh'
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-lc', command]
    const result = await runProcess(shell, args, context.cwd, timeoutMs, context, commandHash(command, context.cwd))
    return { ...result, durationMs: Date.now() - startedAt, risk: permission.risk, permission: permission.decision, reason: permission.reason }
  }
}

export class FileTool implements ToolExecutor<FileToolInput> {
  readonly kind: 'file_read' | 'file_write'

  constructor(kind: 'file_read' | 'file_write' = 'file_read') {
    this.kind = kind
  }

  async execute(input: FileToolInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const operation = input?.operation
    if (typeof input?.path !== 'string' || !input.path.trim()) throw new Error('File path is required')
    const tool = operation === 'write' ? 'file_write' : 'file_read'
    if (tool !== this.kind) throw new Error(`FileTool ${this.kind} cannot execute ${tool}`)
    const target = resolve(context.cwd, input.path)
    const permission = assessPermission({ tool, mode: context.mode, cwd: target, workspaceRoot: context.workspaceRoot })
    const startedAt = Date.now()
    if (permission.decision !== 'allow') return { stdout: '', stderr: '', exitCode: null, durationMs: 0, risk: permission.risk, permission: permission.decision, reason: permission.reason }
    if (!target || !withinWorkspace(target, context.workspaceRoot)) throw new Error('Unsafe file path: outside the run Worktree')
    if (operation === 'read') {
      const content = await readFile(target, 'utf8')
      return { stdout: content, stderr: '', exitCode: 0, durationMs: Date.now() - startedAt, risk: permission.risk, permission: permission.decision, reason: permission.reason }
    }
    if (operation !== 'write' || typeof input.content !== 'string') throw new Error('File write requires string content')
    if (input.content.length > maxOutput) throw new Error('File content exceeds the 2 MB tool limit')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, input.content, 'utf8')
    return { stdout: '', stderr: '', exitCode: 0, durationMs: Date.now() - startedAt, risk: permission.risk, permission: permission.decision, reason: permission.reason }
  }
}

/**
 * Adapter boundary for coding agents. The concrete Codex/Claude runner stays
 * outside this module, while permission and result normalization remain
 * consistent with every other tool.
 */
export class AgentTool implements ToolExecutor<AgentToolInput> {
  readonly kind = 'agent' as const

  async execute(input: AgentToolInput, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const permission = assessPermission({
      tool: 'agent',
      mode: context.mode,
      cwd: context.cwd,
      workspaceRoot: context.workspaceRoot,
      approved: context.approved,
    })
    if (permission.decision !== 'allow') {
      return { stdout: '', stderr: '', exitCode: null, durationMs: 0, risk: permission.risk, permission: permission.decision, reason: permission.reason }
    }
    if (typeof input?.runner !== 'function') throw new Error('Agent runner is required')
    const startedAt = Date.now()
    const value = await input.runner(input.input)
    const output = typeof value === 'string' ? value : value && typeof value === 'object' && typeof (value as { output?: unknown }).output === 'string' ? (value as { output: string }).output : ''
    return { stdout: output, stderr: '', exitCode: 0, durationMs: Date.now() - startedAt, risk: permission.risk, permission: permission.decision, reason: permission.reason, value }
  }
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number, context: ToolExecutionContext, processCommandHash: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: context.env ?? process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    if (context.attemptId) context.processRegistry?.set(context.attemptId, child)
    const spawnPromise = child.pid && context.onSpawn ? Promise.resolve(context.onSpawn({ pid: child.pid, commandHash: processCommandHash, startedAt: new Date().toISOString() })) : Promise.resolve()
    child.stdout!.setEncoding('utf8')
    child.stderr!.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    let remainder = ''
    let callbacks = Promise.resolve()
    let callbackError: unknown
    let settled = false
    let timedOut = false
    let forceKillTimer: NodeJS.Timeout | undefined
    const appendBounded = (current: string, value: string) => current.length >= maxOutput ? current : current + value.slice(0, maxOutput - current.length)
    const queueLine = (line: string) => {
      if (!context.onStdoutLine || !line.trim()) return
      callbacks = callbacks.then(async () => {
        try { await context.onStdoutLine?.(line.slice(0, maxLineLength)) } catch (error) { callbackError ??= error }
      })
    }
    child.stdout!.on('data', (value: string) => {
      stdout = appendBounded(stdout, value)
      if (!context.onStdoutLine) return
      const lines = `${remainder}${value}`.split(/\r?\n/)
      remainder = lines.pop() ?? ''
      for (const line of lines) queueLine(line)
      if (remainder.length > maxLineLength) { queueLine(remainder); remainder = '' }
    })
    child.stderr!.on('data', (value: string) => { stderr = appendBounded(stderr, value) })
    const finish = (handler: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (context.attemptId) context.processRegistry?.delete(context.attemptId)
      handler()
    }
    const drain = () => { queueLine(remainder); return Promise.all([callbacks, spawnPromise]) }
    const timer = setTimeout(() => {
      timedOut = true
      terminateProcess(child, 'SIGTERM')
      forceKillTimer = setTimeout(() => { if (!settled) terminateProcess(child, 'SIGKILL') }, 5_000)
    }, timeoutMs)
    const settle = (handler: () => void) => {
      void drain().then(() => finish(handler), error => finish(() => reject(error)))
    }
    child.on('error', error => settle(() => reject(error)))
    child.on('close', code => settle(() => {
      if (callbackError) return reject(callbackError)
      if (timedOut) return reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`))
      const exitCode = typeof code === 'number' ? code : null
      if (exitCode !== 0) return reject(new Error(stderr.trim() || `${command} exited with code ${exitCode ?? 'unknown'}`))
      resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode })
    }))
  })
}

function terminateProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try { child.kill(signal) } catch { /* The process may already have exited. */ }
  }
}
