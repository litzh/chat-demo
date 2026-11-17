import { test } from 'node:test'
import assert from 'node:assert/strict'
import { saveCloudSession, useCloud } from '../src/services/cloud/client.js'
import type { Session } from '../src/services/chat/types.js'
import { splitSpeechText } from '../src/services/speech/textLimit.js'

Object.defineProperty(globalThis, 'window', { value: new EventTarget(), configurable: true })
const sample: Session = { id: 'sample', title: 'test', createdAt: 1, updatedAt: 1, messages: [] }
const lock = (token: string, revision = 0) => ({
  token,
  revision,
  until: performance.now() + 50000,
  owner: 'test',
})
test('queued snapshots use the latest acknowledged version', async () => {
  const revisions: number[] = []
  useCloud.setState({ locks: { sample: lock('A') } })
  const original = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { revision: number }
    revisions.push(body.revision)
    return Response.json({ revision: body.revision + 1 })
  }
  try {
    await Promise.all([
      saveCloudSession(sample, async () => {}),
      saveCloudSession({ ...sample, title: 'next' }, async () => {}),
    ])
    assert.deepEqual(revisions, [0, 1])
    assert.equal(useCloud.getState().locks.sample.revision, 2)
  } finally {
    globalThis.fetch = original
  }
})
test('a delayed failure from an old lease does not discard the new lease', async () => {
  useCloud.setState({ locks: { sample: lock('A') } })
  const original = globalThis.fetch
  let rejectRequest: (error: Error) => void = () => {}
  let reached: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    reached = resolve
  })
  globalThis.fetch = () =>
    new Promise((_resolve, reject) => {
      rejectRequest = reject
      reached()
    })
  try {
    const save = saveCloudSession(sample, async () => {})
    await started
    useCloud.setState({ locks: { sample: lock('B', 5) } })
    rejectRequest(new Error('offline'))
    await assert.rejects(save)
    assert.equal(useCloud.getState().locks.sample.token, 'B')
    assert.equal(useCloud.getState().locks.sample.revision, 5)
  } finally {
    globalThis.fetch = original
  }
})
test('expired client leases cannot write', async () => {
  useCloud.setState({ locks: { sample: { ...lock('A'), until: 0 } } })
  let uploaded = false
  await assert.rejects(
    saveCloudSession(sample, async () => {
      uploaded = true
    })
  )
  assert.equal(uploaded, false)
})
test('speech limits count Han twice and preserve Unicode across segments', () => {
  const text = '中'.repeat(5001) + '😀'.repeat(10000)
  const parts = splitSpeechText(text)
  assert.equal(parts[0], '中'.repeat(5000))
  assert.equal(parts.join(''), text)
  for (const part of parts) {
    assert.ok([...part].reduce((n, c) => n + (/\p{Script=Han}/u.test(c) ? 2 : 1), 0) <= 10000)
  }
})
