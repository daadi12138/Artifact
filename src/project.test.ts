import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createProject, detectProjectEnvironment, importProject, listRecentProjects } from './project'

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

test('project environment detection creates workspace-scoped commands for a pnpm monorepo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-node-workspace-'))
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'workspace-root', packageManager: 'pnpm@9.0.0', workspaces: ['apps/*'] }, null, 2))
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n')
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')

    const environment = await detectProjectEnvironment(root)
    assert.deepEqual(environment.workspaceRoots, [{ path: '.', ecosystem: 'node', manager: 'pnpm', evidence: ['package.json', 'package.json#workspaces', 'pnpm-workspace.yaml'] }])
    assert.equal(environment.commands.install?.command, 'pnpm install --frozen-lockfile')
    assert.equal(environment.commands.test?.command, 'pnpm -r --if-present run test')
    assert.equal(environment.commands.test?.cwd, '.')
    assert.equal(environment.commands.test?.workspaceRoot, '.')
    assert.deepEqual(environment.commands.test?.evidence, ['package.json', 'package.json#workspaces', 'pnpm-workspace.yaml', 'workspace package scripts'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('project environment detection supports Python, Go, and Rust projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-language-environments-'))
  try {
    const python = join(root, 'python')
    const go = join(root, 'go')
    const rust = join(root, 'rust')
    await Promise.all([mkdir(python), mkdir(go), mkdir(rust)])
    await writeFile(join(python, 'pyproject.toml'), ['[project]', 'name = "fixture"', 'requires-python = ">=3.11"', 'dependencies = ["pytest", "mypy", "ruff"]', '', '[build-system]', 'requires = ["setuptools"]', 'build-backend = "setuptools.build_meta"', ''].join('\n'))
    await writeFile(join(go, 'go.mod'), 'module example.com/fixture\n\ngo 1.23\n')
    await writeFile(join(rust, 'Cargo.toml'), ['[package]', 'name = "fixture"', 'version = "0.1.0"', 'rust-version = "1.82"', '', '[workspace]', 'members = []', ''].join('\n'))

    const [pythonEnvironment, goEnvironment, rustEnvironment] = await Promise.all([detectProjectEnvironment(python), detectProjectEnvironment(go), detectProjectEnvironment(rust)])
    assert.equal(pythonEnvironment.detectedStack.find(item => item.name === 'Python')?.version, '>=3.11')
    assert.equal(pythonEnvironment.commands.install?.command, 'python3 -m pip install -e .')
    assert.equal(pythonEnvironment.commands.test?.command, 'python3 -m pytest')
    assert.equal(pythonEnvironment.commands.typecheck?.command, 'python3 -m mypy .')
    assert.equal(pythonEnvironment.commands.lint?.command, 'python3 -m ruff check .')
    assert.equal(pythonEnvironment.commands.build?.command, 'python3 -m build')
    assert.deepEqual(pythonEnvironment.workspaceRoots[0], { path: '.', ecosystem: 'python', manager: 'pip', evidence: ['pyproject.toml'] })

    assert.equal(goEnvironment.detectedStack.find(item => item.name === 'Go')?.version, '1.23')
    assert.equal(goEnvironment.commands.install?.command, 'go mod download')
    assert.equal(goEnvironment.commands.test?.command, 'go test ./...')
    assert.equal(goEnvironment.commands.build?.command, 'go build ./...')

    assert.equal(rustEnvironment.detectedStack.find(item => item.name === 'Rust')?.version, '1.82')
    assert.equal(rustEnvironment.commands.install?.command, 'cargo fetch')
    assert.equal(rustEnvironment.commands.typecheck?.command, 'cargo check')
    assert.equal(rustEnvironment.commands.test?.command, 'cargo test')
    assert.equal(rustEnvironment.commands.build?.command, 'cargo build')
    assert.deepEqual(rustEnvironment.workspaceRoots[0]?.evidence, ['Cargo.toml', 'Cargo.toml#workspace'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function createRepository(root: string, name: string): Promise<string> {
  const repository = join(root, name)
  await mkdir(repository)
  await writeFile(join(repository, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
  await execFileAsync('git', ['init'], { cwd: repository })
  return repository
}
