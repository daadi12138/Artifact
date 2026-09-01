import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type CommandSpec = {
  command: string
  cwd: string
  timeoutMs: number
}

export const projectCommandKeys = ['install', 'test', 'build', 'typecheck', 'lint'] as const
export type ProjectCommandKey = (typeof projectCommandKeys)[number]
export type CommandApproval = CommandSpec & { approvedAt: string }

export type ProjectEnvironment = {
  version: number
  detectedStack: Array<{ category: string; name: string; version?: string; evidence: string[] }>
  commands: Partial<Record<ProjectCommandKey, CommandSpec>>
  commandAllowlist: Partial<Record<ProjectCommandKey, CommandApproval>>
  confirmedByUser: boolean
  confirmedAt?: string
}

export type ProjectConfig = {
  id: string
  name: string
  repositoryPath: string
  gitRoot: string
  status: 'detected' | 'ready' | 'invalid'
  environment: ProjectEnvironment
  createdAt: string
  updatedAt: string
}

export type RecentProject = Pick<ProjectConfig, 'name' | 'repositoryPath' | 'gitRoot' | 'updatedAt'>

export type ProjectDiagnostic = {
  inputPath: string
  repositoryPath: string | null
  gitRoot: string | null
  gitVersion: string | null
  nodeVersion: string
  valid: boolean
  error?: string
}

const stateRoot = () => process.env.ARTIFACT_STATE_DIR || join(process.cwd(), '.artifact')
const projectPath = () => join(stateRoot(), 'project.json')
const recentProjectsPath = () => join(stateRoot(), 'recent-projects.json')

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

export async function loadProject(): Promise<ProjectConfig | null> {
  try {
    return normalizeProject(JSON.parse(await readFile(projectPath(), 'utf8')) as ProjectConfig)
  } catch {
    return null
  }
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  try {
    const value = JSON.parse(await readFile(recentProjectsPath(), 'utf8')) as unknown
    if (!Array.isArray(value)) return []
    return value.filter(isRecentProject).slice(0, 6)
  } catch {
    return []
  }
}

export async function importProject(inputPath: string): Promise<ProjectConfig> {
  const { repositoryPath, gitRoot } = await resolveGitProject(inputPath)
  const environment = await detectProjectEnvironment(gitRoot)
  const now = new Date().toISOString()
  const existing = await loadProject()
  const commandAllowlist = existing?.gitRoot === gitRoot
    ? retainCurrentApprovals(existing.environment.commandAllowlist, environment.commands)
    : {}
  const project: ProjectConfig = {
    id: existing?.gitRoot === gitRoot ? existing.id : `project-${randomUUID()}`,
    name: gitRoot.split('/').filter(Boolean).at(-1) ?? 'project',
    repositoryPath,
    gitRoot,
    status: 'ready',
    environment: { ...environment, commandAllowlist, confirmedByUser: true, confirmedAt: now },
    createdAt: existing?.gitRoot === gitRoot ? existing.createdAt : now,
    updatedAt: now,
  }
  await atomicWrite(projectPath(), JSON.stringify(project, null, 2))
  await saveRecentProject(project, existing)
  return project
}

export function isProjectCommandApproved(project: Pick<ProjectConfig, 'environment'>, key: ProjectCommandKey, command: CommandSpec): boolean {
  const approval = project.environment.commandAllowlist[key]
  return Boolean(approval && sameCommandSpec(approval, command))
}

export async function approveProjectCommand(key: ProjectCommandKey, expectedCommand?: CommandSpec): Promise<ProjectConfig> {
  const project = await loadProject()
  if (!project) throw new Error('Import a Git project first')
  const command = project.environment.commands[key]
  if (!command) throw new Error(`No detected ${key} command is available for this project`)
  if (expectedCommand && !sameCommandSpec(command, expectedCommand)) throw new Error('The detected command changed. Start the run again to review the current command.')
  const now = new Date().toISOString()
  project.environment = {
    ...project.environment,
    version: project.environment.version + 1,
    commandAllowlist: { ...project.environment.commandAllowlist, [key]: { ...command, approvedAt: now } },
    confirmedByUser: true,
    confirmedAt: project.environment.confirmedAt ?? now,
  }
  project.status = 'ready'
  project.updatedAt = now
  await atomicWrite(projectPath(), JSON.stringify(project, null, 2))
  return project
}

