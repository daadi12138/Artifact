import { executorDefinitions, maintainExecutors } from '@artifact/core'

export async function POST(request: Request) {
  const body = await request.json() as { executorIds?: unknown; action?: unknown; confirmed?: unknown }
  if (body.confirmed !== true) return Response.json({ error: 'Explicit confirmation is required' }, { status: 400 })
  if (body.action !== 'install' && body.action !== 'update') return Response.json({ error: 'Unsupported maintenance action' }, { status: 400 })
  if (!Array.isArray(body.executorIds) || body.executorIds.some(id => typeof id !== 'string')) return Response.json({ error: 'executorIds must be an array of supported executor IDs' }, { status: 400 })
  const supported = new Set(executorDefinitions.filter(definition => definition.installPlan).map(definition => definition.id))
  const executorIds = body.executorIds.filter((id): id is string => typeof id === 'string' && supported.has(id))
  if (!executorIds.length) return Response.json({ error: 'No managed executors were selected' }, { status: 400 })
  return Response.json({ results: await maintainExecutors(executorIds, body.action) })
}
