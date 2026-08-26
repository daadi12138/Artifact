import type { ArtifactRegistry, ArtifactVersion, ArtifactVersionRef } from './domain'
import type { ExecutionEvent, ExecutorAdapter } from './executor'

export type WorkflowNode = {
  id: string
  executorId: string
  inputTypes: string[]
  outputType: string
}

export type WorkflowEdge = { from: string; to: string }

export type WorkflowDefinition = { nodes: WorkflowNode[]; edges: WorkflowEdge[] }

export type StepResult = { nodeId: string; status: 'succeeded' | 'failed'; outputs: ArtifactVersion[]; error?: string }

export class WorkflowEngine {
  constructor(
    private readonly registry: ArtifactRegistry,
    private readonly executors: Map<string, ExecutorAdapter>,
  ) {}

  async run(definition: WorkflowDefinition, seedInputs: ArtifactVersionRef[], onEvent?: (event: ExecutionEvent) => void): Promise<StepResult[]> {
    this.validate(definition)
    const results: StepResult[] = []
    const outputs = new Map<string, ArtifactVersion[]>()
    const pending = new Set(definition.nodes.map(node => node.id))

    while (pending.size > 0) {
      const ready = definition.nodes.filter(node => pending.has(node.id) && this.isReady(node, definition, outputs, seedInputs))
      if (ready.length === 0) throw new Error('Workflow cannot make progress: missing inputs or cyclic dependency')
      for (const node of ready) {
        pending.delete(node.id)
        const inputs = this.inputsFor(node, definition, outputs, seedInputs)
        const executor = this.executors.get(node.executorId)
        if (!executor) throw new Error(`Executor not found: ${node.executorId}`)
        try {
          const nodeOutputs = await executor.execute({ stepId: node.id, inputs, registry: this.registry }, event => onEvent?.(event))
          outputs.set(node.id, nodeOutputs)
          results.push({ nodeId: node.id, status: 'succeeded', outputs: nodeOutputs })
        } catch (error) {
          results.push({ nodeId: node.id, status: 'failed', outputs: [], error: error instanceof Error ? error.message : String(error) })
          return results
        }
      }
    }
    return results
  }

  private validate(definition: WorkflowDefinition): void {
    const ids = new Set<string>()
    for (const node of definition.nodes) {
      if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`)
      ids.add(node.id)
    }
    for (const edge of definition.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) throw new Error(`Unknown edge: ${edge.from} -> ${edge.to}`)
      if (edge.from === edge.to) throw new Error(`Self-cycle: ${edge.from}`)
    }
  }

  private isReady(node: WorkflowNode, definition: WorkflowDefinition, outputs: Map<string, ArtifactVersion[]>, seedInputs: ArtifactVersionRef[]): boolean {
    const parents = definition.edges.filter(edge => edge.to === node.id).map(edge => edge.from)
    if (parents.some(parent => !outputs.has(parent))) return false
    const inputs = this.inputsFor(node, definition, outputs, seedInputs)
    return node.inputTypes.every(type => inputs.some(input => input.artifactId.startsWith(`${type}-`) || this.registry.get(input)?.type === type))
  }

  private inputsFor(node: WorkflowNode, definition: WorkflowDefinition, outputs: Map<string, ArtifactVersion[]>, seedInputs: ArtifactVersionRef[]): ArtifactVersionRef[] {
    const parents = definition.edges.filter(edge => edge.to === node.id).map(edge => edge.from)
    const refs = parents.flatMap(parent => (outputs.get(parent) ?? []).map(item => ({ artifactId: item.artifactId, version: item.version, contentHash: item.contentHash })))
    return parents.length > 0 ? refs : seedInputs
  }
}
