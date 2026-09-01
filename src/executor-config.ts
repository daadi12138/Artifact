import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type ExecutorConfig = {
  id: string
  name: string
  type: string
  version: string
  status: 'available' | 'unconfigured'
  icon: string
  tone: string
  path: string
  model: string
  modelCatalog?: ExecutorModelCatalog
  profile: string
  capabilities: string[]
  authentication: ExecutorAuthenticationState
  authenticationCheckedAt?: string
}

export type ExecutorAuthenticationState = 'authenticated' | 'api_key' | 'needs_login' | 'unknown'

export type ExecutorModelOption = {
  value: string
  label: string
}

export type ExecutorModelCatalog = {
  source: 'codex-cli-catalog' | 'claude-cli-help'
  discoveredAt: string
  cliVersion: string
  modelOptions: ExecutorModelOption[]
  availabilityNote: string
}

export type ExecutorInstallPlan = {
  command: string
  args: string[]
  display: string
  packageName?: string
}

export type ExecutorDefinition = Pick<ExecutorConfig, 'id' | 'name' | 'type' | 'icon' | 'tone' | 'model' | 'profile' | 'capabilities'> & {
  command: string
  versionArgs: string[]
  modelOptions: ExecutorModelOption[]
  installPlan?: ExecutorInstallPlan
}

export type ExecutorEnvironmentState = 'ready' | 'not_installed' | 'error'

export type ExecutorEnvironment = Pick<ExecutorDefinition, 'id' | 'name' | 'type' | 'icon' | 'tone' | 'capabilities' | 'modelOptions'> & {
  command: string
  platform: string
  state: ExecutorEnvironmentState
  connected: boolean
  executablePath?: string
  currentVersion?: string
  latestVersion?: string
  error?: string
  installPlan?: Pick<ExecutorInstallPlan, 'display'>
  authentication: ExecutorAuthenticationState
  model: string
  modelCatalog?: ExecutorModelCatalog
}

export type ExecutorEnvironmentReport = {
  scannedAt: string
  executors: ExecutorEnvironment[]
  updateCount: number
}

export type ExecutorInstallationConflict = {
  id: string
  name: string
  command: string
  paths: string[]
}

export type ExecutorInstallationDiagnostic = {
  checkedAt: string
  conflicts: ExecutorInstallationConflict[]
}

export type ExecutorMaintenanceResult = {
  id: string
  action: 'install' | 'update'
  ok: boolean
  output?: string
  error?: string
}

// Each entry has a production Run adapter. Keep this registry aligned with run-manager.ts.
// Every command here is reviewed and static. The UI never accepts a shell command from a user.
export const executorDefinitions: ExecutorDefinition[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    type: 'Anthropic Coding Agent',
    icon: 'C',
    tone: 'orange',
    command: 'claude',
    versionArgs: ['--version'],
    model: '',
    modelOptions: [
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
      { value: 'haiku', label: 'Haiku' },
      { value: '', label: '使用 Claude Code 默认模型' },
    ],
    profile: 'coding-safe',
    capabilities: ['流式输出', '结构化输出', '隔离 Worktree'],
    installPlan: npmInstallPlan('@anthropic-ai/claude-code'),
  },
  {
    id: 'codex',
    name: 'Codex',
    type: 'OpenAI Coding Agent',
    icon: '✦',
    tone: 'blue',
    command: 'codex',
    versionArgs: ['--version'],
    model: '',
    modelOptions: [
      { value: 'gpt-5-codex', label: 'gpt-5-codex' },
      { value: '', label: '使用 Codex CLI 默认模型' },
    ],
    profile: 'coding-safe',
    capabilities: ['流式输出', '结构化输出', '工具审批'],
    installPlan: npmInstallPlan('@openai/codex'),
  },
]

export const defaultExecutorConfigs: ExecutorConfig[] = executorDefinitions.map(definition => ({
  id: definition.id,
  name: definition.name,
  type: definition.type,
  version: '',
  status: 'unconfigured',
  icon: definition.icon,
  tone: definition.tone,
  path: definition.command,
  model: definition.model,
  profile: definition.profile,
  capabilities: definition.capabilities,
  authentication: 'unknown',
}))

function npmInstallPlan(packageName: string): ExecutorInstallPlan {
  return {
    command: 'npm',
    args: ['install', '--global', `${packageName}@latest`],
    display: `npm install --global ${packageName}@latest`,
    packageName,
  }
}

