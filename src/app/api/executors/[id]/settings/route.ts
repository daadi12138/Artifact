import { configureExecutor } from '@artifact/core'

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  try {
    const body = await request.json() as { model?: unknown }
    if (typeof body.model !== 'string') return Response.json({ error: 'Model selection is required' }, { status: 400 })
    return Response.json({ config: await configureExecutor(id, { model: body.model }) })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 })
  }
}
