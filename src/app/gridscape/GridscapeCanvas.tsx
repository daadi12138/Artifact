'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import { ChevronLeft, ChevronRight, LoaderCircle, Play, RotateCcw, Search, Sparkles, X, ZoomIn, ZoomOut } from 'lucide-react'

const NODE_WIDTH = 420
const NODE_HEIGHT_ESTIMATE = 680
const MIN_SCALE = 0.2
const MAX_SCALE = 3

type NodeStatus = 'generating' | 'ready' | 'error'
type ImageStatus = 'loading' | 'ready' | 'error'

type NodeVersion = {
  prompt: string
  text: string
  prompts: string[]
  imageUrl?: string
  imageStatus: ImageStatus
  imageError?: string
}

type GridNodeData = {
  id: string
  x: number
  y: number
  width: number
  prompt: string
  status: NodeStatus
  error?: string
  versionIndex: number
  versions: NodeVersion[]
  parentId?: string
}

type CanvasTransform = { x: number; y: number; scale: number }
type ArtifactExportState = { status: 'idle' | 'saving' | 'saved' | 'error'; message?: string }

function extractText(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(extractText).join('')
  if (value && typeof value === 'object' && 'props' in value) {
    const props = (value as { props?: { children?: ReactNode } }).props
    return extractText(props?.children)
  }
  return ''
}

function Typewriter({ text, onExpand, nodeId }: {
  text: string
  onExpand: (prompt: string, parentId: string) => void
  nodeId: string
}) {
  const [displayedLength, setDisplayedLength] = useState(0)
  const processedText = useMemo(() => (
    (text || '').replace(/\[([^\]]+)\]\s*\(([^)]+)\)/g, (_match, label: string, href: string) => (
      `[${label}](${String(href).replace(/\s/g, '%20')})`
    ))
  ), [text])

  useEffect(() => {
    setDisplayedLength(0)
    let index = 0
    const charsPerTick = Math.max(1, Math.floor(processedText.length / 100))
    const timer = window.setInterval(() => {
      if (index >= processedText.length) {
        window.clearInterval(timer)
        return
      }
      index = Math.min(processedText.length, index + charsPerTick)
      setDisplayedLength(index)
    }, 20)
    return () => window.clearInterval(timer)
  }, [processedText])

  return (
    <div className="gs-markdown">
      <ReactMarkdown
        components={{
          a: ({ children, href }) => (
            <button
              type="button"
              className="gs-concept-link"
              onClick={event => {
                event.stopPropagation()
                const childText = extractText(children).trim()
                const decodedHref = href ? decodeURIComponent(href) : ''
                const prompt = childText || decodedHref.replace(/^#/, '')
                if (prompt) onExpand(prompt, nodeId)
              }}
            >
              {children}
            </button>
          ),
        }}
      >
        {processedText.slice(0, displayedLength)}
      </ReactMarkdown>
    </div>
  )
}

function FunLoader() {
  const messages = ['Mapping the concept...', 'Looking for connections...', 'Gathering the cool bits...', 'Brewing ideas...', 'Almost there...']
  const [index, setIndex] = useState(0)

  useEffect(() => {
    const timer = window.setInterval(() => setIndex(value => (value + 1) % messages.length), 2000)
    return () => window.clearInterval(timer)
  }, [messages.length])

  return (
    <div className="gs-card-loader">
      <div className="gs-loader-message" key={index}>{messages[index]}</div>
      <LoaderCircle size={30} aria-hidden />
      <div className="gs-loader-frame" />
    </div>
  )
}

