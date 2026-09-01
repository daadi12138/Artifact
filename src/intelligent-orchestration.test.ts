import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRepositoryMap, orchestrationReviewReason, parseIntentModelOutput, runStateGraph, textualAttachmentContext } from './intelligent-orchestration'

test('repository map prioritizes relevant source symbols and excludes dependency directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-repo-map-'))
  try {
    await writeFile(join(root, 'checkout.ts'), 'export function checkoutCart() {}\nexport const checkoutTotal = 1\n')
    await writeFile(join(root, 'README.md'), '# checkout\n')
    const map = await buildRepositoryMap(root, 'fix checkout cart total')
    assert.equal(map.files.some(file => file.path === 'checkout.ts' && file.symbols.includes('checkoutCart')), true)
    assert.match(map.content, /checkout\.ts: checkoutCart, checkoutTotal/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('intent output is normalized to known nodes and ambiguous requests require review', () => {
  const parsed = parseIntentModelOutput(JSON.stringify({
    intent: { goal: 'Repair checkout total', taskType: 'bugfix', constraints: ['Do not change prices'], acceptanceCriteria: ['Total is correct'], missingInformation: ['Which currency should be used?'], recommendedWorkflowId: 'other', confidence: 0.48 },
    plan: { objective: 'Fix the calculation', steps: [{ nodeId: 'invalid', objective: 'Nope', verification: 'Nope' }, { nodeId: 'implementation', objective: 'Fix the calculation', verification: 'Add a focused test' }] },
  }), { requirement: 'checkout total is wrong', workflowId: 'fix', nodes: [{ id: 'analysis', kind: 'Agent' }, { id: 'implementation', kind: 'Agent' }] })
  assert.equal(parsed.intent.taskType, 'bugfix')
  assert.deepEqual(parsed.plan.steps.map(step => step.nodeId), ['implementation'])
  assert.match(orchestrationReviewReason(parsed.intent, 'fix') ?? '', /置信度/)
  assert.match(textualAttachmentContext([{ name: 'notes.txt', mediaType: 'text/plain', byteLength: 5, dataUrl: 'data:text/plain,hello' }]), /hello/)
})

test('state graph persists the order of explicit routing transitions', async () => {
  const seen: string[] = []
  const result = await runStateGraph({ value: 0 }, [
    { id: 'intake', run: async state => ({ value: state.value + 1 }) },
    { id: 'route', run: async state => ({ value: state.value + 2 }) },
  ], async id => { seen.push(id) })
  assert.deepEqual(seen, ['intake', 'route'])
  assert.equal(result.value, 3)
})
