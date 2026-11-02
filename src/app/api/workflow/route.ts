import {
  createWorkflow,
  deleteWorkflow,
  loadWorkflowLibrary,
  publishWorkflow,
  saveWorkflowDefinition,
  updateWorkflowDraft,
  workflowTemplateIds,
  workflowTemplates,
  type WorkflowTemplateId,
} from '@artifact/core'
import { z } from 'zod'

const workflowNodeSchema = z.object({
  id: z.string().trim().min(1).max(120), title: z.string().max(160), subtitle: z.string().max(160),
  kind: z.string().trim().min(1).max(40), tone: z.string().max(40),
  x: z.number().finite().min(-100_000).max(100_000), y: z.number().finite().min(-100_000).max(100_000),
  input: z.string().max(120).optional(), output: z.string().trim().min(1).max(120),
  executorId: z.string().trim().max(80).optional(), executionMode: z.enum(['read_only', 'workspace_write']).optional(), prompt: z.string().max(16_000).optional(),
})
const workflowEdgeSchema = z.object({ from: z.string().trim().min(1).max(120), to: z.string().trim().min(1).max(120) })
const inputContractSchema = z.object({ text: z.boolean(), attachments: z.boolean(), webAssets: z.boolean(), description: z.string().max(2_000) })

export async function GET() {
  const library = await loadWorkflowLibrary()
  // nodes and edges retain the legacy shape for existing CLI/browser callers.
  const primary = library.workflows[0]?.draft
  return Response.json({ ...library, templates: workflowTemplates(), nodes: primary?.nodes ?? [], edges: primary?.edges ?? [] })
}

export async function PUT(request: Request) {
  try {
    const body = z.object({ id: z.string().trim().max(160).optional(), name: z.string().max(200).optional(), description: z.string().max(4_000).optional(), inputContract: inputContractSchema.optional(), nodes: z.array(workflowNodeSchema).max(200).optional(), edges: z.array(workflowEdgeSchema).max(400).optional() }).parse(await request.json())
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
