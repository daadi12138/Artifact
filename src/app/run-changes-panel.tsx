'use client'

import { useEffect, useState } from 'react'
import { Check, FileCode2, LoaderCircle, RefreshCcw } from 'lucide-react'
import type { ReviewFile, ReviewFileDetail } from '../run-review'
import { readPreference, writePreference } from './preferences'

export function RunChangesPanel({ runId, review }: { runId: string; review: boolean }) {
  const [files, setFiles] = useState<ReviewFile[]>([])
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<ReviewFileDetail | null>(null)
  const [error, setError] = useState('')
  const [fileError, setFileError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [reviewed, setReviewed] = useState<Record<string, string>>({})
  const storageKey = `artifact.run-review.${runId}`
  useEffect(() => {
    setReviewed({})
    try {
      const value: unknown = JSON.parse(readPreference(storageKey) ?? '{}')
      if (value && typeof value === 'object' && !Array.isArray(value)) setReviewed(Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')))
    } catch { setReviewed({}) }
  }, [storageKey])
  useEffect(() => {
    setLoading(true)
    const controller = new AbortController()
    let inFlight = false
    const load = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const response = await fetch(`/api/runs/${runId}/review`, { signal: controller.signal, cache: 'no-store' })
        const value = await response.json()
        if (!response.ok) throw new Error(value.error ?? '无法读取文件变更')
        if (controller.signal.aborted) return
        setFiles(value.files); setTruncated(Boolean(value.truncated)); setError('')
        setSelected(current => value.files.some((file: ReviewFile) => file.path === current) ? current : value.files[0]?.path ?? '')
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : '无法读取文件变更')
      } finally { inFlight = false; if (!controller.signal.aborted) setLoading(false) }
    }
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [runId, refresh])
  const fingerprint = files.find(file => file.path === selected)?.fingerprint
  useEffect(() => {
    setDetail(null); setFileError('')
    if (!selected || error) return
    const controller = new AbortController()
    void fetch(`/api/runs/${runId}/review?path=${encodeURIComponent(selected)}`, { signal: controller.signal, cache: 'no-store' }).then(async response => {
      const value = await response.json()
      if (!response.ok) throw new Error(value.error ?? '无法读取 Diff')
      if (!controller.signal.aborted) setDetail(value)
    }).catch(caught => { if (!controller.signal.aborted) setFileError(caught instanceof Error ? caught.message : '无法读取 Diff') })
    return () => controller.abort()
  }, [runId, selected, fingerprint, refresh, error])
  const reviewedCount = files.filter(file => file.fingerprint && reviewed[file.path] === file.fingerprint).length
  const isReviewed = Boolean(detail && reviewed[detail.path] === detail.fingerprint)
  const toggleReviewed = () => {
    if (!detail || !fingerprint || detail.fingerprint !== fingerprint) return
    const next = { ...reviewed }
    if (isReviewed) delete next[detail.path]
    else next[detail.path] = detail.fingerprint
    setReviewed(next); writePreference(storageKey, JSON.stringify(next))
  }
  return <section className="run-changes-panel" aria-label={review ? '文件审查' : '代码变更'}>
    <header className="run-changes-heading"><span><FileCode2 aria-hidden="true" />{files.length} 个变更文件{review && ` · ${reviewedCount} 已审查`}{truncated && '（仅列出前 1000 项）'}</span><div>{review && <small>文件变化后，审查标记自动失效；交付仍需审批</small>}<button className="run-copy-button" aria-label="刷新变更" title="刷新变更" onClick={() => setRefresh(value => value + 1)}><RefreshCcw aria-hidden="true" /></button></div></header>
    {loading ? <p className="console-empty"><LoaderCircle className="spin" aria-hidden="true" />读取 Worktree 变更…</p> : error ? <p className="console-empty" role="alert">{error}</p> : !files.length ? <p className="console-empty">该 Worktree 相对运行基线暂无变更。</p> : <div className="run-changes-body">
      <nav className="run-changes-files" aria-label="变更文件">{files.map(file => <button key={file.path} title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path} aria-current={selected === file.path ? 'true' : undefined} onClick={() => setSelected(file.path)}><em>{file.status === '?' ? 'A' : file.status}</em><span>{file.path}</span>{review && file.fingerprint && reviewed[file.path] === file.fingerprint && <Check aria-label="已审查" />}</button>)}</nav>
      <div className="run-changes-preview"><header><code>{selected}</code>{review && <button className={`ghost-btn ${isReviewed ? 'active' : ''}`} disabled={!detail || !fingerprint || detail.fingerprint !== fingerprint} aria-pressed={isReviewed} onClick={toggleReviewed}><Check aria-hidden="true" />{isReviewed ? '已审查' : '标记已审查'}</button>}</header>
        {fileError ? <p className="console-empty" role="alert">{fileError}</p> : !detail ? <p className="console-empty">读取文件 Diff…</p> : <pre className="run-diff-lines" aria-label={`${selected} 的 Diff`}>{detail.diff.split('\n').map((line, index) => <span key={index} className={line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : ''}>{line || ' '}{'\n'}</span>)}</pre>}
      </div>
    </div>}
  </section>
}
