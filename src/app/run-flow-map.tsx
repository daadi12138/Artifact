import { flowLayers } from './run-workspace-model'
import type { RunWorkspaceRun } from './run-workspace'

export function RunFlowMap({ run, selectedId, onSelect }: { run: RunWorkspaceRun; selectedId?: string; onSelect: (id: string) => void }) {
  const layers = flowLayers(run.nodes, run.edges)
  const width = Math.max(240, ...layers.map(layer => layer.length * 144)), height = Math.max(100, layers.length * 86)
  const positions = new Map(layers.flatMap((layer, row) => layer.map((id, column) => [id, { x: (column + .5) * width / layer.length, y: row * 86 + 36 }] as const)))
  const labels: Record<string, string> = { idle: '等待中', running: '执行中', paused: '已暂停', success: '已完成', waiting: '待处理', failed: '失败', cancelled: '已取消', skipped: '已跳过' }
  return <div className="run-dag-scroll"><div className="run-dag" style={{ width, height }}>
    <svg width={width} height={height} aria-hidden="true"><defs><marker id="run-dag-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L8 4 L0 8" fill="currentColor" /></marker></defs>{run.edges.map((edge, index) => {
      const from = positions.get(edge.from), to = positions.get(edge.to)
      return from && to ? <path key={index} d={`M${from.x},${from.y + 25} C${from.x},${from.y + 48} ${to.x},${to.y - 48} ${to.x},${to.y - 25}`} markerEnd="url(#run-dag-arrow)" /> : null
    })}</svg>
    {run.nodes.map(node => {
      const position = positions.get(node.id)!
      return <button key={node.id} className={`run-dag-node ${node.state} ${selectedId === node.id ? 'selected' : ''}`} style={{ left: position.x - 62, top: position.y - 25 }} aria-pressed={selectedId === node.id} title={`${node.id} · ${labels[node.state] ?? node.state}`} onClick={() => onSelect(node.id)}><b>{node.id}</b><small><i />{labels[node.state] ?? node.state}</small></button>
    })}
  </div></div>
}
