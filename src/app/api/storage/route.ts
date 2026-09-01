import { cleanupStorage, getStorageOverview, previewStorageCleanup } from '@artifact/core'

type StorageRequest = {
  action?: 'preview' | 'cleanup'
  runIds?: unknown
  retainArtifacts?: unknown
}

export async function GET() {
  return Response.json(await getStorageOverview())
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as StorageRequest
    const input = {
      runIds: normalizeRunIds(body.runIds),
      retainArtifacts: body.retainArtifacts === true,
    }
    if (body.action === 'preview') return Response.json(await previewStorageCleanup(input))
    if (body.action === 'cleanup') {
      if (!input.runIds?.length) throw new Error('Choose at least one completed run to clean up')
      return Response.json(await cleanupStorage({ runIds: input.runIds, retainArtifacts: input.retainArtifacts }))
    }
    throw new Error('Provide a valid storage action')
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}

function normalizeRunIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string')) throw new Error('runIds must be a list of run IDs')
  return value
}
