import { approveProjectCommand, createProject, importProject, listRecentProjects, loadProject, projectCommandKeys, revokeProjectCommand, type ProjectCommandKey } from '@artifact/core'

export async function GET() {
  return Response.json({ project: await loadProject(), recentProjects: await listRecentProjects(), suggestedPath: process.cwd() })
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { path?: string; parentPath?: string; name?: string; mode?: 'create' | 'import' }
    if (body.mode === 'create') return Response.json(await createProject(body.parentPath ?? '', body.name ?? ''), { status: 201 })
    return Response.json(await importProject(body.path ?? ''), { status: 201 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { action?: 'allow' | 'revoke'; commandKey?: string }
    if ((body.action !== 'allow' && body.action !== 'revoke') || !isProjectCommandKey(body.commandKey)) throw new Error('Provide a valid command whitelist action')
    const project = body.action === 'allow'
      ? await approveProjectCommand(body.commandKey)
      : await revokeProjectCommand(body.commandKey)
    return Response.json(project)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}

function isProjectCommandKey(value: unknown): value is ProjectCommandKey {
  return typeof value === 'string' && (projectCommandKeys as readonly string[]).includes(value)
}
