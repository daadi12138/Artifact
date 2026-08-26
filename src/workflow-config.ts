import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type WorkflowCanvasNode = {
  id: string
  title: string
  subtitle: string
  kind: string
  tone: string
  x: number
  y: number
  input?: string
  output: string
  executorId?: string
  prompt?: string
}

export type WorkflowCanvasEdge = { from: string; to: string }
export type WorkflowCanvasDefinition = { version: 1; updatedAt: string; nodes: WorkflowCanvasNode[]; edges: WorkflowCanvasEdge[] }

export const workflowTemplateIds = ['feature-delivery', 'code-review-fix', 'ui-implementation'] as const
export type WorkflowTemplateId = (typeof workflowTemplateIds)[number]

export type WorkflowInputContract = {
  text: boolean
  attachments: boolean
  webAssets: boolean
  description: string
}

export type WorkflowDraft = WorkflowCanvasDefinition & {
  id: string
  name: string
  description: string
  templateId?: WorkflowTemplateId
  createdAt: string
  inputContract: WorkflowInputContract
}

export type PublishedWorkflowRevision = {
  revision: number
  publishedAt: string
  definition: WorkflowDraft
}

export type ResolvedPublishedWorkflowRevision = PublishedWorkflowRevision & {
  workflowId: string
  workflowName: string
}

export type WorkflowRecord = {
  id: string
  createdAt: string
  updatedAt: string
  draft: WorkflowDraft
  published: PublishedWorkflowRevision[]
}

export type WorkflowLibrary = {
  version: 2
  updatedAt: string
  workflows: WorkflowRecord[]
}

export type WorkflowTemplate = {
  id: WorkflowTemplateId
  name: string
  description: string
  inputContract: WorkflowInputContract
  definition: Omit<WorkflowCanvasDefinition, 'updatedAt'>
}

const stateRoot = () => process.env.ARTIFACT_STATE_DIR || join(process.cwd(), '.artifact')
const definitionPath = () => join(stateRoot(), 'workflow.json')
const libraryPath = () => join(stateRoot(), 'workflows.json')
const now = () => new Date().toISOString()

const requirementContract: WorkflowInputContract = {
  text: true,
  attachments: true,
  webAssets: true,
  description: '接收文字需求、本地图片或文件，以及经确认后从网页导入的媒体资源。',
}

function canvas(nodes: WorkflowCanvasNode[], edges: WorkflowCanvasEdge[]): WorkflowCanvasDefinition {
  return { version: 1, updatedAt: now(), nodes, edges }
}

export const defaultWorkflowDefinition = (): WorkflowCanvasDefinition => canvas([
  { id: 'requirement', title: '需求输入', subtitle: 'Requirement', kind: '输入', tone: 'blue', x: 48, y: 154, output: 'requirement', prompt: '描述需要在目标项目中完成的功能和验收标准。' },
  { id: 'ui-spec', title: 'UI 规格', subtitle: 'UI Spec Agent', kind: 'Agent', tone: 'violet', x: 284, y: 154, input: 'requirement', output: 'ui-spec', executorId: 'codex', prompt: '分析需求和现有项目，给出可执行的实现规格、风险与验证方法。' },
  { id: 'approval', title: '人工审批', subtitle: 'Human Approval', kind: '审批', tone: 'amber', x: 520, y: 154, input: 'ui-spec', output: 'approved-spec' },
  { id: 'implementation', title: '实现代码', subtitle: 'Coding Agent', kind: 'Agent', tone: 'violet', x: 756, y: 154, input: 'approval', output: 'code-change', executorId: 'codex', prompt: '按照已批准的规格在 Worktree 中实现代码，保持改动聚焦并运行相关检查。' },
  { id: 'validation', title: '运行验证', subtitle: 'Confirmed Commands', kind: '验证', tone: 'green', x: 992, y: 154, input: 'implementation', output: 'test-report' },
  { id: 'review', title: '代码交付', subtitle: 'Git Diff', kind: '交付', tone: 'slate', x: 1228, y: 154, input: 'validation', output: 'git-diff' },
], [{ from: 'requirement', to: 'ui-spec' }, { from: 'ui-spec', to: 'approval' }, { from: 'approval', to: 'implementation' }, { from: 'implementation', to: 'validation' }, { from: 'validation', to: 'review' }])

