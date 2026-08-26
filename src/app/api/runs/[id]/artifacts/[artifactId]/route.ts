import { readArtifactPayload } from '@artifact/core'

export async function GET(_request: Request, context: { params: Promise<{ id: string; artifactId: string }> }) {
  const { id, artifactId } = await context.params
  const payload = await readArtifactPayload(id, artifactId)
  return payload === null ? Response.json({ error: 'Artifact not found' }, { status: 404 }) : Response.json(payload)
}
