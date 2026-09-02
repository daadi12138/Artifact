import { readArtifactPayload, reviseArtifactPayload } from '@artifact/core'

export async function GET(_request: Request, context: { params: Promise<{ id: string; artifactId: string }> }) {
  const { id, artifactId } = await context.params
  const payload = await readArtifactPayload(id, artifactId)
  return payload === null ? Response.json({ error: 'Artifact not found' }, { status: 404 }) : Response.json(payload)
}

export async function PUT(request: Request, context: { params: Promise<{ id: string; artifactId: string }> }) {
  try {
    const { id, artifactId } = await context.params
    const body = await request.json() as { payload?: unknown }
    const artifact = await reviseArtifactPayload(id, artifactId, body.payload)
    return artifact === null
      ? Response.json({ error: 'Artifact not found' }, { status: 404 })
      : Response.json({ artifact, payload: body.payload })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Unable to save Artifact revision' }, { status: 400 })
  }
}
