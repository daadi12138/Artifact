import { approveRun, cancelRun, getRun, pauseRun, rejectRun, resumeRun, retryRun, steerRun } from '@artifact/core'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { const { id } = await context.params; const run = await getRun(id); return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 }) }
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = await request.json().catch(() => ({})) as { action?: string; nodeId?: string; note?: string }
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
  const actions = { approve: approveRun, reject: rejectRun, cancel: cancelRun } as const
  const action = body.action as keyof typeof actions
  if (!action || !actions[action]) return Response.json({ error: 'Unsupported action' }, { status: 400 })
  const run = await actions[action](id)
  return run ? Response.json(run) : Response.json({ error: 'Run not found' }, { status: 404 })
}
