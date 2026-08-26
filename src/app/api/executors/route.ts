import { loadExecutorConfigs, saveExecutorConfigs, type ExecutorConfig } from '@artifact/core'

export async function GET() {
  return Response.json(await loadExecutorConfigs())
}

export async function PUT(request: Request) {
  const body = await request.json() as unknown
  if (!Array.isArray(body)) return Response.json({ error: 'Expected an executor config array' }, { status: 400 })
  const configs = body as ExecutorConfig[]
  if (configs.some(config => typeof config.id !== 'string' || typeof config.path !== 'string')) return Response.json({ error: 'Invalid executor config' }, { status: 400 })
  await saveExecutorConfigs(configs)
  return Response.json(configs)
}