function configPath(): string { return join(process.env.ARTIFACT_STATE_DIR || join(process.cwd(), '.artifact'), 'executors.json') }

export async function loadExecutorConfigs(): Promise<ExecutorConfig[]> {
  try {
    return mergeExecutorConfigs(JSON.parse(await readFile(configPath(), 'utf8')) as ExecutorConfig[])
  } catch {
    return defaultExecutorConfigs.map(config => ({ ...config, capabilities: [...config.capabilities] }))
  }
}

export function mergeExecutorConfigs(configs: ExecutorConfig[]): ExecutorConfig[] {
  const existing = new Map(configs.filter(config => config && typeof config.id === 'string').map(config => [config.id, config]))
  return defaultExecutorConfigs.map(config => {
    const saved = existing.get(config.id)
    const modelCatalog = normalizeModelCatalog(saved?.modelCatalog)
    return {
      ...config,
      ...saved,
      modelCatalog,
      model: modelIsAllowed(config.id, saved?.model, modelCatalog) ? saved!.model : config.model,
      capabilities: saved?.capabilities?.length ? saved.capabilities : config.capabilities,
      authentication: normalizeAuthentication(saved?.authentication),
    }
  })
}

export async function saveExecutorConfigs(configs: ExecutorConfig[]): Promise<void> {
  const path = configPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(mergeExecutorConfigs(configs), null, 2), 'utf8')
}

export function executorDefinition(id: string): ExecutorDefinition | undefined {
  return executorDefinitions.find(definition => definition.id === id)
}

export function modelIsAllowed(id: string, value: string | undefined, catalog?: ExecutorModelCatalog): boolean {
  const definition = executorDefinition(id)
  return Boolean(definition && typeof value === 'string' && modelOptionsFor(definition, catalog).some(option => option.value === value))
}

export async function configureExecutor(id: string, input: { model: string }): Promise<ExecutorConfig> {
  const definition = executorDefinition(id)
  if (!definition) throw new Error('Unsupported executor')
  const configs = await loadExecutorConfigs()
  const existing = configs.find(config => config.id === id)
  if (!modelIsAllowed(id, input.model, existing?.modelCatalog)) throw new Error('Unsupported model selection')
  const updated = configs.map(config => config.id === id ? { ...config, model: input.model } : config)
  await saveExecutorConfigs(updated)
  return updated.find(config => config.id === id)!
}

export async function executableExists(command: string): Promise<boolean> {
  return Boolean(await resolveExecutable(command))
}

export async function resolveExecutable(command: string): Promise<string | undefined> {
  const target = command.trim()
  if (!target) return undefined
  if (isAbsolute(target)) {
    try { await access(target, constants.X_OK); return target } catch { return undefined }
  }
  return (await findExecutables(target))[0]
}

export async function scanLocalExecutors(options: { includeLatest?: boolean } = {}): Promise<ExecutorEnvironmentReport> {
  const executors = await Promise.all(executorDefinitions.map(async definition => {
    const executablePath = await resolveExecutable(definition.command)
    const base = {
      id: definition.id,
      name: definition.name,
      type: definition.type,
      icon: definition.icon,
      tone: definition.tone,
      command: definition.command,
      platform: platformName(),
      connected: Boolean(executablePath),
      capabilities: definition.capabilities,
      model: '',
      modelOptions: definition.modelOptions,
      authentication: 'unknown' as ExecutorAuthenticationState,
    }
    if (!executablePath) return { ...base, state: 'not_installed' as const }
    try {
      const currentVersion = await readVersion(executablePath, definition.versionArgs)
      const authentication = await readAuthentication(definition, executablePath)
      return {
        ...base,
        authentication,
        executablePath,
        currentVersion,
        state: 'ready' as const,
      }
    } catch (error) {
      return { ...base, executablePath, state: 'error' as const, error: compactError(error) }
    }
  }))
  return { scannedAt: new Date().toISOString(), executors, updateCount: 0 }
}

// Resolve immediately before a Run. This is intentionally not persisted: the
// CLI installation, login state, and selected default model remain CLI-owned.
export async function resolveExecutorForRun(id: string): Promise<ExecutorConfig> {
  const definition = executorDefinition(id)
  if (!definition) throw new Error(`Unsupported executor: ${id}`)
  const saved = (await loadExecutorConfigs()).find(config => config.id === id)
  // Test fixtures may point at a temporary executable. Production uses the
  // runtime's standard command and never accepts a path from the UI.
  if (saved?.type === 'test') return saved
  const executablePath = await resolveExecutable(definition.command)
  if (!executablePath) throw new Error(`${definition.name} is not installed or is not on PATH`)
  const [version, authentication] = await Promise.all([
    readVersion(executablePath, definition.versionArgs),
    readAuthentication(definition, executablePath),
  ])
  return {
    ...defaultExecutorConfigs.find(config => config.id === id)!,
    path: executablePath,
    version,
    status: 'available',
    authentication,
    authenticationCheckedAt: new Date().toISOString(),
  }
}