export async function revokeProjectCommand(key: ProjectCommandKey): Promise<ProjectConfig> {
  const project = await loadProject()
  if (!project) throw new Error('Import a Git project first')
  if (!project.environment.commandAllowlist[key]) return project
  const now = new Date().toISOString()
  const commandAllowlist = { ...project.environment.commandAllowlist }
  delete commandAllowlist[key]
  project.environment = { ...project.environment, version: project.environment.version + 1, commandAllowlist }
  project.updatedAt = now
  await atomicWrite(projectPath(), JSON.stringify(project, null, 2))
  return project
}

export async function createProject(parentPath: string, name: string): Promise<ProjectConfig> {
  const projectName = validateProjectName(name)
  if (!parentPath.trim()) throw new Error('Choose a parent folder for the new project')

  const parentDirectory = await realpath(resolve(parentPath))
  if (!(await stat(parentDirectory)).isDirectory()) throw new Error('Project location must be a directory')
  const repositoryPath = join(parentDirectory, projectName)

  try {
    await stat(repositoryPath)
    throw new Error(`A folder named ${projectName} already exists in this location`)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }

  await mkdir(repositoryPath)
  await writeFile(join(repositoryPath, 'README.md'), `# ${projectName}\n\nCreated with Artifact.\n`, 'utf8')
  await execFileAsync('git', ['init'], { cwd: repositoryPath, timeout: 8_000 })
  await execFileAsync('git', ['add', '--', 'README.md'], { cwd: repositoryPath, timeout: 8_000 })
  await execFileAsync('git', ['-c', 'user.name=Artifact', '-c', 'user.email=artifact@local', 'commit', '-m', 'Initial project'], { cwd: repositoryPath, timeout: 8_000 })
  return importProject(repositoryPath)
}

export async function resolveGitProject(inputPath: string): Promise<{ repositoryPath: string; gitRoot: string }> {
  if (!inputPath.trim()) throw new Error('Project path is required')
  const repositoryPath = await realpath(resolve(inputPath))
  if (!(await stat(repositoryPath)).isDirectory()) throw new Error('Project path must be a directory')
  const { stdout } = await execFileAsync('git', ['-C', repositoryPath, 'rev-parse', '--show-toplevel'], { timeout: 8_000 })
  return { repositoryPath, gitRoot: await realpath(stdout.trim()) }
}

function validateProjectName(value: string): string {
  const name = value.trim()
  if (!name) throw new Error('Project name is required')
  if (name === '.' || name === '..' || name.length > 80 || /[\\/\0]/.test(name)) throw new Error('Project name must be a folder name up to 80 characters')
  return name
}

export async function diagnoseProject(inputPath: string): Promise<ProjectDiagnostic> {
  const diagnostic: ProjectDiagnostic = {
    inputPath: resolve(inputPath || process.cwd()),
    repositoryPath: null,
    gitRoot: null,
    gitVersion: null,
    nodeVersion: process.version,
    valid: false,
  }
  try {
    const { stdout } = await execFileAsync('git', ['--version'], { timeout: 8_000 })
    diagnostic.gitVersion = stdout.trim()
    const project = await resolveGitProject(diagnostic.inputPath)
    diagnostic.repositoryPath = project.repositoryPath
    diagnostic.gitRoot = project.gitRoot
    diagnostic.valid = true
  } catch (error) {
    diagnostic.error = error instanceof Error ? error.message.split('\n')[0] : String(error)
  }
  return diagnostic
}

export async function confirmProjectEnvironment(commands?: ProjectEnvironment['commands']): Promise<ProjectConfig> {
  const project = await loadProject()
  if (!project) throw new Error('Import a Git project first')
  const now = new Date().toISOString()
  const confirmedCommands = commands ?? project.environment.commands
  for (const [name, command] of Object.entries(confirmedCommands)) {
    if (!command) continue
    if (!command.command.trim()) { delete confirmedCommands[name as keyof typeof confirmedCommands]; continue }
    if (command.cwd.startsWith('/') || command.cwd.split('/').includes('..')) throw new Error(`Command ${name} has an unsafe working directory`)
    if (!Number.isFinite(command.timeoutMs) || command.timeoutMs < 1_000 || command.timeoutMs > 3_600_000) throw new Error(`Command ${name} has an invalid timeout`)
  }
  project.environment = {
    ...project.environment,
    version: project.environment.version + 1,
    commands: confirmedCommands,
    commandAllowlist: project.environment.commandAllowlist,
    confirmedByUser: true,
    confirmedAt: now,
  }
  project.status = 'ready'
  project.updatedAt = now
  await atomicWrite(projectPath(), JSON.stringify(project, null, 2))
  return project
}

