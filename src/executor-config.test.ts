import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configureExecutor, defaultExecutorConfigs, executorDefinitions, extractClaudeModelOptions, isOlderVersion, manualInstallCommands, mergeExecutorConfigs, modelIsAllowed, parseCodexModelOptions, saveExecutorConfigs } from './executor-config'

test('executor registry exposes only implemented Run adapters with reviewed, static npm plans', () => {
  const commands = manualInstallCommands()
  assert.equal(commands.length, 2)
  assert.ok(commands.every(item => item.command.startsWith('npm install --global ')))
  assert.ok(!commands.some(item => item.command.includes('\n')))
  assert.deepEqual(executorDefinitions.map(definition => definition.id), ['claude', 'codex'])
})

test('saved executor settings retain existing connections and gain newly supported runtimes', () => {
  const saved = [{ ...defaultExecutorConfigs.find(config => config.id === 'codex')!, status: 'available' as const, path: '/Applications/Codex/bin/codex', version: '0.55.0' }]
  const merged = mergeExecutorConfigs(saved)
  assert.equal(merged.find(config => config.id === 'codex')?.status, 'available')
  assert.equal(merged.find(config => config.id === 'codex')?.path, '/Applications/Codex/bin/codex')
  assert.deepEqual(merged.map(config => config.id), ['claude', 'codex'])
})

test('model choices accept only the models declared by the runnable executor', async () => {
  const previousState = process.env.ARTIFACT_STATE_DIR
  const state = await mkdtemp(join(tmpdir(), 'artifact-executor-state-'))
  process.env.ARTIFACT_STATE_DIR = state
  try {
    const configured = await configureExecutor('codex', { model: '' })
    assert.equal(configured.model, '')
    await assert.rejects(() => configureExecutor('codex', { model: 'unreviewed-model' }), /Unsupported model selection/)
  } finally {
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(state, { recursive: true, force: true })
  }
})

test('model discovery parses Codex catalogs and Claude CLI aliases without running an Agent prompt', () => {
  const codexOptions = parseCodexModelOptions('{"models":[{"slug":"gpt-5.6-sol","display_name":"GPT-5.6 Sol","visibility":"list"},{"slug":"hidden","display_name":"Hidden","visibility":"hidden"}]}')
  assert.deepEqual(codexOptions, [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }])
  assert.deepEqual(extractClaudeModelOptions("--model <model>\n  Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5').\n  -n, --name <name>"), [
    { value: 'fable', label: 'Fable' },
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'claude-fable-5', label: 'Claude-Fable-5' },
  ])
})

test('a discovered catalog extends the reviewed model selection without allowing arbitrary values', async () => {
  const previousState = process.env.ARTIFACT_STATE_DIR
  const state = await mkdtemp(join(tmpdir(), 'artifact-executor-state-'))
  const catalog = {
    source: 'codex-cli-catalog' as const,
    discoveredAt: '2026-08-25T00:00:00.000Z',
    cliVersion: 'codex-cli 1.0.0',
    modelOptions: [{ value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }],
    availabilityNote: 'Catalog only',
  }
  process.env.ARTIFACT_STATE_DIR = state
  try {
    assert.equal(modelIsAllowed('codex', 'gpt-5.6-sol', catalog), true)
    assert.equal(modelIsAllowed('codex', 'not-from-the-cli', catalog), false)
    await saveExecutorConfigs([{ ...defaultExecutorConfigs.find(config => config.id === 'codex')!, modelCatalog: catalog }])
    assert.equal((await configureExecutor('codex', { model: 'gpt-5.6-sol' })).model, 'gpt-5.6-sol')
    await assert.rejects(() => configureExecutor('codex', { model: 'not-from-the-cli' }), /Unsupported model selection/)
  } finally {
    if (previousState === undefined) delete process.env.ARTIFACT_STATE_DIR
    else process.env.ARTIFACT_STATE_DIR = previousState
    await rm(state, { recursive: true, force: true })
  }
})

test('version checks accept common CLI prefixes and compare numeric components', () => {
  assert.equal(isOlderVersion('codex-cli 0.55.0', '0.56.0'), true)
  assert.equal(isOlderVersion('v1.12.0', '1.12.0'), false)
  assert.equal(isOlderVersion('2.1.241', '2.1.24'), false)
  assert.equal(isOlderVersion('unavailable', '1.0.0'), false)
})
