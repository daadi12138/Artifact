// In-process change bus for runs. The run pipeline and the API routes live in the same
// Node process (Next standalone server), so a module-level registry is enough — the
// SSE route subscribes here instead of polling the manifest on a timer.
export type RunChangedListener = () => void

const listeners = new Map<string, Set<RunChangedListener>>()

export function subscribeRunEvents(runId: string, listener: RunChangedListener): () => void {
  let set = listeners.get(runId)
  if (!set) {
    set = new Set()
    listeners.set(runId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(runId)
  }
}

export function notifyRunChanged(runId: string): void {
  for (const listener of listeners.get(runId) ?? []) {
    try { listener() } catch { /* a broken subscriber must never break the run pipeline */ }
  }
}
