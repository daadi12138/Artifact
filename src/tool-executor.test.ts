import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentTool, FileTool, ShellTool } from './tool-executor'

test('AgentTool applies permission policy before invoking an adapter', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'artifact-agent-tool-'))
  let calls = 0
  try {
    const denied = await new AgentTool().execute({ runner: async () => { calls += 1; return 'should-not-run' }, input: {} }, {
      cwd: join(workspaceRoot, '..'),
      workspaceRoot,
      mode: 'read_only',
    })
    assert.equal(denied.permission, 'deny')
    assert.equal(calls, 0)

    const allowed = await new AgentTool().execute({ runner: async () => { calls += 1; return { output: 'agent-ok' } }, input: {} }, {
      cwd: workspaceRoot,
      workspaceRoot,
      mode: 'read_only',
    })
    assert.equal(allowed.permission, 'allow')
    assert.equal(allowed.stdout, 'agent-ok')
    assert.deepEqual(allowed.value, { output: 'agent-ok' })
    assert.equal(allowed.exitCode, 0)
    assert.equal(calls, 1)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('ShellTool executes an allowed command and reports execution metadata', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'artifact-shell-tool-'))
  try {
    const result = await new ShellTool().execute({ command: 'printf tool-ok' }, {
      cwd: workspaceRoot,
      workspaceRoot,
      mode: 'read_only',
    })
    assert.equal(result.stdout, 'tool-ok')
    assert.equal(result.exitCode, 0)
    assert.equal(result.permission, 'allow')
    assert.equal(result.risk, 'low')
    assert.ok(result.durationMs >= 0)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('ShellTool returns approval_required for high-risk commands without running them', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'artifact-shell-approval-'))
  try {
    const result = await new ShellTool().execute({ command: 'rm -rf should-not-run' }, {
      cwd: workspaceRoot,
      workspaceRoot,
      mode: 'workspace_write',
    })
    assert.equal(result.permission, 'approval_required')
    assert.equal(result.risk, 'high')
    assert.equal(result.exitCode, null)
    assert.match(result.reason, /delete files/i)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('ShellTool denies a working directory outside the worktree', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'artifact-shell-boundary-'))
  const outside = await mkdtemp(join(tmpdir(), 'artifact-shell-outside-'))
  try {
    const result = await new ShellTool().execute({ command: 'printf unsafe' }, {
      cwd: outside,
      workspaceRoot,
      mode: 'read_only',
    })
    assert.equal(result.permission, 'deny')
    assert.equal(result.exitCode, null)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('FileTool enforces read-only writes and keeps reads inside the worktree', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'artifact-file-tool-'))
  try {
    const readOnly = await new FileTool('file_write').execute({ operation: 'write', path: 'note.txt', content: 'blocked' }, {
      cwd: workspaceRoot,
      workspaceRoot,
      mode: 'read_only',
    })
    assert.equal(readOnly.permission, 'deny')
    assert.equal(readOnly.exitCode, null)

    const written = await new FileTool('file_write').execute({ operation: 'write', path: 'nested/note.txt', content: 'saved' }, {
      cwd: workspaceRoot,
      workspaceRoot,
      mode: 'workspace_write',
    })
    assert.equal(written.exitCode, 0)
    const loaded = await new FileTool('file_read').execute({ operation: 'read', path: 'nested/note.txt' }, {
      cwd: workspaceRoot,
      workspaceRoot,
      mode: 'read_only',
    })
    assert.equal(loaded.stdout, 'saved')
    assert.equal(await readFile(join(workspaceRoot, 'nested/note.txt'), 'utf8'), 'saved')
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