export async function connectExecutor(id: string): Promise<ExecutorConfig> {
  const definition = executorDefinition(id)
  if (!definition) throw new Error('Unsupported executor')
  const configs = await loadExecutorConfigs()
  const existing = configs.find(config => config.id === id)
  const path = await resolveExecutable(existing?.path || definition.command) ?? await resolveExecutable(definition.command)
  if (!path) throw new Error(`${definition.name} is not installed or is not on PATH`)
  const version = await readVersion(path, definition.versionArgs)
  const authentication = await readAuthentication(definition, path)
  const updated = configs.map(config => config.id === id ? {
    ...config,
    name: definition.name,
    type: definition.type,
    icon: definition.icon,
    tone: definition.tone,
    path,
    version,
    status: 'available' as const,
    authentication,
    authenticationCheckedAt: new Date().toISOString(),
    capabilities: config.capabilities.length ? config.capabilities : definition.capabilities,
  } : config)
  await saveExecutorConfigs(updated)
  return updated.find(config => config.id === id)!
}

// A connected runtime may have had an inconclusive login probe earlier. Recheck it
// at Run time rather than making the user reconnect the same executable.
export async function refreshExecutorAuthentication(id: string): Promise<ExecutorConfig> {
  const definition = executorDefinition(id)
  if (!definition) throw new Error('Unsupported executor')
  const configs = await loadExecutorConfigs()
  const existing = configs.find(config => config.id === id)
  if (!existing || existing.status !== 'available') throw new Error(`Executor is unavailable: ${id}`)
  const path = await resolveExecutable(existing.path) ?? await resolveExecutable(definition.command)
  if (!path) throw new Error(`${definition.name} is not installed or is not on PATH`)
  const authentication = await readAuthentication(definition, path)
  const updated = configs.map(config => config.id === id ? {
    ...config,
    path,
    authentication,
    authenticationCheckedAt: new Date().toISOString(),
  } : config)
  await saveExecutorConfigs(updated)
  return updated.find(config => config.id === id)!
}

// This only reads a CLI's local catalog/help output. It never submits a prompt or spends model tokens.
export async function discoverExecutorModels(id: string): Promise<ExecutorModelCatalog> {
  const definition = executorDefinition(id)
  if (!definition) throw new Error('Unsupported executor')
  const path = await resolveExecutable(definition.command)
  if (!path) throw new Error(`${definition.name} is not installed or is not on PATH`)
  const cliVersion = await readVersion(path, definition.versionArgs)
  const catalog = definition.id === 'codex'
    ? await readCodexModelCatalog(path, cliVersion)
    : await readClaudeModelCatalog(path, cliVersion)
  return catalog
}

export async function diagnoseExecutorInstallations(): Promise<ExecutorInstallationDiagnostic> {
  const locations = await Promise.all(executorDefinitions.map(async definition => ({ definition, paths: await findExecutables(definition.command) })))
  return {
    checkedAt: new Date().toISOString(),
    conflicts: locations.filter(item => item.paths.length > 1).map(item => ({ id: item.definition.id, name: item.definition.name, command: item.definition.command, paths: item.paths })),
  }
}

export async function maintainExecutors(ids: string[], action: 'install' | 'update'): Promise<ExecutorMaintenanceResult[]> {
  const uniqueIds = [...new Set(ids)]
  const results: ExecutorMaintenanceResult[] = []
  for (const id of uniqueIds) results.push(await maintainExecutor(id, action))
  return results
}

export async function maintainExecutor(id: string, action: 'install' | 'update'): Promise<ExecutorMaintenanceResult> {
  const definition = executorDefinition(id)
  if (!definition?.installPlan) return { id, action, ok: false, error: 'This executor does not have a managed installation plan' }
  try {
    const result = await execFileAsync(definition.installPlan.command, definition.installPlan.args, { timeout: 180_000, maxBuffer: 128_000 })
    return { id, action, ok: true, output: compactOutput(`${result.stdout}\n${result.stderr}`) }
  } catch (error) {
    return { id, action, ok: false, error: compactError(error) }
  }
}