function NodeCard({ index, node, onExpand, onRegenerate, onClose, setVersion, onNodePointerDown }: {
  index: number
  node: GridNodeData
  onExpand: (prompt: string, parentId: string) => void
  onRegenerate: (nodeId: string) => void
  onClose: (nodeId: string) => void
  setVersion: (nodeId: string, versionIndex: number) => void
  onNodePointerDown: (event: React.PointerEvent<HTMLDivElement>, nodeId: string) => void
}) {
  const version = node.versions[node.versionIndex]
  const isGenerating = node.status === 'generating'

  return (
    <article
      className="gs-node"
      style={{ left: node.x, top: node.y, width: node.width }}
      aria-label={`Concept node: ${node.prompt}`}
    >
      <div className="gs-node-toolbar">
        <span className="gs-node-index">{index + 1}.{node.versionIndex + 1}</span>
        <div className="gs-node-actions">
          <button type="button" onClick={() => setVersion(node.id, node.versionIndex - 1)} disabled={node.versionIndex <= 0} title="Previous version" aria-label="Previous version">
            <ChevronLeft size={13} />
          </button>
          <button type="button" onClick={() => setVersion(node.id, node.versionIndex + 1)} disabled={node.versionIndex >= node.versions.length - 1} title="Next version" aria-label="Next version">
            <ChevronRight size={13} />
          </button>
          <button type="button" onClick={() => onRegenerate(node.id)} disabled={isGenerating} title="Regenerate" aria-label="Regenerate">
            <RotateCcw size={13} />
          </button>
          <button type="button" className="gs-danger" onClick={() => onClose(node.id)} title="Delete node and descendants" aria-label="Delete node and descendants">
            <X size={13} />
          </button>
        </div>
      </div>

      <div className="gs-card" onPointerDown={event => onNodePointerDown(event, node.id)}>
        {node.versions.length > 1 && <span className="gs-stack gs-stack-one" aria-hidden />}
        {node.versions.length > 1 && <span className="gs-stack gs-stack-two" aria-hidden />}

        {node.status === 'error' ? (
          <div className="gs-card-error">
            <X size={42} />
            <strong>SYSTEM_FAULT</strong>
            <p>{node.error || 'Unable to process this prompt. Please regenerate.'}</p>
          </div>
        ) : isGenerating || !version ? (
          <FunLoader />
        ) : (
          <>
            <div className={`gs-visual ${version.imageStatus === 'ready' ? 'gs-visual-ready' : ''}`}>
              {version.imageUrl ? (
                <img src={version.imageUrl} alt={`Editorial visualization for ${node.prompt}`} />
              ) : version.imageStatus === 'loading' ? (
                <div className="gs-image-loading">
                  <LoaderCircle size={20} aria-hidden />
                  <span>Generating visual data...</span>
                </div>
              ) : (
                <div className="gs-image-error">
                  <span>No visual data</span>
                  <small>{version.imageError || 'Image generation failed.'}</small>
                </div>
              )}
            </div>

            <div className="gs-content" onPointerDown={event => event.stopPropagation()}>
              <h3>{node.prompt}</h3>
              <Typewriter text={version.text} onExpand={onExpand} nodeId={node.id} />
            </div>
          </>
        )}
      </div>

      {!isGenerating && version?.prompts.length ? (
        <div className="gs-suggestions">
          {version.prompts.map((prompt, promptIndex) => (
            <div className="gs-suggestion-wrapper" key={`${node.id}-${promptIndex}`}>
              <span className="gs-suggestion-line" aria-hidden />
              <button type="button" onClick={event => {
                event.stopPropagation()
                onExpand(prompt, node.id)
              }}>
                {prompt}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </article>
  )
}

function ConnectingLines({ nodes }: { nodes: GridNodeData[] }) {
  return (
    <svg className="gs-lines" aria-hidden>
      {nodes.map(node => {
        if (!node.parentId) return null
        const parent = nodes.find(candidate => candidate.id === node.parentId)
        if (!parent) return null

        const startX = parent.x + parent.width
        const startY = parent.y + 220
        const endX = node.x
        const endY = node.y + 220
        const controlX = startX + (endX - startX) / 2

        return (
          <path
            key={`line-${node.id}`}
            d={`M ${startX} ${startY} C ${controlX} ${startY}, ${controlX} ${endY}, ${endX} ${endY}`}
          />
        )
      })}
    </svg>
  )
}

function Minimap({ nodes, transform, onCenterViewport }: {
  nodes: GridNodeData[]
  transform: CanvasTransform
  onCenterViewport: (x: number, y: number) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewportSize, setViewportSize] = useState({ width: 1200, height: 800 })

  useEffect(() => {
    const update = () => setViewportSize({ width: window.innerWidth, height: window.innerHeight })
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  const bounds = useMemo(() => {
    if (!nodes.length) return { minX: 0, minY: 0, width: 1000, height: 800 }
    const minX = Math.min(...nodes.map(node => node.x))
    const minY = Math.min(...nodes.map(node => node.y))
    const maxX = Math.max(...nodes.map(node => node.x + node.width))
    const maxY = Math.max(...nodes.map(node => node.y + NODE_HEIGHT_ESTIMATE))
    return { minX, minY, width: Math.max(maxX - minX, 1000), height: Math.max(maxY - minY, 800) }
  }, [nodes])

  const mapWidth = 200
  const mapHeight = 150
  const mapScale = Math.min(mapWidth / bounds.width, mapHeight / bounds.height)
  const renderWidth = bounds.width * mapScale
  const renderHeight = bounds.height * mapScale
  const offsetX = (mapWidth - renderWidth) / 2
  const offsetY = (mapHeight - renderHeight) / 2

  const updateFromPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const x = event.clientX - rect.left - offsetX
    const y = event.clientY - rect.top - offsetY
    onCenterViewport(x / mapScale + bounds.minX, y / mapScale + bounds.minY)
  }, [bounds.minX, bounds.minY, mapScale, offsetX, offsetY, onCenterViewport])

  const viewportX = (-transform.x / transform.scale - bounds.minX) * mapScale
  const viewportY = (-transform.y / transform.scale - bounds.minY) * mapScale
  const viewportWidth = viewportSize.width / transform.scale * mapScale
  const viewportHeight = viewportSize.height / transform.scale * mapScale

  return (
    <div
      ref={containerRef}
      className="gs-minimap"
      onPointerDown={event => {
        event.currentTarget.setPointerCapture(event.pointerId)
        updateFromPointer(event)
      }}
      onPointerMove={event => {
        if (event.buttons === 1) updateFromPointer(event)
      }}
      onPointerUp={event => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      }}
    >
      <div style={{ width: renderWidth, height: renderHeight, marginLeft: offsetX, marginTop: offsetY }}>
        <svg className="gs-minimap-lines" aria-hidden>
          {nodes.map(node => {
            if (!node.parentId) return null
            const parent = nodes.find(candidate => candidate.id === node.parentId)
            if (!parent) return null
            return <line
              key={`minimap-line-${node.id}`}
              x1={(parent.x + parent.width - bounds.minX) * mapScale}
              y1={(parent.y + 220 - bounds.minY) * mapScale}
              x2={(node.x - bounds.minX) * mapScale}
              y2={(node.y + 220 - bounds.minY) * mapScale}
            />
          })}
        </svg>
        {nodes.map(node => (
          <span
            key={`minimap-node-${node.id}`}
            style={{
              left: (node.x - bounds.minX) * mapScale,
              top: (node.y - bounds.minY) * mapScale,
              width: Math.max(node.width * mapScale, 4),
              height: Math.max(NODE_HEIGHT_ESTIMATE * mapScale, 4),
            }}
          />
        ))}
        <span
          className="gs-minimap-viewport"
          style={{
            left: viewportX,
            top: viewportY,
            width: viewportWidth,
            height: viewportHeight,
          }}
        />
      </div>
    </div>
  )
}

export function GridscapeCanvas() {
  const [nodes, setNodes] = useState<GridNodeData[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [transform, setTransform] = useState<CanvasTransform>({ x: 0, y: 0, scale: 0.85 })
  const [isPanning, setIsPanning] = useState(false)
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [artifactExport, setArtifactExport] = useState<ArtifactExportState>({ status: 'idle' })
  const nodesRef = useRef<GridNodeData[]>([])
  const canvasRef = useRef<HTMLDivElement>(null)
  const panStartRef = useRef({ pointerX: 0, pointerY: 0, x: 0, y: 0 })
  const nodeDragStartRef = useRef({ pointerX: 0, pointerY: 0, x: 0, y: 0 })

  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])

  const centerOnPosition = useCallback((x: number, y: number) => {
    setTransform(previous => ({
      ...previous,
      x: window.innerWidth / 2 - x * previous.scale - (NODE_WIDTH / 2) * previous.scale,
      y: window.innerHeight / 2 - y * previous.scale - 220 * previous.scale,
    }))
  }, [])

  const handleZoom = useCallback((delta: number, originX?: number, originY?: number) => {
    setTransform(previous => {
      const nextScale = Math.min(Math.max(previous.scale + delta, MIN_SCALE), MAX_SCALE)
      const origin = {
        x: originX ?? window.innerWidth / 2,
        y: originY ?? window.innerHeight / 2,
      }
      const scaleRatio = nextScale / previous.scale
      return {
        x: origin.x - (origin.x - previous.x) * scaleRatio,
        y: origin.y - (origin.y - previous.y) * scaleRatio,
        scale: nextScale,
      }
    })
  }, [])

  const updateVersion = useCallback((nodeId: string, versionIndex: number, update: (version: NodeVersion) => NodeVersion) => {
    setNodes(previous => previous.map(node => {
      if (node.id !== nodeId) return node
      const versions = [...node.versions]
      if (!versions[versionIndex]) return node
      versions[versionIndex] = update(versions[versionIndex])
      return { ...node, versions }
    }))
  }, [])

  const generateNode = useCallback(async (prompt: string, x: number, y: number, parentId?: string, regenerateId?: string) => {
    const id = regenerateId ?? `node-${Date.now()}-${Math.floor(Math.random() * 1000)}`
    const existing = regenerateId ? nodesRef.current.find(node => node.id === regenerateId) : undefined
    const insertIndex = existing ? existing.versions.length : 0

    if (existing) {
      setNodes(previous => previous.map(node => node.id === id ? { ...node, status: 'generating', error: undefined } : node))
    } else {
      setNodes(previous => [...previous, {
        id,
        x,
        y,
        width: NODE_WIDTH,
        prompt,
        status: 'generating',
        versionIndex: 0,
        versions: [],
        parentId,
      }])
    }

    window.setTimeout(() => centerOnPosition(x, y), 50)

    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      const data = await response.json() as { text?: string; prompts?: string[]; error?: string }
      if (!response.ok || !data.text) throw new Error(data.error || 'Text generation failed.')

      const newVersion: NodeVersion = {
        prompt,
        text: data.text,
        prompts: data.prompts ?? [],
        imageStatus: 'loading',
      }

      setNodes(previous => previous.map(node => {
        if (node.id !== id) return node
        const versions = regenerateId ? [...node.versions, newVersion] : [newVersion]
        return {
          ...node,
          status: 'ready',
          error: undefined,
          versions,
          versionIndex: versions.length - 1,
        }
      }))

      void fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      }).then(async imageResponse => {
        const imageData = await imageResponse.json() as { imageUrl?: string; error?: string }
        if (!imageResponse.ok || !imageData.imageUrl) throw new Error(imageData.error || 'Image generation failed.')
        updateVersion(id, insertIndex, version => ({ ...version, imageUrl: imageData.imageUrl, imageStatus: 'ready', imageError: undefined }))
      }).catch(error => {
        updateVersion(id, insertIndex, version => ({
          ...version,
          imageStatus: 'error',
          imageError: error instanceof Error ? error.message : 'Image generation failed.',
        }))
      })
    } catch (error) {
      setNodes(previous => previous.map(node => node.id === id ? {
        ...node,
        status: 'error',
        error: error instanceof Error ? error.message : 'Text generation failed.',
      } : node))
    }
  }, [centerOnPosition, updateVersion])

  const handleSearchSubmit = useCallback((event?: React.FormEvent | React.MouseEvent) => {
    event?.preventDefault()
    const prompt = searchQuery.trim()
    if (!prompt) return
    setSearchQuery('')
    void generateNode(prompt, 0, 0)
  }, [generateNode, searchQuery])

  const handleMagicWand = useCallback(() => {
    const ideas = [
      'Evolution of Video Games',
      'Quantum Entanglement',
      'Rise of the Roman Empire',
      'History of Artificial Intelligence',
      'Deep Sea Ecosystems',
    ]
    void generateNode(ideas[Math.floor(Math.random() * ideas.length)], 0, 0)
  }, [generateNode])

  const handleExpand = useCallback((prompt: string, parentId: string) => {
    const parent = nodesRef.current.find(node => node.id === parentId)
    if (!parent) return

    const newX = parent.x + parent.width + 420
    const initialOffset = Math.random() > 0.5 ? 220 : -220
    let newY = parent.y + initialOffset
    let isOccupied = true
    let multiplier = 1
    let direction = Math.random() > 0.5 ? 1 : -1

    while (isOccupied) {
      isOccupied = nodesRef.current.some(node =>
        Math.abs(node.x - newX) < 220 &&
        Math.abs(node.y - newY) < NODE_HEIGHT_ESTIMATE
      )
      if (!isOccupied) break
      newY = parent.y + initialOffset + NODE_HEIGHT_ESTIMATE * multiplier * direction
      direction *= -1
      if (direction === 1) multiplier += 1
    }

    void generateNode(prompt, newX, newY, parentId)
  }, [generateNode])

  const handleRegenerate = useCallback((nodeId: string) => {
    const node = nodesRef.current.find(candidate => candidate.id === nodeId)
    if (node) void generateNode(node.prompt, node.x, node.y, node.parentId, nodeId)
  }, [generateNode])

  const handleDelete = useCallback((nodeId: string) => {
    const descendants = (id: string): string[] => {
      const children = nodesRef.current.filter(node => node.parentId === id).map(node => node.id)
      return children.flatMap(child => [child, ...descendants(child)])
    }
    const deleteIds = new Set([nodeId, ...descendants(nodeId)])
    setNodes(previous => previous.filter(node => !deleteIds.has(node.id)))
  }, [])

  const setVersion = useCallback((nodeId: string, versionIndex: number) => {
    setNodes(previous => previous.map(node => node.id === nodeId
      ? { ...node, versionIndex: Math.min(Math.max(versionIndex, 0), node.versions.length - 1) }
      : node))
  }, [])

  const handleCanvasPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (!target.dataset.canvasBackground) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsPanning(true)
    panStartRef.current = { pointerX: event.clientX, pointerY: event.clientY, x: transform.x, y: transform.y }
  }

  const handleNodePointerDown = (event: React.PointerEvent<HTMLDivElement>, nodeId: string) => {
    event.stopPropagation()
    const node = nodesRef.current.find(candidate => candidate.id === nodeId)
    if (!node) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraggingNodeId(nodeId)
    nodeDragStartRef.current = { pointerX: event.clientX, pointerY: event.clientY, x: node.x, y: node.y }
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isPanning) {
      setTransform(previous => ({
        ...previous,
        x: panStartRef.current.x + event.clientX - panStartRef.current.pointerX,
        y: panStartRef.current.y + event.clientY - panStartRef.current.pointerY,
      }))
      return
    }

    if (!draggingNodeId) return
    const dx = (event.clientX - nodeDragStartRef.current.pointerX) / transform.scale
    const dy = (event.clientY - nodeDragStartRef.current.pointerY) / transform.scale
    const startX = nodeDragStartRef.current.x
    const startY = nodeDragStartRef.current.y
    setNodes(previous => previous.map(node => node.id === draggingNodeId
      ? { ...node, x: startX + dx, y: startY + dy }
      : node))
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    setIsPanning(false)
    setDraggingNodeId(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault()
      handleZoom(-event.deltaY * 0.002, event.clientX, event.clientY)
      return
    }
    setTransform(previous => ({ ...previous, x: previous.x - event.deltaX, y: previous.y - event.deltaY }))
  }

  const handleCenterViewport = useCallback((x: number, y: number) => {
    setTransform(previous => ({
      ...previous,
      x: window.innerWidth / 2 - x * previous.scale,
      y: window.innerHeight / 2 - y * previous.scale,
    }))
  }, [])

  const exportToArtifact = useCallback(async () => {
    const readyNodes = nodesRef.current.filter(node => node.versions[node.versionIndex])
    if (!readyNodes.length) return

    setArtifactExport({ status: 'saving', message: '正在创建 Artifact 工作流…' })
    try {
      const root = readyNodes.find(node => !node.parentId) ?? readyNodes[0]
      const workflowName = `GRIDSCAPE · ${root.prompt}`.slice(0, 180)
      const createResponse = await fetch('/api/workflow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          templateId: 'feature-delivery',
          name: workflowName,
          description: `由 GRIDSCAPE 概念画布生成，包含 ${readyNodes.length} 个概念节点。`,
        }),
      })
      const created = await createResponse.json() as { id?: string; error?: string }
      if (!createResponse.ok || !created.id) throw new Error(created.error || '创建工作流失败。')

      const outputById = new Map(readyNodes.map((node, index) => [node.id, `concept-${index + 1}`]))
      const workflowNodes = readyNodes.map((node, index) => {
        const version = node.versions[node.versionIndex]
        const prompt = [
          `主题：${node.prompt}`,
          '',
          version.text,
          '',
          '后续探索方向：',
          ...version.prompts.map((item, itemIndex) => `${itemIndex + 1}. ${item}`),
        ].join('\n').slice(0, 15_000)

        return {
          id: node.id,
          title: node.prompt.slice(0, 140),
          subtitle: node.parentId ? 'GRIDSCAPE 子概念' : 'GRIDSCAPE 根概念',
          kind: '概念',
          tone: 'black',
          x: Math.round(node.x),
          y: Math.round(node.y),
          input: node.parentId ? outputById.get(node.parentId) : undefined,
          output: outputById.get(node.id) ?? `concept-${index + 1}`,
          prompt,
        }
      })
      const workflowEdges = readyNodes
        .filter(node => node.parentId && outputById.has(node.parentId))
        .map(node => ({ from: node.parentId!, to: node.id }))

      const saveResponse = await fetch('/api/workflow', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: created.id, nodes: workflowNodes, edges: workflowEdges }),
      })
      const saved = await saveResponse.json() as { id?: string; error?: string }
      if (!saveResponse.ok || !saved.id) throw new Error(saved.error || '保存概念工作流失败。')

      setArtifactExport({
        status: 'saved',
        message: `已创建 ${readyNodes.length} 个概念节点的工作流。`,
      })
    } catch (error) {
      setArtifactExport({
        status: 'error',
        message: error instanceof Error ? error.message : '发送到 Artifact 失败。',
      })
    }
  }, [])

  const totalCharacters = nodes.reduce((total, node) => total + (node.versions[node.versionIndex]?.text.length ?? 0), 0)

  return (
    <main
      ref={canvasRef}
      className="gridscape"
      data-canvas-background="true"
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onWheel={handleWheel}
    >
      <div
        className="gs-surface"
        data-canvas-background="true"
        style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
      >
        <ConnectingLines nodes={nodes} />
        {nodes.map((node, index) => (
          <NodeCard
            key={node.id}
            index={index}
            node={node}
            onExpand={handleExpand}
            onRegenerate={handleRegenerate}
            onClose={handleDelete}
            setVersion={setVersion}
            onNodePointerDown={handleNodePointerDown}
          />
        ))}
      </div>

      {nodes.length === 0 ? (
        <section className="gs-intro">
          <Link className="gs-back-link" href="/">返回 Artifact 控制台</Link>
          <h1>GRIDSCAPE</h1>
          <form className="gs-search" onSubmit={handleSearchSubmit}>
            <div className="gs-search-input">
              <Search size={20} aria-hidden />
              <input
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder="What do you want to explore?"
                autoFocus
                aria-label="Concept to explore"
              />
            </div>
            <button type="submit" className="gs-search-submit" title="Explore" aria-label="Explore">
              <Play size={18} fill="currentColor" aria-hidden />
            </button>
            <button type="button" className="gs-magic" onClick={handleMagicWand} title="Surprise me" aria-label="Surprise me">
              <Sparkles size={18} aria-hidden />
            </button>
          </form>
          <p>
            An infinite spatial-knowledge-engine for mapping complex ideas. Start with any topic and generate non-linear research nodes.
          </p>
        </section>
      ) : (
        <>
          <button type="button" className="gs-reset" onClick={() => {
            setNodes([])
            setTransform({ x: 0, y: 0, scale: 0.85 })
          }}>
            [ RESET CANVAS ]
          </button>

          <div className="gs-status">CAPACITY: {nodes.length} NODES</div>

          <div className="gs-artifact-bridge">
            <button
              type="button"
              onClick={() => void exportToArtifact()}
              disabled={artifactExport.status === 'saving' || !nodes.some(node => node.versions.length)}
            >
              {artifactExport.status === 'saving' ? '发送中…' : '发送到 Artifact'}
            </button>
            {artifactExport.status !== 'idle' && artifactExport.message && (
              <span className={`gs-bridge-message ${artifactExport.status}`}>{artifactExport.message}</span>
            )}
            {artifactExport.status === 'saved' && <Link href="/">打开工作流</Link>}
          </div>

          <div className="gs-tools">
            <div className="gs-minimap-wrap">
              <Minimap nodes={nodes} transform={transform} onCenterViewport={handleCenterViewport} />
            </div>
            <div className="gs-zoom-bar">
              <span>{totalCharacters.toLocaleString()} CHARS</span>
              <button type="button" onClick={() => handleZoom(-0.2)} aria-label="Zoom out"><ZoomOut size={16} /></button>
              <button type="button" onClick={() => handleZoom(0.2)} aria-label="Zoom in"><ZoomIn size={16} /></button>
            </div>
          </div>
        </>
      )}
    </main>
  )
}
