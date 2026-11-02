import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentInstructionContext, buildRepositoryMap, executionStepContext, loadAgentInstructions, orchestrationReviewReason, parseIntentModelOutput, runStateGraph, textualAttachmentContext } from './intelligent-orchestration'

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

test('repository map loads bounded AGENTS.md instructions in directory order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-agent-instructions-'))
  try {
    await writeFile(join(root, 'AGENTS.md'), '# Root rules\nUse npm test.\n')
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'AGENTS.md'), '# Source rules\nKeep changes focused.\n')
    const instructions = await loadAgentInstructions(root)
    assert.deepEqual(instructions.map(item => item.path), ['AGENTS.md', 'src/AGENTS.md'])
    assert.match(agentInstructionContext(instructions), /Source rules/)
    const map = await buildRepositoryMap(root, 'change source')
    assert.equal(map.instructions.length, 2)
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

test('execution plan context narrows global guidance to the current node', () => {
  const context = executionStepContext({ objective: 'Ship the fix', steps: [{ nodeId: 'implementation', objective: 'Update the parser', verification: 'Add a regression test' }], guardrails: ['Keep the diff focused'], recovery: { maxValidationRepairs: 2, preserveWorktree: true, requireHumanApproval: true } }, 'implementation')
  assert.match(context, /Update the parser/)
  assert.match(context, /Add a regression test/)
  assert.match(context, /Keep the diff focused/)
  assert.match(executionStepContext(undefined, 'implementation'), /no generated execution plan/)
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
