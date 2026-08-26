import { scanLocalExecutors } from '@artifact/core'

export async function POST(request: Request) {
  let includeLatest = true
  try {
    const body = await request.json() as { includeLatest?: unknown }
    includeLatest = body.includeLatest !== false
  } catch {
    // An empty request means the user asked for the normal, complete scan.
  }
  return Response.json(await scanLocalExecutors({ includeLatest }))
}
