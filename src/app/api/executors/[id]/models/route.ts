import { discoverExecutorModels } from '@artifact/core'

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  try {
    return Response.json({ catalog: await discoverExecutorModels(id) })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 })
  }
}
