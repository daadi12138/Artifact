import type { ArtifactRegistry, ArtifactVersion, ArtifactVersionRef } from './domain'

export type ExecutionEvent =
  | { type: 'started'; stepId: string; executorId: string }
  | { type: 'artifact'; artifact: ArtifactVersion }
  | { type: 'completed'; stepId: string }
  | { type: 'failed'; stepId: string; error: string }

export interface ExecutionContext {
  stepId: string
  inputs: ArtifactVersionRef[]
  registry: ArtifactRegistry
}

export interface ExecutorAdapter {
  readonly id: string
  execute(context: ExecutionContext, emit: (event: ExecutionEvent) => void): Promise<ArtifactVersion[]>
}

export class FixtureExecutor implements ExecutorAdapter {
  constructor(
    public readonly id: string,
    private readonly handler: (context: ExecutionContext) => Record<string, unknown>,
  ) {}

  async execute(context: ExecutionContext, emit: (event: ExecutionEvent) => void): Promise<ArtifactVersion[]> {
    emit({ type: 'started', stepId: context.stepId, executorId: this.id })
    try {
      const output = this.handler(context)
      const artifact = context.registry.create({
        type: String(output.type),
        payload: output.payload,
        inputVersions: context.inputs,
        producer: { executorId: this.id, stepId: context.stepId },
      })
      emit({ type: 'artifact', artifact })
      emit({ type: 'completed', stepId: context.stepId })
      return [artifact]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit({ type: 'failed', stepId: context.stepId, error: message })
      throw error
    }
  }
}