export async function detectProjectEnvironment(gitRoot: string): Promise<ProjectEnvironment> {
  const detectedStack: ProjectEnvironment['detectedStack'] = [{ category: 'vcs', name: 'Git', evidence: ['.git'] }]
  const commands: ProjectEnvironment['commands'] = {}
  try {
    const packageJsonPath = join(gitRoot, 'package.json')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { packageManager?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> }
    const allDependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
    detectedStack.push({ category: 'runtime', name: 'Node.js', evidence: ['package.json'] })
    if (allDependencies.next) detectedStack.push({ category: 'framework', name: 'Next.js', version: allDependencies.next, evidence: ['package.json#dependencies.next'] })
    if (allDependencies.typescript) detectedStack.push({ category: 'language', name: 'TypeScript', version: allDependencies.typescript, evidence: ['package.json#devDependencies.typescript'] })
    const packageManager = packageJson.packageManager?.split('@')[0] ?? await detectPackageManager(gitRoot)
    const run = packageManager === 'yarn' ? 'yarn' : `${packageManager} run`
    const hasLockfile = packageManager === 'npm'
      ? await fileExists(join(gitRoot, 'package-lock.json'))
      : packageManager === 'pnpm'
        ? await fileExists(join(gitRoot, 'pnpm-lock.yaml'))
        : await fileExists(join(gitRoot, 'yarn.lock'))
    const installCommand = packageManager === 'npm'
      ? hasLockfile ? 'npm ci' : 'npm install'
      : hasLockfile ? `${packageManager} install --frozen-lockfile` : `${packageManager} install`
    commands.install = { command: installCommand, cwd: '.', timeoutMs: 600_000 }
    for (const key of ['test', 'build', 'typecheck', 'lint'] as const) {
      if (packageJson.scripts?.[key]) commands[key] = { command: `${run} ${key}`, cwd: '.', timeoutMs: 600_000 }
    }
  } catch {
    // Non-Node projects remain importable and can be configured through the API.
  }
  return { version: 1, detectedStack, commands, commandAllowlist: {}, confirmedByUser: true, confirmedAt: new Date().toISOString() }
}

function normalizeProject(project: ProjectConfig): ProjectConfig {
  project.environment ??= { version: 1, detectedStack: [], commands: {}, commandAllowlist: {}, confirmedByUser: true }
  project.environment.version ??= 1
  project.environment.detectedStack ??= []
  project.environment.commands ??= {}
  project.environment.commandAllowlist ??= {}
  project.environment.confirmedByUser ??= true
  if (project.status === 'detected') project.status = 'ready'
  return project
}

function retainCurrentApprovals(previous: ProjectEnvironment['commandAllowlist'], commands: ProjectEnvironment['commands']): ProjectEnvironment['commandAllowlist'] {
  const retained: ProjectEnvironment['commandAllowlist'] = {}
  for (const key of projectCommandKeys) {
    const approval = previous[key]
    const command = commands[key]
    if (approval && command && sameCommandSpec(approval, command)) retained[key] = approval
  }
  return retained
}

function sameCommandSpec(left: CommandSpec, right: CommandSpec): boolean {
  return left.command === right.command && left.cwd === right.cwd && left.timeoutMs === right.timeoutMs
}

async function saveRecentProject(project: ProjectConfig, previousProject: ProjectConfig | null): Promise<void> {
  const current: RecentProject = {
    name: project.name,
    repositoryPath: project.repositoryPath,
    gitRoot: project.gitRoot,
    updatedAt: project.updatedAt,
  }
  const previous = previousProject ? [{
    name: previousProject.name,
    repositoryPath: previousProject.repositoryPath,
    gitRoot: previousProject.gitRoot,
    updatedAt: previousProject.updatedAt,
  }] : []
  const candidates = [current, ...previous, ...await listRecentProjects()]
  const seen = new Set<string>()
  const recent = candidates.filter(item => {
    if (seen.has(item.gitRoot)) return false
    seen.add(item.gitRoot)
    return true
  }).slice(0, 6)
  await atomicWrite(recentProjectsPath(), JSON.stringify(recent, null, 2))
}

function isRecentProject(value: unknown): value is RecentProject {
  if (!value || typeof value !== 'object') return false
  const project = value as Partial<RecentProject>
  return typeof project.name === 'string'
    && typeof project.repositoryPath === 'string'
    && typeof project.gitRoot === 'string'
    && typeof project.updatedAt === 'string'
}

async function detectPackageManager(gitRoot: string): Promise<'npm' | 'pnpm' | 'yarn'> {
  for (const [file, manager] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn']] as const) {
    try { await stat(join(gitRoot, file)); return manager } catch { /* continue */ }
  }
  return 'npm'
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}
