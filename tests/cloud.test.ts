import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { pbkdf2Sync } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
let mf: Miniflare, cookie: string
const password = 'integration-test-password'
before(async () => {
  const salt = Buffer.alloc(16, 7)
  const hash = `pbkdf2$100000$${salt.toString('hex')}$${pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex')}`
  const bundle = await build({
    stdin: {
      contents:
        "import {handleRequest} from './server/app.ts'; export default {fetch:handleRequest}",
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  })
  mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-07-29',
    d1Databases: ['DB'],
    r2Buckets: ['FILES'],
    bindings: { AUTH_MODE: 'password', ADMIN_PASSWORD_HASH: hash },
  })
  const db = await mf.getD1Database('DB')
  for (const migration of (await readdir('migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    for (const sql of (await readFile(`migrations/${migration}`, 'utf8'))
      .split(';')
      .filter((s) => s.trim())) {
      await db.prepare(sql).run()
    }
  }
  const res = await mf.dispatchFetch('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  assert.equal(res.status, 200)
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
})
after(async () => {
  await mf?.dispose()
})
async function call(path: string, method = 'GET', data?: unknown, token?: string) {
  const res = await mf.dispatchFetch(`http://localhost/api/${path}`, {
    method,
    headers: {
      Cookie: cookie,
      Origin: 'http://localhost',
      'Content-Type': 'application/json',
      ...(token ? { 'X-Lock-Token': token } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  })
  return {
    status: res.status,
    data: (await res.json()) as {
      token: string
      session: ReturnType<typeof snapshot>
      settings: { thinking: boolean }
      items: { key: string; id: string; created: number }[]
      deleted: string[]
      blocked: { id: string; owner: string }[]
    },
  }
}
const snapshot = (id: string, title = 'test') => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 1,
  rootMessageId: 'q',
  messages: [
    {
      id: 'q',
      role: 'user',
      content: title,
      files: [],
      createdAt: 1,
      parentId: null,
      selectedChildId: null,
    },
  ],
})
const create = async (id: string) =>
  (await call('sessions', 'POST', { id, owner: 'A' })).data.token as string

test('authentication and origin protect mutations', async () => {
  assert.equal((await mf.dispatchFetch('http://localhost/api/sessions')).status, 401)
  assert.equal(
    (
      await mf.dispatchFetch('http://localhost/api/settings', {
        method: 'PUT',
        headers: { Cookie: cookie, Origin: 'https://evil.example' },
        body: '{}',
      })
    ).status,
    403
  )
})
test('exactly one device wins a free lease', async () => {
  const token = await create('race')
  await call('sessions/race/lock', 'DELETE', undefined, token)
  const results = await Promise.all(
    ['A', 'B'].map((owner) => call('sessions/race/lock', 'POST', { owner }))
  )
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 423])
})
test('takeover fences old saves, renewals and releases', async () => {
  const a = await create('takeover')
  const b = (await call('sessions/takeover/lock', 'POST', { owner: 'B', takeover: true })).data
    .token
  assert.equal(
    (
      await call(
        'sessions/takeover',
        'PUT',
        { revision: 0, session: snapshot('takeover', 'old') },
        a
      )
    ).status,
    409
  )
  assert.equal((await call('sessions/takeover/lock', 'PUT', undefined, a)).status, 423)
  await call('sessions/takeover/lock', 'DELETE', undefined, a)
  assert.equal(
    (
      await call(
        'sessions/takeover',
        'PUT',
        { revision: 0, session: snapshot('takeover', 'new') },
        b
      )
    ).status,
    200
  )
  assert.equal((await call('sessions/takeover')).data.session.title, 'new')
})
test('stale version cannot corrupt chunks after a successful save', async () => {
  const token = await create('stale')
  assert.equal(
    (await call('sessions/stale', 'PUT', { revision: 0, session: snapshot('stale', 'new') }, token))
      .status,
    200
  )
  assert.equal(
    (await call('sessions/stale', 'PUT', { revision: 0, session: snapshot('stale', 'old') }, token))
      .status,
    409
  )
  assert.equal((await call('sessions/stale')).data.session.title, 'new')
})
test('expired leases cannot renew or save', async () => {
  const token = await create('expired')
  await (
    await mf.getD1Database('DB')
  )
    .prepare('UPDATE sessions SET lock_until = 0 WHERE id = ?')
    .bind('expired')
    .run()
  assert.equal((await call('sessions/expired/lock', 'PUT', undefined, token)).status, 423)
  assert.equal(
    (await call('sessions/expired', 'PUT', { revision: 0, session: snapshot('expired') }, token))
      .status,
    409
  )
  assert.equal((await call('sessions/expired/lock', 'POST', { owner: 'B' })).status, 200)
})
test('credentials cannot be persisted as settings', async () => {
  assert.equal((await call('settings', 'PUT', { apiKey: 'secret' })).status, 400)
  assert.equal(
    (await call('settings', 'PUT', { location: { region: 'CN', apiKey: 'secret' } })).status,
    400
  )
  assert.equal((await call('settings', 'PUT', { thinking: true, temperature: 0.5 })).status, 200)
  assert.equal((await call('settings')).data.settings.thinking, true)
})
test('unicode survives D1 chunk boundaries', async () => {
  const token = await create('unicode'),
    value = snapshot('unicode')
  value.messages[0].content = '中😀文'.repeat(70000)
  assert.equal(
    (await call('sessions/unicode', 'PUT', { revision: 0, session: value }, token)).status,
    200
  )
  assert.equal(
    (await call('sessions/unicode')).data.session.messages[0].content,
    value.messages[0].content
  )
})
test('deleted sessions cannot be resurrected by an old writer', async () => {
  const token = await create('deleted')
  assert.equal((await call('sessions/deleted', 'DELETE', undefined, token)).status, 200)
  assert.equal(
    (await call('sessions/deleted', 'PUT', { revision: 0, session: snapshot('deleted') }, token))
      .status,
    409
  )
  assert.equal((await call('sessions', 'POST', { id: 'deleted', owner: 'A' })).status, 409)
})
test('R2 originals require authentication', async () => {
  const response = await mf.dispatchFetch('http://localhost/api/files/test-file', {
    method: 'PUT',
    headers: {
      Cookie: cookie,
      Origin: 'http://localhost',
      'Content-Type': 'text/plain',
      'Content-Length': '5',
    },
    body: 'hello',
  })
  assert.equal(response.status, 200)
  assert.equal((await mf.dispatchFetch('http://localhost/api/files/test-file')).status, 401)
  const file = await mf.dispatchFetch('http://localhost/api/files/test-file', {
    headers: { Cookie: cookie },
  })
  assert.equal(await file.text(), 'hello')
  assert.equal(file.headers.get('Cache-Control'), 'private, no-store')
  const head = await mf.dispatchFetch('http://localhost/api/files/test-file', {
    method: 'HEAD',
    headers: { Cookie: cookie },
  })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('Content-Length'), '5')
})

