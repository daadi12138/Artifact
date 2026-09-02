export type DesktopWindowBounds = { x: number; y: number; width: number; height: number }
export type DesktopWindowState = { version: 1; bounds: DesktopWindowBounds; maximized: boolean; fullScreen: boolean }

export function parseDesktopWindowState(value: unknown): DesktopWindowState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as Partial<DesktopWindowState>
  if (state.version !== 1 || !isBounds(state.bounds) || typeof state.maximized !== 'boolean' || typeof state.fullScreen !== 'boolean') return null
  return { version: 1, bounds: state.bounds, maximized: state.maximized, fullScreen: state.fullScreen }
}

export function fitWindowBounds(bounds: DesktopWindowBounds, workAreas: DesktopWindowBounds[], minWidth: number, minHeight: number): DesktopWindowBounds {
  if (!workAreas.length) return bounds
  const workArea = bestWorkArea(bounds, workAreas)
  const width = Math.min(Math.max(bounds.width, Math.min(minWidth, workArea.width)), workArea.width)
  const height = Math.min(Math.max(bounds.height, Math.min(minHeight, workArea.height)), workArea.height)
  const x = clamp(bounds.x, workArea.x, workArea.x + workArea.width - width)
  const y = clamp(bounds.y, workArea.y, workArea.y + workArea.height - height)
  return { x, y, width, height }
}

function isBounds(value: unknown): value is DesktopWindowBounds {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Partial<DesktopWindowBounds>
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(item => typeof item === 'number' && Number.isFinite(item))
    && bounds.width! > 0
    && bounds.height! > 0
}

function bestWorkArea(bounds: DesktopWindowBounds, workAreas: DesktopWindowBounds[]): DesktopWindowBounds {
  let best = workAreas[0]
  let bestIntersection = -1
  let bestDistance = Number.POSITIVE_INFINITY
  const boundsCenter = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  for (const workArea of workAreas) {
    const intersection = intersectionArea(bounds, workArea)
    const areaCenter = { x: workArea.x + workArea.width / 2, y: workArea.y + workArea.height / 2 }
    const distance = (boundsCenter.x - areaCenter.x) ** 2 + (boundsCenter.y - areaCenter.y) ** 2
    if (intersection > bestIntersection || (intersection === bestIntersection && distance < bestDistance)) {
      best = workArea
      bestIntersection = intersection
      bestDistance = distance
    }
  }
  return best
}

function intersectionArea(left: DesktopWindowBounds, right: DesktopWindowBounds): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x))
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
  return width * height
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)))
}
