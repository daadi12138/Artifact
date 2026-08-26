import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkflow, defaultWorkflowDefinition, loadWorkflowDefinition, loadWorkflowLibrary, publishWorkflow, resolvePublishedWorkflowRevision, saveWorkflowDefinition, updateWorkflowDraft, validateWorkflowDefinition } from './workflow-config'

test('default workflow definition is executable as a DAG', () => {
  assert.doesNotThrow(() => validateWorkflowDefinition(defaultWorkflowDefinition()))
})

test('workflow definition rejects a cycle before saving', () => {
  const workflow = defaultWorkflowDefinition()
  workflow.edges.push({ from: 'review', to: 'requirement' })
  assert.throws(() => validateWorkflowDefinition(workflow), /cannot contain cycles/)
})

test('workflow persistence honors the desktop state directory', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'artifact-workflow-'))
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = stateDirectory
  try {
    const workflow = defaultWorkflowDefinition()
    workflow.nodes[0].title = 'Desktop requirement'
    await saveWorkflowDefinition(workflow)
    const stored = JSON.parse(await readFile(join(stateDirectory, 'workflow.json'), 'utf8')) as { nodes: Array<{ title: string }> }
    assert.equal(stored.nodes[0].title, 'Desktop requirement')
    assert.equal((await loadWorkflowDefinition()).nodes[0].title, 'Desktop requirement')
  } finally {
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test('published workflow revisions stay immutable when the draft changes', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'artifact-workflow-library-'))
  const previousState = process.env.ARTIFACT_STATE_DIR
  process.env.ARTIFACT_STATE_DIR = stateDirectory
  try {
    const created = await createWorkflow('code-review-fix', { name: 'Bug fix' })
    const published = await publishWorkflow(created.id)
    assert.equal(published.published.length, 1)
    assert.equal(published.published[0]?.definition.name, 'Bug fix')

    const updated = await updateWorkflowDraft(created.id, {
      name: 'Bug fix revised',
      nodes: published.draft.nodes.map(node => node.id === 'issue' ? { ...node, title: 'Reproduction input' } : node),
      edges: published.draft.edges,
    })
    assert.equal(updated.draft.name, 'Bug fix revised')
    assert.equal(updated.published[0]?.definition.name, 'Bug fix')
    assert.equal(updated.published[0]?.definition.nodes.find(node => node.id === 'issue')?.title, '问题输入')
    assert.equal((await loadWorkflowLibrary()).workflows.find(workflow => workflow.id === created.id)?.published[0]?.revision, 1)
    const resolved = await resolvePublishedWorkflowRevision(created.id, 1)
    assert.equal(resolved.workflowName, 'Bug fix')
    assert.equal(resolved.definition.nodes.find(node => node.id === 'issue')?.title, '问题输入')
    await assert.rejects(() => resolvePublishedWorkflowRevision(created.id, 2), /Published workflow revision not found: v2/)
  } finally {
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
