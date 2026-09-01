export type JsonSchema = {
  $id: string
  version: number
  type: 'object'
  required: string[]
  properties: Record<string, { type: 'string' | 'array'; minLength?: number; items?: { type: 'string' } }>
}

const reportSchema = (id: string): JsonSchema => ({
  $id: id,
  version: 1,
  type: 'object',
  required: ['summary', 'content'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    content: { type: 'string', minLength: 1 },
    changedFiles: { type: 'array', items: { type: 'string' } },
  },
})

const schemas = new Map<string, JsonSchema>([
  ['requirement', reportSchema('artifact://schemas/requirement')],
  ['run-input', reportSchema('artifact://schemas/run-input')],
  ['intent-spec', reportSchema('artifact://schemas/intent-spec')],
  ['repository-map', reportSchema('artifact://schemas/repository-map')],
  ['execution-plan', reportSchema('artifact://schemas/execution-plan')],
  ['operator-note', reportSchema('artifact://schemas/operator-note')],
  ['ui-spec', reportSchema('artifact://schemas/ui-spec')],
  ['approved-spec', reportSchema('artifact://schemas/approved-spec')],
  ['implementation-report', reportSchema('artifact://schemas/implementation-report')],
  ['code-change', reportSchema('artifact://schemas/code-change')],
  ['code-diff', reportSchema('artifact://schemas/code-diff')],
  ['test-report', reportSchema('artifact://schemas/test-report')],
  ['git-diff', reportSchema('artifact://schemas/git-diff')],
  ['delivery-report', reportSchema('artifact://schemas/delivery-report')],
  ['agent-report', reportSchema('artifact://schemas/agent-report')],
  ['tool-result', reportSchema('artifact://schemas/tool-result')],
])

export function schemaFor(type: string): JsonSchema {
  return schemas.get(type) ?? reportSchema(`artifact://schemas/${encodeURIComponent(type)}`)
}

export function validatePayload(schema: JsonSchema, payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['Payload must be an object']
  const value = payload as Record<string, unknown>
  const errors: string[] = []
  for (const field of schema.required) if (!(field in value)) errors.push(`Missing required field: ${field}`)
  for (const [field, rule] of Object.entries(schema.properties)) {
    if (!(field in value)) continue
    if (rule.type === 'string' && (typeof value[field] !== 'string' || (rule.minLength && value[field].length < rule.minLength))) errors.push(`${field} must be a non-empty string`)
    if (rule.type === 'array' && (!Array.isArray(value[field]) || value[field].some(item => typeof item !== rule.items?.type))) errors.push(`${field} must be a string array`)
  }
  return errors
}
