import { listRuns, resolvePublishedWorkflowRevision, startRun, type RunInput, type WorkflowRunReference } from '@artifact/core'
import { z } from 'zod'

const runNodeSchema = z.object({
  id: z.string().trim().min(1).max(120),
  kind: z.string().trim().min(1).max(40),
  executorId: z.string().trim().max(80).optional(),
  executionMode: z.enum(['read_only', 'workspace_write']).optional(),
  prompt: z.string().max(16_000).optional(),
  outputType: z.string().trim().max(120).optional(),
})
const runEdgeSchema = z.object({ from: z.string().trim().min(1).max(120), to: z.string().trim().min(1).max(120) })
const runInputSchema = z.object({
  text: z.string().max(40_000).optional(),
  attachments: z.array(z.object({
    id: z.string().max(120).optional(),
    name: z.string().max(180).optional(),
    mediaType: z.string().max(120).optional(),
    byteLength: z.number().finite().nonnegative().max(8 * 1024 * 1024).optional(),
    dataUrl: z.string().max(11_200_000).optional(),
    sourceUrl: z.string().max(2_000).optional(),
  })).max(12).optional(),
  submittedAt: z.string().max(100).optional(),
}).optional()
const workflowReferenceSchema = z.object({ workflowId: z.string().trim().min(1).max(160), revision: z.number().int().positive() }).partial()

export async function GET() {
  return Response.json(await listRuns())
}

export async function POST(request: Request) {
  try {
    const body = z.object({ nodes: z.array(runNodeSchema).max(200).optional(), edges: z.array(runEdgeSchema).max(400).optional(), input: runInputSchema, workflow: workflowReferenceSchema.optional() }).parse(await request.json())
    if (body.workflow) {
      const published = await resolvePublishedWorkflowRevision(body.workflow.workflowId ?? '', body.workflow.revision ?? 0)
      const workflow: WorkflowRunReference = {
        workflowId: published.workflowId,
        workflowName: published.workflowName,
        revision: published.revision,
        publishedAt: published.publishedAt,
      }
      const nodes = published.definition.nodes.map(node => ({
        id: node.id,
        kind: node.kind,
        executorId: node.executorId,
        executionMode: node.executionMode,
        prompt: node.prompt,
        outputType: node.output,
      }))
      return Response.json(await startRun({ nodes, edges: published.definition.edges, input: body.input as RunInput | undefined, workflow, intentAware: true }), { status: 201 })
    }
    if (!body.nodes?.length) throw new Error('nodes are required')
    return Response.json(await startRun({ nodes: body.nodes!, edges: body.edges ?? [], input: body.input as RunInput | undefined }), { status: 201 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
