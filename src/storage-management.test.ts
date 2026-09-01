import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupStorage, getStorageOverview, previewStorageCleanup } from './storage-management'

test('storage governance protects undelivered work and retains artifacts during cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-storage-'))
  const state = join(root, 'state')
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = state
  const completedRun = 'run-storage-completed'
  const awaitingDeliveryRun = 'run-storage-awaiting-delivery'
  try {
    await writeRunFixture(state, completedRun, 'succeeded')
    await writeRunFixture(state, awaitingDeliveryRun, 'awaiting_delivery')

    const overview = await getStorageOverview()
    const completed = overview.runs.find(run => run.id === completedRun)
    const pending = overview.runs.find(run => run.id === awaitingDeliveryRun)
    assert.ok(completed)
    assert.ok(pending)
    assert.equal(completed.cleanupEligible, true)
    assert.equal(pending.cleanupEligible, false)
    assert.equal(pending.cleanupReason, '等待交付审批的运行不可清理')
    assert.ok(overview.totalBytes > 0)
    assert.ok(completed.artifactBytes > 0)
    assert.ok(completed.worktreeBytes > 0)

    const preview = await previewStorageCleanup({ retainArtifacts: true })
    assert.deepEqual(preview.runIds, [completedRun])
    assert.deepEqual(preview.protectedRunIds, [awaitingDeliveryRun])
    assert.equal(preview.retainArtifacts, true)
    assert.equal(preview.reclaimedBytes, preview.totalBytes - preview.artifactBytes)

    const result = await cleanupStorage({ runIds: preview.runIds, retainArtifacts: true })
    assert.deepEqual(result.cleanedRunIds, [completedRun])
    await assert.rejects(readFile(join(state, 'runs', completedRun, 'manifest.json'), 'utf8'))
    await assert.rejects(readFile(join(state, 'worktrees', completedRun, 'work.txt'), 'utf8'))
    assert.equal(await readFile(join(state, 'runs', awaitingDeliveryRun, 'manifest.json'), 'utf8').then(() => true), true)
    assert.equal(await readFile(join(state, 'retained-artifacts', completedRun, 'artifacts', 'report.txt'), 'utf8'), 'artifact output')
    const retainedManifest = JSON.parse(await readFile(join(state, 'retained-artifacts', completedRun, 'manifest.json'), 'utf8')) as { id: string }
    assert.equal(retainedManifest.id, completedRun)
  } finally {
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(root, { recursive: true, force: true })
  }
})

async function writeRunFixture(state: string, id: string, status: 'succeeded' | 'awaiting_delivery'): Promise<void> {
  const now = new Date().toISOString()
  const runPath = join(state, 'runs', id)
  await mkdir(join(runPath, 'attempts', 'attempt-1'), { recursive: true })
  await mkdir(join(runPath, 'artifacts'), { recursive: true })
  await mkdir(join(state, 'worktrees', id), { recursive: true })
  await writeFile(join(runPath, 'attempts', 'attempt-1', 'trace.json'), 'attempt trace')
  await writeFile(join(runPath, 'artifacts', 'report.txt'), 'artifact output')
  await writeFile(join(state, 'worktrees', id, 'work.txt'), 'worktree output')
  await writeFile(join(runPath, 'manifest.json'), JSON.stringify({
    id,
    status,
    startedAt: now,
    project: { gitRoot: join(state, 'not-a-git-repository') },
    worktreePath: join(state, 'worktrees', id),
    branchName: `artifact/${id.slice(4)}`,
  }, null, 2))
}