export function manualInstallCommands(): Array<Pick<ExecutorDefinition, 'id' | 'name'> & { command: string }> {
  return executorDefinitions.flatMap(definition => definition.installPlan ? [{ id: definition.id, name: definition.name, command: definition.installPlan.display }] : [])
}

export function isOlderVersion(current: string | undefined, latest: string | undefined): boolean {
  if (!current || !latest) return false
  const currentParts = numericVersion(current)
  const latestParts = numericVersion(latest)
  if (!currentParts.length || !latestParts.length) return false
  const count = Math.max(currentParts.length, latestParts.length)
  for (let index = 0; index < count; index += 1) {
    const difference = (currentParts[index] ?? 0) - (latestParts[index] ?? 0)
    if (difference !== 0) return difference < 0
  }
  return false
}

async function findExecutables(command: string): Promise<string[]> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  const args = process.platform === 'win32' ? [command] : ['-a', command]
  const paths: string[] = []
  try {
    const result = await execFileAsync(finder, args, { timeout: 2_000, maxBuffer: 32_000 })
    paths.push(...result.stdout.split(/\r?\n/).map(path => path.trim()).filter(Boolean))
  } catch {
    // Finder-launched desktop apps frequently have a reduced PATH. Keep checking npm's global bin below.
  }
  const npmGlobalBin = await findNpmGlobalBin()
  if (npmGlobalBin) {
    const candidate = join(npmGlobalBin, process.platform === 'win32' ? `${command}.cmd` : command)
    try { await access(candidate, constants.X_OK); paths.push(candidate) } catch { /* not globally installed by npm */ }
  }
  return [...new Set(paths)]
}

async function findNpmGlobalBin(): Promise<string | undefined> {
  try {
    const result = await execFileAsync('npm', ['prefix', '--global'], { timeout: 3_000, maxBuffer: 8_000 })
    const prefix = result.stdout.trim()
    if (!prefix) return undefined
    return process.platform === 'win32' ? prefix : join(prefix, 'bin')
  } catch {
    return undefined
  }
}

async function readVersion(path: string, args: string[]): Promise<string> {
  const result = await execFileAsync(path, args, { timeout: 8_000, maxBuffer: 32_000 })
  const version = `${result.stdout || result.stderr}`.trim().split(/\r?\n/).find(Boolean)?.trim() ?? ''
  if (!version) throw new Error('The executable did not report a version')
  return version.slice(0, 120)
}

async function readLatestNpmVersion(packageName: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync('npm', ['view', packageName, 'version', '--json', '--no-audit', '--no-fund'], { timeout: 6_000, maxBuffer: 16_000 })
    const raw = result.stdout.trim()
    const value = raw.startsWith('"') ? JSON.parse(raw) : raw
    return typeof value === 'string' && value.length <= 64 ? value : undefined
  } catch {
    return undefined
  }
}

function numericVersion(value: string): number[] {
  const match = value.match(/\d+(?:\.\d+){0,3}/)
  return match ? match[0].split('.').map(part => Number.parseInt(part, 10)) : []
}

function modelOptionsFor(definition: ExecutorDefinition, catalog?: ExecutorModelCatalog): ExecutorModelOption[] {
  const options = [...definition.modelOptions, ...(catalog?.modelOptions ?? [])]
  const seen = new Set<string>()
  return options.filter(option => {
    if (seen.has(option.value)) return false
    seen.add(option.value)
    return true
  })
}

function normalizeModelCatalog(value: unknown): ExecutorModelCatalog | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<ExecutorModelCatalog>
  if (candidate.source !== 'codex-cli-catalog' && candidate.source !== 'claude-cli-help') return undefined
  if (typeof candidate.discoveredAt !== 'string' || typeof candidate.cliVersion !== 'string' || typeof candidate.availabilityNote !== 'string') return undefined
  const modelOptions = normalizeModelOptions(candidate.modelOptions)
  if (!modelOptions.length) return undefined
  return {
    source: candidate.source,
    discoveredAt: candidate.discoveredAt.slice(0, 64),
    cliVersion: candidate.cliVersion.slice(0, 120),
    modelOptions,
    availabilityNote: candidate.availabilityNote.slice(0, 360),
  }
}

