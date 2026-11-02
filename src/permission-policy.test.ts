import assert from 'node:assert/strict'
import test from 'node:test'
import { assessPermission, commandRisk, withinWorkspace } from './permission-policy'

test('permission policy enforces Worktree boundaries and read-only writes', () => {
  assert.equal(withinWorkspace('/tmp/project/src', '/tmp/project'), true)
  assert.equal(withinWorkspace('/tmp/project-other', '/tmp/project'), false)
  assert.equal(assessPermission({ tool: 'file_write', mode: 'read_only' }).decision, 'deny')
  assert.equal(assessPermission({ tool: 'shell', mode: 'workspace_write', cwd: '/tmp/other', workspaceRoot: '/tmp/project', command: 'npm test', approved: true }).decision, 'deny')
})

test('permission policy classifies risky shell commands', () => {
  assert.equal(commandRisk('npm test'), 'low')
  assert.equal(commandRisk('npm install'), 'medium')
  assert.equal(commandRisk('git reset --hard HEAD'), 'high')
  assert.equal(assessPermission({ tool: 'shell', mode: 'workspace_write', command: 'npm install' }).decision, 'approval_required')
})
