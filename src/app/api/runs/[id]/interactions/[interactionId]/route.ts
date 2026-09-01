import { answerRunInteraction } from '@artifact/core'

export async function POST(request: Request, context: { params: Promise<{ id: string; interactionId: string }> }) {
  const { id, interactionId } = await context.params
  const body = await request.json().catch(() => ({})) as { answer?: unknown }
  if (!Object.prototype.hasOwnProperty.call(body, 'answer')) return Response.json({ error: 'answer is required' }, { status: 400 })
  try {
    const run = await answerRunInteraction(id, interactionId, body.answer)
    return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
