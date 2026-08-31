import { getRun, subscribeRunEvents, type AgentTraceEvent, type RunSnapshot } from '@artifact/core'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type StatePayload = {
  status: RunSnapshot['status']
  startedAt: string
  endedAt?: string
  pendingCommandApproval: RunSnapshot['pendingCommandApproval'] | null
  logs: string[]
  nodes: Array<{
    id: string
    state: RunSnapshot['nodes'][number]['state']
    attempts: Array<{ id: string; status: string; startedAt: string; endedAt?: string; exitReason?: string; output?: string; finalResponse?: string }>
  }>
}

type TracePayload = {
  nodeId: string
  attemptId: string
  events: AgentTraceEvent[]
  traceOmittedCount: number
  full: boolean
}

const terminalStatus = (status: RunSnapshot['status']): boolean => status === 'succeeded' || status === 'failed' || status === 'cancelled'

function statePayload(run: RunSnapshot): StatePayload {
  return {
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    pendingCommandApproval: run.pendingCommandApproval ?? null,
    logs: run.logs ?? [],
    nodes: run.nodes.map(node => ({
      id: node.id,
      state: node.state,
      attempts: (node.attempts ?? []).map(attempt => ({
        id: attempt.id,
        status: attempt.status,
        startedAt: attempt.startedAt,
        ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}),
        ...(attempt.exitReason ? { exitReason: attempt.exitReason } : {}),
        ...(attempt.output ? { output: attempt.output } : {}),
        ...(attempt.finalResponse ? { finalResponse: attempt.finalResponse } : {}),
      })),
    })),
  }
}

function tracePayloads(run: RunSnapshot, lastSeqByAttempt: Map<string, number>, full: boolean): TracePayload[] {
  const payloads: TracePayload[] = []
  for (const node of run.nodes) {
    for (const attempt of node.attempts ?? []) {
      const trace = attempt.trace ?? []
      const lastSeq = lastSeqByAttempt.get(attempt.id) ?? 0
      const events = full ? trace : trace.filter(event => event.seq > lastSeq)
      if (!full && !events.length) continue
      if (events.length) lastSeqByAttempt.set(attempt.id, events[events.length - 1]!.seq)
      payloads.push({ nodeId: node.id, attemptId: attempt.id, events, traceOmittedCount: attempt.traceOmittedCount ?? 0, full })
    }
  }
  return payloads
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const initial = await getRun(id)
  if (!initial) return Response.json({ error: 'Run not found' }, { status: 404 })
  const requestedSinceSeq = Number.parseInt(new URL(request.url).searchParams.get('sinceSeq') ?? '', 10)
  const sinceSeq = Number.isFinite(requestedSinceSeq) && requestedSinceSeq > 0 ? requestedSinceSeq : undefined

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      let pushing = false
      let notifyTimer: NodeJS.Timeout | undefined
      const lastSeqByAttempt = new Map<string, number>()

      const send = (event: string, data: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      const sendBatch = (frames: Array<[string, unknown]>) => {
        if (closed) return
        controller.enqueue(encoder.encode(frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')))
      }
      const cleanup = () => {
        if (closed) return
        closed = true
        if (notifyTimer) clearTimeout(notifyTimer)
        clearInterval(pingTimer)
        unsubscribe()
        try { controller.close() } catch { /* already closed by the client */ }
      }

      const push = async (initialSync = false) => {
        if (closed || pushing) return
        pushing = true
        try {
          const run = await getRun(id)
          if (!run) { send('done', { status: 'missing' }); cleanup(); return }
          const traceFrames = tracePayloads(run, lastSeqByAttempt, initialSync && sinceSeq === undefined)
          const frames: Array<[string, unknown]> = [['state', statePayload(run)], ...traceFrames.map(payload => ['trace', payload] as [string, unknown])]
          if (terminalStatus(run.status)) frames.push(['done', { status: run.status }])
          if (initialSync) sendBatch(frames)
          else frames.forEach(([event, data]) => send(event, data))
          if (terminalStatus(run.status)) cleanup()
        } catch { /* a failed read is retried on the next notification */ }
        finally { pushing = false }
      }

      const unsubscribe = subscribeRunEvents(id, () => {
        if (closed || notifyTimer) return
        // Trace events arrive in bursts; coalesce them into one push per tick.
        notifyTimer = setTimeout(() => { notifyTimer = undefined; void push() }, 80)
      })
      const pingTimer = setInterval(() => {
        if (closed) return
        try { controller.enqueue(encoder.encode(': ping\n\n')) } catch { cleanup() }
      }, 15_000)

      request.signal.addEventListener('abort', cleanup)
      controller.enqueue(encoder.encode('retry: 2000\n\n'))
      if (sinceSeq !== undefined) for (const node of initial.nodes) for (const attempt of node.attempts ?? []) lastSeqByAttempt.set(attempt.id, sinceSeq)
      void push(true)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