test('import batches are atomic, idempotent and preserve original timestamps', async () => {
  const key = 'a'.repeat(64)
  const original = snapshot('import-first')
  original.messages[0].content = '大备份😀'.repeat(80000)
  const first = await call('imports', 'POST', { items: [{ key, session: original }] })
  assert.equal(first.status, 200)
  assert.deepEqual(first.data.items, [{ key, id: 'import-first', created: 1 }])
  const repeated = await call('imports', 'POST', {
    items: [{ key, session: snapshot('import-retry', 'must not overwrite') }],
  })
  assert.deepEqual(repeated.data.items, [{ key, id: 'import-first', created: 0 }])
  assert.equal((await call('sessions/import-retry')).status, 404)
  const saved = (await call('sessions/import-first')).data.session
  assert.equal(saved.messages[0].content, original.messages[0].content)
  assert.equal(saved.createdAt, 1)
  assert.equal(saved.updatedAt, 1)
  const invalid = await call('imports', 'POST', {
    items: [
      { key: 'b'.repeat(64), session: snapshot('atomic-invalid') },
      { key: 'invalid', session: snapshot('invalid') },
    ],
  })
  assert.equal(invalid.status, 400)
  assert.equal((await call('sessions/atomic-invalid')).status, 404)
})

test('concurrent repeated imports create only one complete conversation', async () => {
  const key = 'c'.repeat(64)
  const attempts = await Promise.all(
    [1, 2, 3].map((i) =>
      call('imports', 'POST', {
        items: [{ key, session: snapshot(`concurrent-import-${i}`) }],
      })
    )
  )
  assert.ok(attempts.every((r) => r.status === 200))
  assert.equal(new Set(attempts.map((r) => r.data.items[0].id)).size, 1)
  const id = attempts[0].data.items[0].id
  assert.equal((await call(`sessions/${id}`)).data.session.messages.length, 1)
})

test('compressed imports preserve content and reject damaged compression', async () => {
  const session = snapshot('compressed-import')
  session.messages[0].content = '压缩传输😀'.repeat(50000)
  const response = await mf.dispatchFetch('http://localhost/api/imports', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: 'http://localhost',
      'X-DSH-Compression': 'gzip',
      'Content-Type': 'application/json',
    },
    body: gzipSync(JSON.stringify({ items: [{ key: 'd'.repeat(64), session }] })),
  })
  assert.equal(response.status, 200)
  assert.equal(
    (await call('sessions/compressed-import')).data.session.messages[0].content,
    session.messages[0].content
  )
  const broken = await mf.dispatchFetch('http://localhost/api/imports', {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'http://localhost', 'X-DSH-Compression': 'gzip' },
    body: 'invalid gzip',
  })
  assert.equal(broken.status, 400)
})

test('bulk deletion skips other owners, fences stale saves and permits intentional reimport', async () => {
  const own = await create('bulk-own')
  await create('bulk-other')
  const expired = await create('bulk-expired')
  await call('sessions/bulk-expired/lock', 'DELETE', undefined, expired)
  const result = await call('session-batches/delete', 'POST', {
    ids: ['bulk-own', 'bulk-other', 'bulk-expired', 'already-missing', 'import-first'],
    leases: [{ id: 'bulk-own', token: own }],
  })
  assert.equal(result.status, 200)
  assert.deepEqual(
    result.data.blocked.map((r) => r.id),
    ['bulk-other']
  )
  assert.deepEqual(result.data.deleted.sort(), [
    'already-missing',
    'bulk-expired',
    'bulk-own',
    'import-first',
  ])
  assert.equal(
    (await call('sessions/bulk-own', 'PUT', { revision: 0, session: snapshot('bulk-own') }, own))
      .status,
    409
  )
  assert.equal((await call('sessions/import-first')).status, 404)
  const retry = await call('session-batches/delete', 'POST', { ids: ['bulk-own'], leases: [] })
  assert.deepEqual(retry.data.deleted, ['bulk-own'])
  const again = await call('imports', 'POST', {
    items: [{ key: 'a'.repeat(64), session: snapshot('import-after-delete') }],
  })
  assert.equal(again.data.items[0].created, 1)
  assert.equal(again.data.items[0].id, 'import-after-delete')
})
