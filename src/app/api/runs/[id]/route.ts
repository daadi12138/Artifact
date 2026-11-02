import { answerRunInteraction, approveRun, cancelRun, getRun, pauseRun, rejectRun, requestDeliveryApproval, requestRunInteraction, restoreDeletedDeliveryFiles, resumeRun, retryRun, steerRun, type HumanInteractionKind, type HumanInteractionOption, type HumanInteractionSource } from '@artifact/core'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { const { id } = await context.params; const run = await getRun(id); return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 }) }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = await request.json().catch(() => ({})) as { action?: string; nodeId?: string; note?: string; interactionId?: string; answer?: unknown; interaction?: { nodeId?: string; attemptId?: string; source?: HumanInteractionSource; kind?: HumanInteractionKind; title?: string; question?: string; context?: { command?: string; cwd?: string; files?: string[]; risk?: 'low' | 'medium' | 'high' }; options?: HumanInteractionOption[]; required?: boolean } }
  if (body.action === 'answer_interaction') {
    if (!body.interactionId) return Response.json({ error: 'interactionId is required' }, { status: 400 })
    try { const run = await answerRunInteraction(id, body.interactionId, body.answer); return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 }) }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }) }
  }
  if (body.action === 'request_interaction') {
    const interaction = body.interaction
    if (!interaction?.kind || !interaction.title || !interaction.question) return Response.json({ error: 'interaction.kind, interaction.title and interaction.question are required' }, { status: 400 })
    try {
      const run = await requestRunInteraction(id, { nodeId: interaction.nodeId, attemptId: interaction.attemptId, source: interaction.source ?? 'operator', kind: interaction.kind, title: interaction.title, question: interaction.question, context: interaction.context, options: interaction.options, required: interaction.required !== false })
      return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 })
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }) }
  }
  if (body.action === 'retry') {
    if (!body.nodeId) return Response.json({ error: 'nodeId is required' }, { status: 400 })
    try {
      const run = await retryRun(id, body.nodeId)
      return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 })
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
    }
  }
  if (body.action === 'pause') {
    try { const run = await pauseRun(id, body.nodeId); return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 }) }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }) }
  }
  if (body.action === 'resume') {
    try { const run = await resumeRun(id); return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 }) }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }) }
  }
  if (body.action === 'steer') {
    if (!body.nodeId || !body.note) return Response.json({ error: 'nodeId and note are required' }, { status: 400 })
    try { const run = await steerRun(id, body.nodeId, body.note); return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 }) }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }) }
  }
  if (body.action === 'request_delivery') {
    try { const run = await requestDeliveryApproval(id); return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 }) }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }) }
  }
  if (body.action === 'restore_deleted') {
    try { const run = await restoreDeletedDeliveryFiles(id); return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 }) }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }) }
  }
  const actions = { approve: approveRun, reject: rejectRun, cancel: cancelRun } as const
  const action = body.action as keyof typeof actions
  if (!action || !actions[action]) return Response.json({ error: 'Unsupported action' }, { status: 400 })
  const run = await actions[action](id)
  return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 })
}
