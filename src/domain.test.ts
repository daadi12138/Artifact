import assert from 'node:assert/strict'
import test from 'node:test'
import { createCoreRegistry } from './domain'
import { schemaFor, validatePayload } from './artifact-schema'

test('artifact registry versions validated payloads and preserves lineage', () => {
  const registry = createCoreRegistry()
  const requirement = registry.create({
    type: 'requirement',
    payload: { title: 'Projects', description: 'Manage projects', acceptanceCriteria: ['User can create a project'] },
    producer: { executorId: 'fixture-product', stepId: 'requirement' },
  })
  const second = registry.create({
    type: 'requirement',
    payload: { title: 'Projects v2', description: 'Manage projects', acceptanceCriteria: ['User can create a project'] },
    inputVersions: [{ artifactId: requirement.artifactId, version: requirement.version, contentHash: requirement.contentHash }],
    producer: { executorId: 'fixture-product', stepId: 'requirement-revision' },
  })
  assert.equal(second.version, 2)
  assert.equal(registry.get(second.inputVersions[0])?.id, requirement.id)
  assert.throws(() => registry.create({ type: 'requirement', payload: { title: '', description: '', acceptanceCriteria: [] }, producer: { executorId: 'bad', stepId: 'bad' } }))
})

test('runtime artifact schemas reject incomplete payloads', () => {
  const schema = schemaFor('test-report')
  assert.deepEqual(validatePayload(schema, { summary: 'passed', content: 'all checks passed' }), [])
  assert.deepEqual(validatePayload(schema, { summary: '', content: '' }), ['summary must be a non-empty string', 'content must be a non-empty string'])
})