function codeReviewDefinition(): WorkflowCanvasDefinition {
  return canvas([
    { id: 'issue', title: '问题输入', subtitle: 'Issue', kind: '输入', tone: 'blue', x: 48, y: 154, output: 'requirement', prompt: '说明问题、预期行为、复现步骤和验收标准。' },
    { id: 'investigation', title: '定位问题', subtitle: 'Investigation Agent', kind: 'Agent', tone: 'violet', x: 284, y: 154, input: 'requirement', output: 'ui-spec', executorId: 'codex', prompt: '阅读相关代码，定位根因，说明影响范围和建议修复方案。' },
    { id: 'implementation', title: '修复实现', subtitle: 'Coding Agent', kind: 'Agent', tone: 'violet', x: 520, y: 154, input: 'ui-spec', output: 'code-change', executorId: 'codex', prompt: '按照定位结果完成最小范围修复，补充必要测试。' },
    { id: 'review', title: '审核 Diff', subtitle: 'Human Review', kind: '审批', tone: 'amber', x: 756, y: 154, input: 'code-change', output: 'approved-spec' },
    { id: 'validation', title: '验证修复', subtitle: 'Confirmed Commands', kind: '验证', tone: 'green', x: 992, y: 154, input: 'approved-spec', output: 'test-report' },
    { id: 'delivery', title: '交付报告', subtitle: 'Git Diff', kind: '交付', tone: 'slate', x: 1228, y: 154, input: 'test-report', output: 'git-diff' },
  ], [{ from: 'issue', to: 'investigation' }, { from: 'investigation', to: 'implementation' }, { from: 'implementation', to: 'review' }, { from: 'review', to: 'validation' }, { from: 'validation', to: 'delivery' }])
}

function uiImplementationDefinition(): WorkflowCanvasDefinition {
  return canvas([
    { id: 'brief', title: '多模态需求', subtitle: 'Brief + References', kind: '输入', tone: 'blue', x: 48, y: 154, output: 'requirement', prompt: '描述页面目标、交互要求，并附上图片、参考链接或媒体资源。' },
    { id: 'ui-spec', title: '界面规格', subtitle: 'UI Spec Agent', kind: 'Agent', tone: 'violet', x: 284, y: 154, input: 'requirement', output: 'ui-spec', executorId: 'codex', prompt: '从需求和参考资料提炼界面结构、关键状态、视觉约束和验收方法。' },
    { id: 'implementation', title: '实现界面', subtitle: 'Coding Agent', kind: 'Agent', tone: 'violet', x: 520, y: 154, input: 'ui-spec', output: 'code-change', executorId: 'codex', prompt: '在 Worktree 中实现界面，保持项目现有设计系统与交互习惯一致。' },
    { id: 'review', title: '审核变更', subtitle: 'Human Review', kind: '审批', tone: 'amber', x: 756, y: 154, input: 'code-change', output: 'approved-spec' },
    { id: 'validation', title: '运行验证', subtitle: 'Confirmed Commands', kind: '验证', tone: 'green', x: 992, y: 154, input: 'approved-spec', output: 'test-report' },
    { id: 'delivery', title: '交付结果', subtitle: 'Git Diff', kind: '交付', tone: 'slate', x: 1228, y: 154, input: 'test-report', output: 'git-diff' },
  ], [{ from: 'brief', to: 'ui-spec' }, { from: 'ui-spec', to: 'implementation' }, { from: 'implementation', to: 'review' }, { from: 'review', to: 'validation' }, { from: 'validation', to: 'delivery' }])
}

export const workflowTemplates = (): WorkflowTemplate[] => [
  { id: 'feature-delivery', name: '功能交付', description: '从需求澄清、方案审批到代码实现、验证和交付。', inputContract: requirementContract, definition: defaultWorkflowDefinition() },
  { id: 'code-review-fix', name: '问题修复与代码审核', description: '定位问题、实现修复、审核 Diff 并完成验证。', inputContract: requirementContract, definition: codeReviewDefinition() },
  { id: 'ui-implementation', name: 'UI 实现', description: '使用文字、图片和网页参考资料完成界面实现与验证。', inputContract: requirementContract, definition: uiImplementationDefinition() },
]

function makeDraft(input: { id?: string; name: string; description: string; templateId?: WorkflowTemplateId; definition: WorkflowCanvasDefinition; createdAt?: string; inputContract?: WorkflowInputContract }): WorkflowDraft {
  const createdAt = input.createdAt ?? now()
  return { ...input.definition, id: input.id ?? `workflow-${randomUUID()}`, name: input.name, description: input.description, templateId: input.templateId, createdAt, inputContract: input.inputContract ?? requirementContract }
}

