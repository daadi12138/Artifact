import type { RunWorkspaceRun } from './run-workspace'

export type TimelineItem = {
  id: string; occurredAt: string; order: number; kind: string; label: string; title: string
  nodeId?: string; attemptId?: string; artifactId?: string; toolName?: string; content?: string; command?: string
  status?: string; exitCode?: number; durationMs?: number; truncated?: boolean; redacted?: boolean
  details?: Record<string, string | number | boolean | null>
}

export function runGroup(status: string): 'active' | 'attention' | 'history' {
  return status === 'running' || status === 'preparing' ? 'active'
    : ['paused', 'awaiting_input', 'awaiting_approval', 'awaiting_delivery'].includes(status) ? 'attention' : 'history'
}

function toolLabel(toolName = '', command = '') {
  if (/\b(test|pytest|vitest|jest|verify|typecheck)\b/i.test(command)) return '测试与验证'
  if (/edit|write|patch/i.test(toolName)) return '编辑文件'
  if (/read|search|glob|grep|list/i.test(toolName)) return '读取与搜索'
  return command ? '执行命令' : '工具调用'
}

export function buildRunTimeline(run: RunWorkspaceRun | null): TimelineItem[] {
  if (!run) return []
  const items: TimelineItem[] = []
  const add = (item: Omit<TimelineItem, 'order'>) => items.push({ ...item, order: items.length })
  add({ id: `${run.id}:input`, occurredAt: run.input.submittedAt ?? run.startedAt, kind: 'user', label: '你的需求', title: '任务输入', content: run.input.text,
    details: run.input.attachments.length ? { attachments: run.input.attachments.map(item => item.name).join('、') } : undefined })
  for (const node of run.nodes) for (const attempt of node.attempts) {
    for (const event of attempt.trace ?? []) {
      if (event.nodeId !== node.id || event.attemptId !== attempt.id) continue
      const label = event.kind.startsWith('tool_') ? toolLabel(event.toolName, event.command)
        : ({ reasoning_summary: '决策摘要', agent_message: 'Agent 消息', status: '状态', error: '错误', tool_started: '工具调用', tool_completed: '工具调用' })[event.kind]
      add({ ...event, id: `${attempt.id}:trace:${event.seq}`, label, title: `${node.id} · ${label}` })
    }
    if (attempt.traceOmittedCount) add({ id: `${attempt.id}:omitted`, occurredAt: attempt.startedAt, nodeId: node.id, attemptId: attempt.id,
      kind: 'status', label: '记录范围', title: `${node.id} · 已省略 ${attempt.traceOmittedCount} 条较早记录` })
    if (attempt.finalResponse) add({ id: `${attempt.id}:result`, occurredAt: attempt.endedAt ?? attempt.startedAt, nodeId: node.id, attemptId: attempt.id,
      kind: 'agent_message', label: '最终回复', title: `${node.id} · Attempt ${attempt.attempt}`, content: attempt.finalResponse,
      redacted: attempt.finalResponseRedacted, truncated: attempt.finalResponseTruncated })
  }
  for (const event of run.events) {
    const details = event.details ? { ...event.details } : undefined
    const content = typeof details?.text === 'string' ? details.text : undefined
    if (details) delete details.text
    add({ ...event, kind: event.type, label: ({ 'run-created': '运行', 'run-state': '状态', 'node-state': '节点', command: '命令', executor: '执行器', artifact: '产物', operator: '操作员', activity: '活动', error: '错误' })[event.type],
      title: event.message, content, details, artifactId: typeof details?.artifactId === 'string' ? details.artifactId : undefined })
  }
  for (const interaction of run.interactions ?? []) {
    add({ id: `${interaction.id}:request`, occurredAt: interaction.createdAt, nodeId: interaction.nodeId, attemptId: interaction.attemptId,
      kind: 'operator', label: interaction.kind === 'permission' ? '权限审批' : '人工交互', title: interaction.title,
      content: interaction.question, command: interaction.context?.command, status: interaction.status })
    if (interaction.answeredAt) add({ id: `${interaction.id}:answer`, occurredAt: interaction.answeredAt, nodeId: interaction.nodeId, attemptId: interaction.attemptId,
      kind: 'user', label: '你的响应', title: interaction.title, content: typeof interaction.answer === 'string' ? interaction.answer : JSON.stringify(interaction.answer) })
  }
  if (run.pendingCommandApproval) add({ id: `${run.id}:command:${run.pendingCommandApproval.requestedAt}`, occurredAt: run.pendingCommandApproval.requestedAt,
    nodeId: run.pendingCommandApproval.nodeId, kind: 'operator', label: '命令审批', title: '等待批准执行命令', command: run.pendingCommandApproval.command.command,
    details: { cwd: run.pendingCommandApproval.command.cwd, timeoutMs: run.pendingCommandApproval.command.timeoutMs } })
  if (run.deliveryApproval) add({ id: `${run.id}:delivery:${run.deliveryApproval.requestedAt}`, occurredAt: run.deliveryApproval.requestedAt,
    kind: 'operator', label: '交付审批', title: `等待确认 ${run.deliveryApproval.changedFiles.length} 项变更`, content: run.deliveryApproval.changedFiles.join('\n') })
  return items.sort((a, b) => (Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.order - b.order))
}

// Layers follow dependencies, so forks and joins keep their actual topology.
export function flowLayers(nodes: Array<{ id: string }>, edges: Array<{ from: string; to: string }>): string[][] {
  const pending = new Set(nodes.map(node => node.id))
  const layers: string[][] = []
  while (pending.size) {
    const layer = [...pending].filter(id => !edges.some(edge => edge.to === id && pending.has(edge.from)))
    if (!layer.length) { layers.push([...pending]); break }
    layers.push(layer)
    layer.forEach(id => pending.delete(id))
  }
  return layers
}
