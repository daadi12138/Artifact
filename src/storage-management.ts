import { execFile } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { RunSnapshot, RunStatus } from './run-manager'

const execFileAsync = promisify(execFile)
const stateRoot = () => process.env.ARTIFACT_STATE_DIR || join(process.cwd(), '.artifact')
const runsRoot = () => join(stateRoot(), 'runs')
const worktreesRoot = () => join(stateRoot(), 'worktrees')
const retainedArtifactsRoot = () => join(stateRoot(), 'retained-artifacts')
const terminalStatuses = new Set<RunStatus>(['succeeded', 'failed', 'cancelled'])

export type StorageRunUsage = {
  id: string
  status: RunStatus
  startedAt: string
  worktreePath?: string
  runBytes: number
  attemptBytes: number
  artifactBytes: number
  worktreeBytes: number
  cleanupEligible: boolean
  cleanupReason?: string
}

export type StorageOverview = {
  stateDirectory: string
  runsDirectory: string
  worktreesDirectory: string
  retainedArtifactsDirectory: string
  totalBytes: number
  runBytes: number
  attemptBytes: number
  artifactBytes: number
  worktreeBytes: number
  retainedArtifactBytes: number
  cleanupEligibleCount: number
  protectedRunCount: number
  runs: StorageRunUsage[]
}

export type StorageCleanupPreview = {
  runIds: string[]
  protectedRunIds: string[]
  totalBytes: number
  artifactBytes: number
  reclaimedBytes: number
  retainArtifacts: boolean
}

export type StorageCleanupResult = StorageCleanupPreview & { cleanedRunIds: string[]; retainedArtifactDirectory?: string }

export async function getStorageOverview(): Promise<StorageOverview> {
  const runs = await readStoredRuns()
  const usage = await Promise.all(runs.map(storageRunUsage))
  const [totalBytes, retainedArtifactBytes] = await Promise.all([directorySize(stateRoot()), directorySize(retainedArtifactsRoot())])
  return {
    stateDirectory: stateRoot(),
    runsDirectory: runsRoot(),
    worktreesDirectory: worktreesRoot(),
    retainedArtifactsDirectory: retainedArtifactsRoot(),
    totalBytes,
    runBytes: usage.reduce((total, run) => total + run.runBytes, 0),
    attemptBytes: usage.reduce((total, run) => total + run.attemptBytes, 0),
    artifactBytes: usage.reduce((total, run) => total + run.artifactBytes, 0),
    worktreeBytes: usage.reduce((total, run) => total + run.worktreeBytes, 0),
    retainedArtifactBytes,
    cleanupEligibleCount: usage.filter(run => run.cleanupEligible).length,
    protectedRunCount: usage.filter(run => !run.cleanupEligible).length,
    runs: usage.sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
  }
}

export async function previewStorageCleanup(input: { runIds?: string[]; retainArtifacts?: boolean } = {}): Promise<StorageCleanupPreview> {
  const usage = await (await getStorageOverview()).runs
  const requested = normalizeRunIds(input.runIds, usage)
  const selected = usage.filter(run => requested.includes(run.id))
  const eligible = selected.filter(run => run.cleanupEligible)
  const protectedRuns = selected.filter(run => !run.cleanupEligible)
  const totalBytes = eligible.reduce((total, run) => total + run.runBytes + run.worktreeBytes, 0)
  const artifactBytes = eligible.reduce((total, run) => total + run.artifactBytes, 0)
  const retainArtifacts = input.retainArtifacts === true
  return {
    runIds: eligible.map(run => run.id),
    protectedRunIds: protectedRuns.map(run => run.id),
    totalBytes,
    artifactBytes,
    reclaimedBytes: Math.max(0, totalBytes - (retainArtifacts ? artifactBytes : 0)),
    retainArtifacts,
  }
}

export async function cleanupStorage(input: { runIds: string[]; retainArtifacts?: boolean }): Promise<StorageCleanupResult> {
  if (!Array.isArray(input.runIds) || !input.runIds.length) throw new Error('Choose at least one completed run to clean up')
  const preview = await previewStorageCleanup(input)
  if (!preview.runIds.length) throw new Error('Only succeeded, failed, or cancelled runs can be cleaned up')
  const storedRuns = new Map((await readStoredRuns()).map(run => [run.id, run]))
  const cleanedRunIds: string[] = []
  for (const id of preview.runIds) {
    const run = storedRuns.get(id)
    if (!run || !terminalStatuses.has(run.status)) continue
    const runPath = runDirectory(id)
    if (preview.retainArtifacts) await retainArtifacts(run, runPath)
    await removeRunWorktree(run)
    await rm(runPath, { recursive: true, force: true })
    cleanedRunIds.push(id)
  }
  return {
    ...preview,
    runIds: cleanedRunIds,
    cleanedRunIds,
    ...(preview.retainArtifacts && cleanedRunIds.length ? { retainedArtifactDirectory: retainedArtifactsRoot() } : {}),
  }
}

