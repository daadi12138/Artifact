import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadExecutorConfigs, saveExecutorConfigs } from '@artifact/core'

const execFileAsync = promisify(execFile)

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const configs = await loadExecutorConfigs()
  const config = configs.find(item => item.id === id)
  if (!config) return Response.json({ error: 'Executor not found' }, { status: 404 })
  try {
    const result = await execFileAsync(config.path, ['--version'], { timeout: 8_000, maxBuffer: 32_000 })
    const version = `${result.stdout || result.stderr}`.trim().split('\n')[0].slice(0, 120)
    const updated = configs.map(item => item.id === id ? { ...item, status: 'available' as const, version, capabilities: item.capabilities.length ? item.capabilities : ['流式输出', '结构化输出'] } : item)
    await saveExecutorConfigs(updated)
    return Response.json({ ok: true, version, config: updated.find(item => item.id === id) })
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
    const updated = configs.map(item => item.id === id ? { ...item, status: 'unconfigured' as const, version: '' } : item)
    await saveExecutorConfigs(updated)
    return Response.json({ ok: false, error: message, config: updated.find(item => item.id === id) }, { status: 422 })
  }
}
