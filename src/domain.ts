import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

export const artifactStatusSchema = z.enum([
  'candidate', 'validating', 'awaiting_approval', 'approved', 'rejected', 'valid', 'invalid', 'superseded',
])
export type ArtifactStatus = z.infer<typeof artifactStatusSchema>

export const artifactVersionRefSchema = z.object({
  artifactId: z.string().min(1),
  version: z.number().int().positive(),
  contentHash: z.string().min(1),
})
export type ArtifactVersionRef = z.infer<typeof artifactVersionRefSchema>

export const artifactVersionSchema = z.object({
  id: z.string(),
  artifactId: z.string(),
  type: z.string().min(1),
  version: z.number().int().positive(),
  status: artifactStatusSchema,
  inputVersions: z.array(artifactVersionRefSchema),
  payload: z.unknown(),
  contentHash: z.string().min(1),
  producer: z.object({ executorId: z.string(), stepId: z.string() }),
  createdAt: z.string(),
})
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>

export type ArtifactSchema = {
  type: string
  validate: (payload: unknown) => void
}

export function contentHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export class ArtifactRegistry {
  private readonly versions = new Map<string, ArtifactVersion[]>()
  private readonly schemas = new Map<string, ArtifactSchema>()

  registerSchema(schema: ArtifactSchema): void {
    this.schemas.set(schema.type, schema)
  }

  create(input: {
    type: string
    payload: unknown
    inputVersions?: ArtifactVersionRef[]
    producer: { executorId: string; stepId: string }
    status?: ArtifactStatus
  }): ArtifactVersion {
    const schema = this.schemas.get(input.type)
    if (schema) schema.validate(input.payload)
    const existing = this.versions.get(input.type) ?? []
    const version = existing.length + 1
    const result: ArtifactVersion = {
      id: randomUUID(),
      artifactId: `${input.type}-${randomUUID().slice(0, 8)}`,
      type: input.type,
      version,
      status: input.status ?? 'valid',
      inputVersions: input.inputVersions ?? [],
      payload: input.payload,
      contentHash: contentHash(input.payload),
      producer: input.producer,
      createdAt: new Date().toISOString(),
    }
    this.versions.set(input.type, [...existing, result])
    return result
  }

  list(type?: string): ArtifactVersion[] {
    if (type) return [...(this.versions.get(type) ?? [])]
    return [...this.versions.values()].flat()
  }

  get(ref: ArtifactVersionRef): ArtifactVersion | undefined {
    return this.list().find(item => item.artifactId === ref.artifactId && item.version === ref.version && item.contentHash === ref.contentHash)
  }
}

export const requirementPayload = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
})

export const uiSpecPayload = z.object({
  pages: z.array(z.object({
    name: z.string().min(1),
    route: z.string().min(1),
    components: z.array(z.string()).min(1),
  })).min(1),
  tokens: z.record(z.string(), z.string()),
  interactions: z.array(z.string()),
})

export function createCoreRegistry(): ArtifactRegistry {
  const registry = new ArtifactRegistry()
  registry.registerSchema({ type: 'requirement', validate: payload => requirementPayload.parse(payload) })
  registry.registerSchema({ type: 'ui-spec', validate: payload => uiSpecPayload.parse(payload) })
  return registry
}