async function storageRunUsage(run: RunSnapshot): Promise<StorageRunUsage> {
  const runPath = runDirectory(run.id)
  const expectedWorktreePath = join(worktreesRoot(), run.id)
  const [runBytes, attemptBytes, artifactBytes, worktreeBytes] = await Promise.all([
    directorySize(runPath),
    directorySize(join(runPath, 'attempts')),
    directorySize(join(runPath, 'artifacts')),
    directorySize(expectedWorktreePath),
  ])
  const cleanupEligible = terminalStatuses.has(run.status)
  return {
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.worktreePath ? { worktreePath: expectedWorktreePath } : {}),
    runBytes,
    attemptBytes,
    artifactBytes,
    worktreeBytes,
    cleanupEligible,
    ...(cleanupEligible ? {} : { cleanupReason: run.status === 'awaiting_delivery' ? '等待交付审批的运行不可清理' : '运行尚未结束，不能清理' }),
  }
}

async function readStoredRuns(): Promise<RunSnapshot[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try { entries = await readdir(runsRoot(), { withFileTypes: true }) } catch { return [] }
  const runs = await Promise.all(entries.filter(entry => entry.isDirectory() && validRunId(entry.name)).map(async entry => {
    try { return JSON.parse(await readFile(join(runsRoot(), entry.name, 'manifest.json'), 'utf8')) as RunSnapshot } catch { return null }
  }))
  return runs.filter((run): run is RunSnapshot => Boolean(run && validRunId(run.id)))
}

async function retainArtifacts(run: RunSnapshot, sourceRunPath: string): Promise<void> {
  const sourceArtifacts = join(sourceRunPath, 'artifacts')
  if (!await pathExists(sourceArtifacts)) return
  const destination = join(retainedArtifactsRoot(), run.id)
  const staging = `${destination}.staging`
  await rm(staging, { recursive: true, force: true })
  await mkdir(dirname(destination), { recursive: true })
  await mkdir(staging, { recursive: true })
  await cp(sourceArtifacts, join(staging, 'artifacts'), { recursive: true, force: true })
  await cp(join(sourceRunPath, 'manifest.json'), join(staging, 'manifest.json'), { force: true })
  await rm(destination, { recursive: true, force: true })
  await rename(staging, destination)
}

async function removeRunWorktree(run: RunSnapshot): Promise<void> {
  const expected = join(worktreesRoot(), run.id)
  if (!isManagedWorktreePath(expected, run.id)) throw new Error(`Unsafe Worktree cleanup path for ${run.id}`)
  if (await pathExists(expected)) {
    try { await execFileAsync('git', ['-C', run.project.gitRoot, 'worktree', 'remove', '--force', expected], { timeout: 60_000 }) }
    catch { await rm(expected, { recursive: true, force: true }) }
  }
  if (run.branchName?.startsWith('artifact/')) {
    try { await execFileAsync('git', ['-C', run.project.gitRoot, 'branch', '--delete', '--force', run.branchName], { timeout: 15_000 }) } catch { /* The branch may already be absent or checked out elsewhere. */ }
  }
}

function normalizeRunIds(requested: string[] | undefined, usage: StorageRunUsage[]): string[] {
  const known = new Set(usage.map(run => run.id))
  const values = requested === undefined ? usage.map(run => run.id) : requested
  return [...new Set(values.filter(id => typeof id === 'string' && validRunId(id) && known.has(id)))]
}

function validRunId(value: string): boolean { return /^run-[a-zA-Z0-9-]+$/.test(value) }
function runDirectory(id: string): string { return join(runsRoot(), id) }
function isManagedWorktreePath(path: string, id: string): boolean { return resolve(path) === resolve(worktreesRoot(), id) }

async function directorySize(path: string): Promise<number> {
  let metadata
  try { metadata = await lstat(path) } catch { return 0 }
  if (metadata.isSymbolicLink()) return 0
  if (metadata.isFile()) return metadata.size
  if (!metadata.isDirectory()) return 0
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  const sizes = await Promise.all(entries.map(entry => directorySize(join(path, entry.name))))
  return sizes.reduce((total, size) => total + size, 0)
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch { return false }
}
