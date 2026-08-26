'use client'

import { Check, ChevronRight, CirclePlay, CopyPlus, FileCode2, LayoutTemplate, Pencil, Sparkles, Upload } from 'lucide-react'

export type WorkflowTemplateView = {
  id: 'feature-delivery' | 'code-review-fix' | 'ui-implementation'
  name: string
  description: string
}

export type WorkflowRecordView = {
  id: string
  updatedAt: string
  draft: {
    id: string
    name: string
    description: string
    nodes: unknown[]
    edges: unknown[]
  }
  published: Array<{
    revision: number
    publishedAt: string
    definition: {
      id: string
      name: string
      nodes: Array<{ id: string; kind: string; executorId?: string; prompt?: string; output: string }>
      edges: Array<{ from: string; to: string }>
    }
  }>
}

export function WorkflowLibraryView({
  workflows,
  templates,
  busyId,
  onCreate,
  onEdit,
  onPublish,
  onLaunch,
}: {
  workflows: WorkflowRecordView[]
  templates: WorkflowTemplateView[]
  busyId: string | null
  onCreate: (template: WorkflowTemplateView) => void
  onEdit: (workflow: WorkflowRecordView) => void
  onPublish: (workflow: WorkflowRecordView) => void
  onLaunch: () => void
}) {
  return <section className="content-view workflow-library-view">
    <header className="library-heading">
      <div>
        <span className="section-kicker">WORKFLOW LIBRARY</span>
        <h1>工作流</h1>
        <p>编辑草稿，发布不可变版本；只有发布版本可以进入运行队列。</p>
      </div>
      <button className="run-btn" onClick={onLaunch}><CirclePlay aria-hidden="true" />运行已发布工作流</button>
    </header>

    <section className="workflow-library-section" aria-labelledby="saved-workflows">
      <div className="library-section-heading"><div><span className="section-kicker">SAVED FLOWS</span><h2 id="saved-workflows">我的工作流</h2></div><span>{workflows.length} 个草稿</span></div>
      <div className="workflow-record-list">
        {workflows.map(workflow => {
          const latest = workflow.published.at(-1)
          const isPublishing = busyId === `publish:${workflow.id}`
          return <article className="workflow-record" key={workflow.id}>
            <span className="workflow-record-icon"><FileCode2 aria-hidden="true" /></span>
            <div className="workflow-record-copy"><div><h3>{workflow.draft.name}</h3>{latest ? <span className="published-marker"><Check aria-hidden="true" />已发布 v{latest.revision}</span> : <span className="draft-marker">未发布</span>}</div><p>{workflow.draft.description || '尚未添加工作流说明。'}</p><small>{workflow.draft.nodes.length} 个节点 · {workflow.draft.edges.length} 条连接 · 修改于 {new Date(workflow.updatedAt).toLocaleString('zh-CN')}</small></div>
            <div className="workflow-record-actions">
              <button className="ghost-btn" onClick={() => onEdit(workflow)}><Pencil aria-hidden="true" />编辑草稿</button>
              <button className="run-btn" disabled={Boolean(busyId)} onClick={() => onPublish(workflow)}>{isPublishing ? '发布中…' : <><Upload aria-hidden="true" />{latest ? '发布新版本' : '发布'}</>}</button>
            </div>
          </article>
        })}
      </div>
    </section>

    <section className="workflow-library-section" aria-labelledby="workflow-templates">
      <div className="library-section-heading"><div><span className="section-kicker">STARTER TEMPLATES</span><h2 id="workflow-templates">从模板创建</h2></div><span>可在创建后自由编辑</span></div>
      <div className="workflow-template-grid">
        {templates.map(template => <article className="workflow-template" key={template.id}>
          <span className="workflow-template-icon"><LayoutTemplate aria-hidden="true" /></span>
          <h3>{template.name}</h3>
          <p>{template.description}</p>
          <button className="text-action" disabled={Boolean(busyId)} onClick={() => onCreate(template)}>{busyId === `create:${template.id}` ? '创建中…' : <><CopyPlus aria-hidden="true" />使用模板</>}<ChevronRight aria-hidden="true" /></button>
        </article>)}
      </div>
      <div className="workflow-library-note"><Sparkles aria-hidden="true" /><span>每个模板均可接收文字需求、本地文件和经过确认导入的网页媒体资源。</span></div>
    </section>
  </section>
}
