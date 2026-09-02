import assert from 'node:assert/strict'
import test from 'node:test'
import { fitWindowBounds, parseDesktopWindowState } from './window-state'

test('desktop window state accepts only complete versioned values', () => {
  const state = { version: 1, bounds: { x: 120, y: 80, width: 1440, height: 900 }, maximized: true, fullScreen: false }
  assert.deepEqual(parseDesktopWindowState(state), state)
  assert.equal(parseDesktopWindowState({ ...state, bounds: { ...state.bounds, width: -1 } }), null)
  assert.equal(parseDesktopWindowState({ ...state, version: 2 }), null)
})

test('desktop window bounds remain visible when a saved display is unavailable', () => {
  const workAreas = [{ x: 0, y: 25, width: 1512, height: 957 }]
  assert.deepEqual(
    fitWindowBounds({ x: 1800, y: -400, width: 1700, height: 1200 }, workAreas, 1080, 720),
    { x: 0, y: 25, width: 1512, height: 957 },
  )
})

test('desktop window bounds preserve the matching secondary display', () => {
  const workAreas = [{ x: 0, y: 25, width: 1512, height: 957 }, { x: 1512, y: 0, width: 1920, height: 1080 }]
  assert.deepEqual(
    fitWindowBounds({ x: 1700, y: 90, width: 1400, height: 860 }, workAreas, 1080, 720),
    { x: 1700, y: 90, width: 1400, height: 860 },
  )
})
