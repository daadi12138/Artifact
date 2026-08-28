import assert from 'node:assert/strict'
import test from 'node:test'
import {
  defaultRunMetricColumnWeights,
  parseRunMetricColumnWeights,
  resizeRunMetricColumnPair,
  serializeRunMetricColumnWeights,
} from './app/run-metric-layout'

const closeTo = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} is not close to ${expected}`)

test('run metric column preferences round-trip as normalized versioned data', () => {
  const weights = parseRunMetricColumnWeights(serializeRunMetricColumnWeights([1, 2, 3, 4, 5]))
  closeTo(weights[1] / weights[0], 2)
  closeTo(weights.reduce((sum, value) => sum + value, 0), defaultRunMetricColumnWeights.reduce((sum, value) => sum + value, 0))
})

test('run metric column preferences reject malformed stored values', () => {
  assert.deepEqual(parseRunMetricColumnWeights(null), defaultRunMetricColumnWeights)
  assert.deepEqual(parseRunMetricColumnWeights('{broken'), defaultRunMetricColumnWeights)
  assert.deepEqual(parseRunMetricColumnWeights(JSON.stringify({ version: 1, weights: [1, 2, 3] })), defaultRunMetricColumnWeights)
  assert.deepEqual(parseRunMetricColumnWeights(JSON.stringify({ version: 2, weights: [1, 2, 3, 4, 5] })), defaultRunMetricColumnWeights)
  assert.deepEqual(parseRunMetricColumnWeights(JSON.stringify({ version: 1, weights: [1e308, 1e308, 1e308, 1e308, 1e308] })), defaultRunMetricColumnWeights)
})

test('run metric divider resizes only its adjacent columns and honors minimums', () => {
  const widths = [180, 300, 150, 200, 140] as const
  const resized = resizeRunMetricColumnPair(widths, 0, 80)
  assert.deepEqual(resized, [260, 220, 150, 200, 140])

  const clamped = resizeRunMetricColumnPair(widths, 0, -999)
  assert.deepEqual(clamped, [120, 360, 150, 200, 140])

  const reverseClamped = resizeRunMetricColumnPair(widths, 3, 999)
  assert.deepEqual(reverseClamped, [180, 300, 150, 244, 96])
})
