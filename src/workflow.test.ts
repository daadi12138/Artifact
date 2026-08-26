import assert from 'node:assert/strict'
import test from 'node:test'
import { createCoreRegistry } from './domain'
import { FixtureExecutor } from './executor'
import { WorkflowEngine } from './workflow'

test('workflow passes only versioned artifact references between executors', async () => {
  const registry = createCoreRegistry()
  const product = new FixtureExecutor('fixture-product', () => ({
    type: 'requirement',
    payload: { title: 'Projects', description: 'Manage projects', acceptanceCriteria: ['Create works'] },
  }))
  const ui = new FixtureExecutor('fixture-ui', context => {
    const input = context.registry.get(context.inputs[0])
    assert.equal(input?.type, 'requirement')
    return { type: 'ui-spec', payload: { pages: [{ name: 'Projects', route: '/projects', components: ['ProjectList'] }], tokens: {}, interactions: ['Create project'] } }
  })
  const events: string[] = []
  const results = await new WorkflowEngine(registry, new Map([['fixture-product', product], ['fixture-ui', ui]])).run({
    nodes: [
      { id: 'requirement', executorId: 'fixture-product', inputTypes: [], outputType: 'requirement' },
      { id: 'ui-spec', executorId: 'fixture-ui', inputTypes: ['requirement'], outputType: 'ui-spec' },
    ],
    edges: [{ from: 'requirement', to: 'ui-spec' }],
  }, [], event => events.push(event.type))
  assert.deepEqual(results.map(result => result.status), ['succeeded', 'succeeded'])
  assert.deepEqual(results[1].outputs[0].inputVersions.length, 1)
  assert.deepEqual(events, ['started', 'artifact', 'completed', 'started', 'artifact', 'completed'])
})