function makeRecord(draft: WorkflowDraft): WorkflowRecord {
  const timestamp = now()
  return { id: draft.id, createdAt: draft.createdAt, updatedAt: timestamp, draft, published: [] }
}

function templateFor(id: WorkflowTemplateId): WorkflowTemplate {
  const template = workflowTemplates().find(item => item.id === id)
  if (!template) throw new Error(`Unknown workflow template: ${id}`)
  return template
}

function defaultLibrary(): WorkflowLibrary {
  const draft = makeDraft({ id: 'workflow-core-delivery', name: '核心交付链', description: '默认的需求、方案、实现、验证和交付流程。', templateId: 'feature-delivery', definition: defaultWorkflowDefinition() })
  return { version: 2, updatedAt: now(), workflows: [makeRecord(draft)] }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  await rename(temporary, path)
}

async function migrateLegacyWorkflow(): Promise<WorkflowLibrary | null> {
  try {
    const legacy = JSON.parse(await readFile(definitionPath(), 'utf8')) as WorkflowCanvasDefinition
    validateWorkflowDefinition(legacy)
    const draft = makeDraft({ id: 'workflow-core-delivery', name: '核心交付链', description: '从已有 Artifact 工作流迁移而来。', templateId: 'feature-delivery', definition: legacy })
    const library: WorkflowLibrary = { version: 2, updatedAt: now(), workflows: [makeRecord(draft)] }
    await writeJson(libraryPath(), library)
    return library
  } catch { return null }
}

export async function loadWorkflowLibrary(): Promise<WorkflowLibrary> {
  try {
    const library = JSON.parse(await readFile(libraryPath(), 'utf8')) as WorkflowLibrary
    validateWorkflowLibrary(library)
    return library
  } catch { return (await migrateLegacyWorkflow()) ?? defaultLibrary() }
}

export async function saveWorkflowLibrary(library: WorkflowLibrary): Promise<WorkflowLibrary> {
  validateWorkflowLibrary(library)
  const saved = { ...structuredClone(library), version: 2 as const, updatedAt: now() }
  await writeJson(libraryPath(), saved)
  const primary = saved.workflows[0]?.draft
  if (primary) await writeJson(definitionPath(), { version: 1, updatedAt: primary.updatedAt, nodes: primary.nodes, edges: primary.edges })
  return saved
}

export async function createWorkflow(templateId: WorkflowTemplateId, changes: Partial<Pick<WorkflowDraft, 'name' | 'description'>> = {}): Promise<WorkflowRecord> {
  const library = await loadWorkflowLibrary()
  const template = templateFor(templateId)
  const draft = makeDraft({ name: changes.name?.trim() || template.name, description: changes.description?.trim() || template.description, templateId, definition: { ...template.definition, updatedAt: now(), nodes: structuredClone(template.definition.nodes), edges: structuredClone(template.definition.edges) }, inputContract: structuredClone(template.inputContract) })
  const record = makeRecord(draft)
  library.workflows.push(record)
  await saveWorkflowLibrary(library)
  return record
}

export async function updateWorkflowDraft(id: string, changes: Pick<WorkflowDraft, 'nodes' | 'edges'> & Partial<Pick<WorkflowDraft, 'name' | 'description' | 'inputContract'>>): Promise<WorkflowRecord> {
  const library = await loadWorkflowLibrary()
  const record = library.workflows.find(item => item.id === id)
  if (!record) throw new Error('Workflow not found')
  const draft: WorkflowDraft = { ...record.draft, name: changes.name?.trim() || record.draft.name, description: changes.description?.trim() || record.draft.description, inputContract: changes.inputContract ? structuredClone(changes.inputContract) : record.draft.inputContract, nodes: structuredClone(changes.nodes), edges: structuredClone(changes.edges), updatedAt: now() }
  validateWorkflowDefinition(draft)
  record.draft = draft
  record.updatedAt = now()
  await saveWorkflowLibrary(library)
  return record
}

export async function publishWorkflow(id: string): Promise<WorkflowRecord> {
  const library = await loadWorkflowLibrary()
  const record = library.workflows.find(item => item.id === id)
  if (!record) throw new Error('Workflow not found')
  validateWorkflowDefinition(record.draft)
  const revision = (record.published.at(-1)?.revision ?? 0) + 1
  record.published.push({ revision, publishedAt: now(), definition: structuredClone(record.draft) })
  record.updatedAt = now()
  await saveWorkflowLibrary(library)
  return record
}