function normalizeModelOptions(value: unknown): ExecutorModelOption[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const options: ExecutorModelOption[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue
    const { value: model, label } = candidate as Partial<ExecutorModelOption>
    if (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(model) || seen.has(model)) continue
    seen.add(model)
    options.push({ value: model, label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 160) : model })
  }
  return options
}

async function readCodexModelCatalog(path: string, cliVersion: string): Promise<ExecutorModelCatalog> {
  const result = await execFileAsync(path, ['debug', 'models'], { timeout: 15_000, maxBuffer: 2_000_000 })
  const modelOptions = parseCodexModelOptions(`${result.stdout}\n${result.stderr}`)
  if (!modelOptions.length) throw new Error('Codex did not report any selectable models')
  return {
    source: 'codex-cli-catalog',
    discoveredAt: new Date().toISOString(),
    cliVersion,
    modelOptions,
    availabilityNote: '来自 Codex CLI 当前模型目录；账户权限会在实际运行时由 Codex 复核。',
  }
}

async function readClaudeModelCatalog(path: string, cliVersion: string): Promise<ExecutorModelCatalog> {
  const result = await execFileAsync(path, ['--help'], { timeout: 8_000, maxBuffer: 128_000 })
  const modelOptions = extractClaudeModelOptions(`${result.stdout}\n${result.stderr}`)
  if (!modelOptions.length) throw new Error('Claude Code did not report model aliases')
  return {
    source: 'claude-cli-help',
    discoveredAt: new Date().toISOString(),
    cliVersion,
    modelOptions,
    availabilityNote: 'Claude Code 未提供账户模型目录；此列表来自本机 CLI 的模型别名说明，账户权限会在实际运行时由 Claude Code 复核。',
  }
}

export function parseCodexModelOptions(output: string): ExecutorModelOption[] {
  const start = output.indexOf('{"models"')
  if (start < 0) return []
  try {
    const value = JSON.parse(output.slice(start)) as { models?: unknown }
    if (!Array.isArray(value.models)) return []
    return normalizeModelOptions(value.models.flatMap(candidate => {
      if (!candidate || typeof candidate !== 'object') return []
      const model = candidate as { slug?: unknown; display_name?: unknown; visibility?: unknown }
      if (model.visibility !== 'list' || typeof model.slug !== 'string') return []
      return [{ value: model.slug, label: typeof model.display_name === 'string' ? model.display_name : model.slug }]
    }))
  } catch {
    return []
  }
}

export function extractClaudeModelOptions(help: string): ExecutorModelOption[] {
  const modelStart = help.indexOf('--model')
  if (modelStart < 0) return []
  const nextOption = help.indexOf('\n  -n, --name', modelStart)
  const modelSection = help.slice(modelStart, nextOption < 0 ? undefined : nextOption)
  return normalizeModelOptions([...modelSection.matchAll(/'([A-Za-z][A-Za-z0-9._:-]{0,127})'/g)].map(match => ({
    value: match[1],
    label: match[1].replace(/(^|[-_.])([a-z])/g, (_value, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`),
  })))
}

async function readAuthentication(definition: ExecutorDefinition, path: string): Promise<ExecutorAuthenticationState> {
  const keyName = definition.id === 'codex' ? 'OPENAI_API_KEY' : definition.id === 'claude' ? 'ANTHROPIC_API_KEY' : null
  if (!keyName) return 'unknown'
  if (process.env[keyName]?.trim()) return 'api_key'
  try {
    const args = definition.id === 'codex' ? ['login', 'status'] : ['auth', 'status']
    const result = await execFileAsync(path, args, { timeout: 8_000, maxBuffer: 32_000 })
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase()
    return /not logged|not authenticated|logged out|no active session|unauthorized/.test(output) ? 'needs_login' : 'authenticated'
  } catch (error) {
    const details = error as { stdout?: unknown; stderr?: unknown }
    const output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`.toLowerCase()
    return /not logged|not authenticated|logged out|no active session|unauthorized/.test(output) ? 'needs_login' : 'unknown'
  }
}

function normalizeAuthentication(value: unknown): ExecutorAuthenticationState {
  return value === 'authenticated' || value === 'api_key' || value === 'needs_login' || value === 'unknown' ? value : 'unknown'
}

function compactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split(/\r?\n/).find(Boolean)?.slice(0, 240) ?? 'Unknown error'
}

function compactOutput(value: string): string | undefined {
  const output = value.trim().replace(/\r?\n+/g, '\n')
  return output ? output.slice(-1_200) : undefined
}

function platformName(): string {
  return process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'
}
