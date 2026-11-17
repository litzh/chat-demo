import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Miniflare, createFetchMock } from 'miniflare'
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose'
import { readFile, readdir } from 'node:fs/promises'
import { digest } from '../server/auth.js'

const origin = 'https://ds.example.test',
  issuer = 'https://example.cloudflareaccess.com'
const audience = 'test-application',
  email = 'owner@example.test'
let mf: Miniflare, privateKey: CryptoKey
const oldCookie = 'a'.repeat(64)
before(async () => {
  const keys = await generateKeyPair('RS256')
  privateKey = keys.privateKey
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' }
  const fetchMock = createFetchMock()
  fetchMock.disableNetConnect()
  fetchMock
    .get(issuer)
    .intercept({ method: 'GET', path: '/cdn-cgi/access/certs' })
    .reply(200, JSON.stringify({ keys: [jwk] }), {
      headers: { 'Content-Type': 'application/json' },
    })
    .persist()
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
    fetchMock,
    bindings: {
      AUTH_MODE: 'access',
      APP_ORIGIN: origin,
      ACCESS_TEAM_DOMAIN: 'example.cloudflareaccess.com',
      ACCESS_AUD: audience,
      ACCESS_EMAIL: email,
      ADMIN_PASSWORD_HASH: 'legacy-secret-still-present',
    },
  })
  const db = await mf.getD1Database('DB')
  for (const name of (await readdir('migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(`migrations/${name}`, 'utf8'))
      .split(';')
      .filter((s) => s.trim())) {
      await db.prepare(sql).run()
    }
  }
  await db
    .prepare('INSERT INTO auth_sessions(token_hash, expires_at) VALUES (?,?)')
    .bind(await digest(oldCookie), Date.now() + 60_000)
    .run()
})
after(async () => {
  await mf?.dispose()
})
const token = (claims: JWTPayload = {}) =>
  new SignJWT({
    type: 'app',
    email,
    sub: 'user-id',
    iss: issuer,
    aud: [audience],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .sign(privateKey)
async function call(path: string, assertion = '', init: RequestInit = {}, host = origin) {
  return mf.dispatchFetch(`${host}/api/${path}`, {
    ...init,
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...(assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {}),
      ...init.headers,
    },
  })
}

test('Access signature, audience and owner email authorize data without a password', async () => {
  const assertion = await token()
  const auth = await call('auth', assertion)
  assert.deepEqual(await auth.json(), {
    authenticated: true,
    configured: true,
    mode: 'access',
    loginUrl: origin,
  })
  assert.equal((await call('settings', assertion)).status, 200)
  const logout = await call('auth/logout', assertion, { method: 'POST' })
  assert.equal(
    ((await logout.json()) as { logoutUrl: string }).logoutUrl,
    origin + '/cdn-cgi/access/logout'
  )
})
test('missing assertion, spoofed email and legacy password cookies cannot bypass Access', async () => {
  assert.equal((await call('sessions')).status, 401)
  assert.equal(
    (
      await call('sessions', '', {
        headers: {
          'Cf-Access-Authenticated-User-Email': email,
          Cookie: `dsh_session=${oldCookie}`,
        },
      })
    ).status,
    401
  )
  assert.equal(
    (
      await call('auth/login', '', {
        method: 'POST',
        body: JSON.stringify({ password: 'anything' }),
      })
    ).status,
    401
  )
})
test('Access rejects wrong audience, issuer, user, token type and expired or incomplete tokens', async () => {
  for (const claims of [
    { aud: ['another-app'] },
    { iss: 'https://other.cloudflareaccess.com' },
    { email: 'someone@example.test' },
    { type: 'org' },
    { exp: Math.floor(Date.now() / 1000) - 120 },
    { exp: undefined },
  ]) {
    assert.equal((await call('settings', await token(claims))).status, 401)
  }
})
test('Access rejects forged signatures and direct pages.dev access', async () => {
  const valid = await token()
  const parts = valid.split('.')
  const forged = parts.slice(0, 2).join('.') + '.' + 'A'.repeat(parts[2].length)
  assert.equal((await call('settings', forged)).status, 401)
  assert.equal((await call('settings', valid, {}, 'https://project.pages.dev')).status, 401)
  assert.equal(
    (
      await call('settings', valid, {
        method: 'PUT',
        headers: { Origin: 'https://other.example' },
        body: '{}',
      })
    ).status,
    403
  )
})
