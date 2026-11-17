import { test } from 'node:test'
import assert from 'node:assert/strict'
import { importKey } from '../src/services/chat/history/importIdentity.js'
import type { Session } from '../src/services/chat/types.js'
const session: Session = {
  id: 'original',
  title: '备份',
  createdAt: 1,
  updatedAt: 2,
  rootMessageId: null,
  messages: [],
}
test('import identities survive property ordering but distinguish changed content', async () => {
  assert.equal(
    await importKey(session),
    await importKey(Object.fromEntries(Object.entries(session).reverse()) as Session)
  )
  assert.notEqual(await importKey(session), await importKey({ ...session, title: 'changed' }))
  assert.notEqual(await importKey(session), await importKey({ ...session, id: 'another-original' }))
})
