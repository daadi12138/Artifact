import { listRuns, resolvePublishedWorkflowRevision, startRun, type RunInput, type WorkflowRunReference } from '@artifact/core'

export async function GET() {
  return Response.json(await listRuns())
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      nodes?: Array<{ id: string; kind: string; executorId?: string; executionMode?: 'read_only' | 'workspace_write'; prompt?: string; outputType?: string }>
      edges?: Array<{ from: string; to: string }>
      input?: RunInput
      workflow?: Partial<WorkflowRunReference>
    }
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
      return Response.json(await startRun({ nodes, edges: published.definition.edges, input: body.input, workflow, intentAware: true }), { status: 201 })
    }
    if (!body.nodes?.length) throw new Error('nodes are required')
    return Response.json(await startRun({ nodes: body.nodes, edges: body.edges ?? [], input: body.input }), { status: 201 })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }
}
