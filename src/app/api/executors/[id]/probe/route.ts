import { scanLocalExecutors } from '@artifact/core'

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const executor = (await scanLocalExecutors()).executors.find(item => item.id === id)
  if (!executor) return Response.json({ error: 'Executor not found' }, { status: 404 })
  return Response.json({ ok: executor.connected, executor })
}