export async function resolvePublishedWorkflowRevision(id: string, revision: number): Promise<ResolvedPublishedWorkflowRevision> {
  if (!id.trim()) throw new Error('Workflow id is required')
  if (!Number.isInteger(revision) || revision < 1) throw new Error('A valid published workflow revision is required')
  const library = await loadWorkflowLibrary()
  const record = library.workflows.find(item => item.id === id)
  if (!record) throw new Error('Workflow not found')
  const published = record.published.find(item => item.revision === revision)
  if (!published) throw new Error(`Published workflow revision not found: v${revision}`)
  return structuredClone({
    workflowId: record.id,
    workflowName: published.definition.name,
    ...published,
  })
}

export async function deleteWorkflow(id: string): Promise<void> {
  const library = await loadWorkflowLibrary()
  if (library.workflows.length <= 1) throw new Error('Keep at least one workflow in the library')
  const next = library.workflows.filter(item => item.id !== id)
  if (next.length === library.workflows.length) throw new Error('Workflow not found')
  library.workflows = next
  await saveWorkflowLibrary(library)
}

// These wrappers keep the CLI's existing one-workflow contract working while it moves to the library API.
export async function loadWorkflowDefinition(): Promise<WorkflowCanvasDefinition> {
  const library = await loadWorkflowLibrary()
  const draft = library.workflows[0]?.draft
  return draft ? { version: 1, updatedAt: draft.updatedAt, nodes: draft.nodes, edges: draft.edges } : defaultWorkflowDefinition()
}

export async function saveWorkflowDefinition(value: Omit<WorkflowCanvasDefinition, 'version' | 'updatedAt'>): Promise<WorkflowCanvasDefinition> {
  const library = await loadWorkflowLibrary()
  const record = library.workflows[0]
  if (!record) throw new Error('Workflow library is empty')
  const updated = await updateWorkflowDraft(record.id, value)
  return { version: 1, updatedAt: updated.draft.updatedAt, nodes: updated.draft.nodes, edges: updated.draft.edges }
}

export function validateWorkflowLibrary(value: WorkflowLibrary): void {
  if (!value || value.version !== 2 || !Array.isArray(value.workflows) || !value.workflows.length) throw new Error('Workflow library needs at least one workflow')
  const ids = new Set<string>()
  for (const record of value.workflows) {
    if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id)) throw new Error('Workflow ids must be unique')
    if (record.id !== record.draft?.id) throw new Error('Workflow record and draft ids must match')
    if (!record.draft.name.trim()) throw new Error('Workflow name is required')
    validateWorkflowDefinition(record.draft)
    let expectedRevision = 1
    for (const published of record.published ?? []) {
      if (published.revision !== expectedRevision++) throw new Error('Published revisions must be sequential')
      validateWorkflowDefinition(published.definition)
    }
    ids.add(record.id)
  }
}

export function validateWorkflowDefinition(value: WorkflowCanvasDefinition): void {
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) throw new Error('A workflow needs at least one node')
  if (!Array.isArray(value.edges)) throw new Error('Workflow edges must be an array')
  const ids = new Set<string>()
  for (const node of value.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id.trim()) throw new Error('Every node needs an id')
    if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`)
    if (typeof node.title !== 'string' || typeof node.kind !== 'string' || typeof node.output !== 'string') throw new Error(`Invalid node: ${node.id}`)
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) throw new Error(`Invalid position: ${node.id}`)
    ids.add(node.id)
  }
  for (const edge of value.edges) {
    if (!edge || !ids.has(edge.from) || !ids.has(edge.to)) throw new Error('Every edge must reference existing nodes')
    if (edge.from === edge.to) throw new Error(`Self-cycle: ${edge.from}`)
  }
  const inbound = new Map<string, number>(value.nodes.map(node => [node.id, 0]))
  const outgoing = new Map<string, string[]>(value.nodes.map(node => [node.id, []]))
  for (const edge of value.edges) {
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1)
    outgoing.get(edge.from)?.push(edge.to)
  }
  const ready = value.nodes.filter(node => inbound.get(node.id) === 0).map(node => node.id)
  let traversed = 0
  while (ready.length) {
    const id = ready.shift()!
    traversed += 1
    for (const child of outgoing.get(id) ?? []) {
      const count = (inbound.get(child) ?? 1) - 1
      inbound.set(child, count)
      if (count === 0) ready.push(child)
    }
  }
  if (traversed !== value.nodes.length) throw new Error('Workflow cannot contain cycles')
}
