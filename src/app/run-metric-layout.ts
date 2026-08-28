export type RunMetricColumnValues = [number, number, number, number, number]

export const defaultRunMetricColumnWeights: RunMetricColumnValues = [0.75, 1.45, 0.75, 1.2, 0.6]
export const minimumRunMetricColumnWidths: RunMetricColumnValues = [120, 200, 120, 160, 96]

const runMetricColumnCount = defaultRunMetricColumnWeights.length
const runMetricWeightTotal = defaultRunMetricColumnWeights.reduce((sum, value) => sum + value, 0)

function isColumnValues(value: unknown): value is RunMetricColumnValues {
  return Array.isArray(value)
    && value.length === runMetricColumnCount
    && value.every(item => typeof item === 'number' && Number.isFinite(item) && item > 0)
}

export function normalizeRunMetricColumnWeights(values: readonly number[]): RunMetricColumnValues {
  const candidate = isColumnValues(values) ? values : defaultRunMetricColumnWeights
  const candidateTotal = candidate.reduce((sum, value) => sum + value, 0)
  const source = Number.isFinite(candidateTotal) && candidateTotal > 0 ? candidate : defaultRunMetricColumnWeights
  const total = source === candidate ? candidateTotal : runMetricWeightTotal
  const normalized = source.map(value => value / total * runMetricWeightTotal)
  return normalized.every(value => Number.isFinite(value) && value > 0) ? normalized as RunMetricColumnValues : [...defaultRunMetricColumnWeights]
}

export function parseRunMetricColumnWeights(serialized: string | null): RunMetricColumnValues {
  if (!serialized) return [...defaultRunMetricColumnWeights]
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [...defaultRunMetricColumnWeights]
    const record = parsed as { version?: unknown; weights?: unknown }
    if (record.version !== 1 || !isColumnValues(record.weights) || !Number.isFinite(record.weights.reduce((sum, value) => sum + value, 0))) return [...defaultRunMetricColumnWeights]
    return normalizeRunMetricColumnWeights(record.weights)
  } catch {
    return [...defaultRunMetricColumnWeights]
  }
}

export function serializeRunMetricColumnWeights(weights: readonly number[]) {
  const normalized = normalizeRunMetricColumnWeights(weights)
  return JSON.stringify({ version: 1, weights: normalized.map(value => Number(value.toFixed(8))) })
}

export function resizeRunMetricColumnPair(
  columnWidths: readonly number[],
  dividerIndex: number,
  delta: number,
): RunMetricColumnValues {
  if (!isColumnValues(columnWidths) || !Number.isInteger(dividerIndex) || dividerIndex < 0 || dividerIndex >= runMetricColumnCount - 1 || !Number.isFinite(delta)) {
    return isColumnValues(columnWidths) ? [...columnWidths] : [...minimumRunMetricColumnWidths]
  }

  const leftMinimum = minimumRunMetricColumnWidths[dividerIndex]
  const rightMinimum = minimumRunMetricColumnWidths[dividerIndex + 1]
  const pairTotal = columnWidths[dividerIndex] + columnWidths[dividerIndex + 1]
  if (pairTotal < leftMinimum + rightMinimum) return [...columnWidths]

  const nextLeft = Math.max(leftMinimum, Math.min(pairTotal - rightMinimum, columnWidths[dividerIndex] + delta))
  const nextWidths = [...columnWidths] as RunMetricColumnValues
  nextWidths[dividerIndex] = nextLeft
  nextWidths[dividerIndex + 1] = pairTotal - nextLeft
  return nextWidths
}
