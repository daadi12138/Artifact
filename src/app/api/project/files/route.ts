import { listProjectFiles, readProjectFile, writeProjectFile } from '@artifact/core'

export async function GET(request: Request) {
  try {
    const path = new URL(request.url).searchParams.get('path')
    return Response.json(path ? await readProjectFile(path) : await listProjectFiles())
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as { path?: string; content?: string }
    if (!body.path || typeof body.content !== 'string') throw new Error('path and content are required')
    return Response.json({ file: await writeProjectFile(body.path, body.content) })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
