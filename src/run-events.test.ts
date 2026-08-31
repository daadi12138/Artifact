import assert from 'node:assert/strict'
import test from 'node:test'
import { notifyRunChanged, subscribeRunEvents } from './run-events'

test('run event bus notifies subscribers per run id until unsubscribed', () => {
  const seen: string[] = []
  const unsubscribeA = subscribeRunEvents('run-a', () => seen.push('a'))
  subscribeRunEvents('run-b', () => seen.push('b'))
  notifyRunChanged('run-a')
  notifyRunChanged('run-b')
  notifyRunChanged('run-a')
  unsubscribeA()
  notifyRunChanged('run-a')
  assert.deepEqual(seen, ['a', 'b', 'a'])
})

test('a throwing listener never breaks other subscribers or the caller', () => {
  const seen: string[] = []
  const unsubscribeBroken = subscribeRunEvents('run-c', () => { throw new Error('broken subscriber') })
  subscribeRunEvents('run-c', () => seen.push('healthy'))
  assert.doesNotThrow(() => notifyRunChanged('run-c'))
  assert.deepEqual(seen, ['healthy'])
  unsubscribeBroken()
})
