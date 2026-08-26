import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createProject, importProject, listRecentProjects } from './project'

const execFileAsync = promisify(execFile)

test('project import remembers recent Git projects in most-recent-first order', async () => {
  const state = await mkdtemp(join(tmpdir(), 'artifact-project-state-'))
  const root = await mkdtemp(join(tmpdir(), 'artifact-project-repositories-'))
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = state
  try {
    const first = await createRepository(root, 'first')
    const second = await createRepository(root, 'second')

    await importProject(first)
    await importProject(second)
    await importProject(first)

    const recent = await listRecentProjects()
    assert.deepEqual(recent.map(project => project.name), ['first', 'second'])
    assert.equal(recent[0].gitRoot, await realpath(first))
  } finally {
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(state, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('project creation initializes a Git repository with a commit for Worktrees', async () => {
  const state = await mkdtemp(join(tmpdir(), 'artifact-project-state-'))
  const parent = await mkdtemp(join(tmpdir(), 'artifact-project-parent-'))
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = state
  try {
    const project = await createProject(parent, 'new-project')

    assert.equal(project.name, 'new-project')
    assert.equal(project.repositoryPath, await realpath(join(parent, 'new-project')))
    assert.equal(project.status, 'ready')
    assert.deepEqual(project.environment.commandAllowlist, {})
    assert.match(await readFile(join(project.repositoryPath, 'README.md'), 'utf8'), /Created with Artifact/)
    const { stdout } = await execFileAsync('git', ['-C', project.repositoryPath, 'rev-parse', '--verify', 'HEAD'])
    assert.match(stdout.trim(), /^[0-9a-f]{40}$/)
    await assert.rejects(() => createProject(parent, 'new-project'), /already exists/)
  } finally {
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(state, { recursive: true, force: true })
    await rm(parent, { recursive: true, force: true })
  }
})

async function createRepository(root: string, name: string): Promise<string> {
  const repository = join(root, name)
  await mkdir(repository)
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  await execFileAsync('git', ['init'], { cwd: repository })
  return repository
}
