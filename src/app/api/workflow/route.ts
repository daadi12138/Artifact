import {
  createWorkflow,
  deleteWorkflow,
  loadWorkflowLibrary,
  publishWorkflow,
  saveWorkflowDefinition,
  updateWorkflowDraft,
  workflowTemplateIds,
  workflowTemplates,
  type WorkflowCanvasDefinition,
  type WorkflowInputContract,
  type WorkflowTemplateId,
} from '@artifact/core'

export async function GET() {
  const library = await loadWorkflowLibrary()
  // nodes and edges retain the legacy shape for existing CLI/browser callers.
  const primary = library.workflows[0]?.draft
  return Response.json({ ...library, templates: workflowTemplates(), nodes: primary?.nodes ?? [], edges: primary?.edges ?? [] })
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as {
      id?: string
      name?: string
      description?: string
      inputContract?: WorkflowInputContract
      nodes?: WorkflowCanvasDefinition['nodes']
      edges?: WorkflowCanvasDefinition['edges']
    }
    if (!body.nodes || !body.edges) return Response.json({ error: 'nodes and edges are required' }, { status: 400 })
    if (!body.id) return Response.json(await saveWorkflowDefinition({ nodes: body.nodes, edges: body.edges }))
    return Response.json(await updateWorkflowDraft(body.id, { name: body.name, description: body.description, inputContract: body.inputContract, nodes: body.nodes, edges: body.edges }))
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { action?: string; templateId?: WorkflowTemplateId; id?: string; name?: string; description?: string }
    if (body.action === 'create') {
      if (!body.templateId || !workflowTemplateIds.includes(body.templateId)) return Response.json({ error: 'A supported templateId is required' }, { status: 400 })
      return Response.json(await createWorkflow(body.templateId, { name: body.name, description: body.description }), { status: 201 })
    }
    if (body.action === 'publish') {
      if (!body.id) return Response.json({ error: 'id is required' }, { status: 400 })
      return Response.json(await publishWorkflow(body.id))
    }
    if (body.action === 'delete') {
      if (!body.id) return Response.json({ error: 'id is required' }, { status: 400 })
      await deleteWorkflow(body.id)
      return Response.json({ ok: true })
    }
    return Response.json({ error: 'Unsupported action' }, { status: 400 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
