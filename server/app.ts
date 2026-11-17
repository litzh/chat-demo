import { cookieToken, digest, sessionCookie, verifyPassword } from './auth.js'
import { readPreferences } from '../shared/preferences.js'
import { accessConfiguration, authenticateAccess, type AccessEnv } from './access.js'

export type Env = AccessEnv & { DB: D1Database; FILES: R2Bucket; ADMIN_PASSWORD_HASH?: string }
const LEASE_MS = 60_000
const MAX_JSON = 32 * 1024 * 1024
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
function fail(status: number, message: string): never {
  throw new HttpError(status, message)
}
const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const validId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v)
async function body(request: Request, limit = MAX_JSON): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('Content-Length')) > limit) {
    fail(413, '数据过大')
  }
  if (!request.body) {
    return {}
  }
  const compression = request.headers.get('X-DSH-Compression')
  if (compression && compression !== 'gzip') {
    fail(400, '压缩格式无效')
  }
  const stream =
    compression === 'gzip'
      ? request.body.pipeThrough(new DecompressionStream('gzip'))
      : request.body
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = '',
    size = 0
  for (;;) {
    const { done, value } = await reader.read().catch(() => fail(400, '请求数据无法解压或读取'))
    if (done) {
      break
    }
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      fail(413, '数据过大')
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    fail(400, 'JSON 格式无效')
  }
  if (!isObject(value)) {
    fail(400, '请求格式无效')
  }
  return value
}
type SessionRow = {
  id: string
  title: string
  created_at: number
  updated_at: number
  revision: number
  lock_token: string | null
  lock_owner: string | null
  lock_until: number
  deleted: number
}
const summary = (row: SessionRow) => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  revision: row.revision,
  lockOwner: row.lock_until > Date.now() ? row.lock_owner : null,
  lockUntil: row.lock_until,
})
const readRow = (env: Env, id: string) =>
  env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND deleted = 0').bind(id).first<SessionRow>()
const requireToken = (request: Request) =>
  request.headers.get('X-Lock-Token') || fail(423, '需要先取得此对话的操作权')

/** Explicitly project the app's data model; transport credentials cannot enter snapshots. */
function cleanSession(
  value: unknown,
  id: string
): { data: Record<string, unknown>; fileIds: string[] } {
  if (
    !isObject(value) ||
    value.id !== id ||
    typeof value.title !== 'string' ||
    value.title.length > 2000 ||
    !Array.isArray(value.messages)
  ) {
    fail(400, '会话格式无效')
  }
  const ids = new Set<string>(),
    fileIds = new Set<string>()
  const messages = value.messages.map((message: unknown) => {
    if (
      !isObject(message) ||
      !validId(message.id) ||
      ids.has(message.id) ||
      !['user', 'assistant'].includes(String(message.role))
    ) {
      fail(400, '消息格式无效')
    }
    ids.add(message.id)
    const keys =
      message.role === 'user'
        ? ['id', 'role', 'content', 'files', 'createdAt', 'parentId', 'selectedChildId']
        : [
            'id',
            'role',
            'createdAt',
            'parentId',
            'selectedChildId',
            'model',
            'thinking',
            'search',
            'latestReminder',
            'prefix',
            'status',
            'blocks',
            'stopReason',
            'stopDetails',
            'usage',
            'error',
            'options',
          ]
    if (message.role === 'user') {
      if (typeof message.content !== 'string' || !Array.isArray(message.files)) {
        fail(400, '用户消息无效')
      }
      message = {
        ...message,
        files: message.files.map((file: unknown) => {
          if (!isObject(file) || !validId(file.id) || typeof file.name !== 'string') {
            fail(400, '附件无效')
          }
          fileIds.add(file.id)
          return Object.fromEntries(
            ['id', 'serverId', 'name', 'size', 'isImage', 'mimeType', 'purpose']
              .filter((k) => k in file)
              .map((k) => [k, file[k]])
          )
        }),
      }
    } else if (!Array.isArray(message.blocks)) {
      fail(400, '回答无效')
    }
    const source = message as Record<string, unknown>
    if (source.options !== undefined) {
      try {
        source.options = readPreferences(source.options)
      } catch {
        fail(400, '请求配置无效')
      }
    }
    return Object.fromEntries(keys.filter((k) => k in source).map((k) => [k, source[k]]))
  })
  let options: unknown
  if (value.options !== undefined) {
    try {
      options = readPreferences(value.options)
    } catch {
      fail(400, '会话配置无效')
    }
  }
  return {
    data: {
      id,
      title: value.title,
      createdAt: value.createdAt,
      updatedAt: Date.now(),
      messages,
      rootMessageId: value.rootMessageId,
      ...(options ? { options } : {}),
    },
    fileIds: [...fileIds],
  }
}
function chunks(text: string): string[] {
  const result: string[] = []
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + 120_000, text.length)
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff
    ) {
      end--
    }
    result.push(text.slice(start, end))
    start = end
  }
  return result
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  try {
    return await route(request, env)
  } catch (error) {
    return error instanceof HttpError
      ? json({ error: error.message }, error.status)
      : json({ error: '服务暂时不可用，请稍后重试' }, 500)
  }
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url),
    method = request.method,
    path = url.pathname.replace(/^\/api\/?/, '')
  if (!['GET', 'HEAD'].includes(method) && request.headers.get('Origin') !== url.origin) {
    fail(403, '请求来源无效')
  }
  if (!env.DB || !env.FILES) {
    fail(503, '尚未配置 D1 / R2 绑定')
  }
  const accessMode = env.AUTH_MODE !== 'password'
  if (accessMode) {
    const configured = !!accessConfiguration(env)
    const identity = configured ? await authenticateAccess(request, env) : null
    if (path === 'auth' && method === 'GET') {
      return json({
        authenticated: !!identity,
        configured,
        mode: 'access',
        loginUrl: env.APP_ORIGIN || '/',
      })
    }
    if (!configured) {
      fail(503, '尚未配置 Cloudflare Access')
    }
    if (path === 'auth/login') {
      fail(401, '请通过 Cloudflare Access 邮箱验证登录')
    }
    if (!identity) {
      fail(401, '邮箱登录已过期，请重新验证')
    }
    if (path === 'auth/logout' && method === 'POST') {
      return json({ ok: true, logoutUrl: `${env.APP_ORIGIN}/cdn-cgi/access/logout` }, 200, {
        'Set-Cookie': sessionCookie(request, '', 0),
      })
    }
  }
  if (!accessMode && path === 'auth/login' && method === 'POST') {
    if (!env.ADMIN_PASSWORD_HASH) {
      fail(503, '请先配置管理员密码')
    }
    const ip = await digest(request.headers.get('CF-Connecting-IP') || 'local')
    const now = Date.now()
    const attempts =
      await env.DB.prepare(`INSERT INTO login_attempts(ip_hash, attempts, expires_at) VALUES (?, 1, ?)
      ON CONFLICT(ip_hash) DO UPDATE SET attempts = CASE WHEN expires_at < ? THEN 1 ELSE attempts + 1 END,
      expires_at = CASE WHEN expires_at < ? THEN excluded.expires_at ELSE expires_at END RETURNING attempts`)
        .bind(ip, now + 60_000, now, now)
        .first<{ attempts: number }>()
    if ((attempts?.attempts ?? 99) > 5) {
      fail(429, '尝试过于频繁，请一分钟后再试')
    }
    const input = await body(request, 4096)
    if (
      typeof input.password !== 'string' ||
      input.password.length > 1024 ||
      !(await verifyPassword(input.password, env.ADMIN_PASSWORD_HASH))
    ) {
      fail(401, '密码不正确')
    }
    const token = crypto.randomUUID() + crypto.randomUUID(),
      seconds = 30 * 86400
    await env.DB.batch([
      env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(now),
      env.DB.prepare('INSERT INTO auth_sessions(token_hash, expires_at) VALUES (?, ?)').bind(
        await digest(token),
        now + seconds * 1000
      ),
    ])
    return json({ authenticated: true }, 200, {
      'Set-Cookie': sessionCookie(request, token, seconds),
    })
  }
  const token = accessMode ? '' : cookieToken(request)
  const auth =
    token &&
    (await env.DB.prepare(
      'SELECT token_hash FROM auth_sessions WHERE token_hash = ? AND expires_at > ?'
    )
      .bind(await digest(token), Date.now())
      .first())
  if (!accessMode && path === 'auth' && method === 'GET') {
    return json({ authenticated: !!auth, configured: !!env.ADMIN_PASSWORD_HASH, mode: 'password' })
  }
  if (!accessMode && !auth) {
    fail(401, '请先登录')
  }
  if (!accessMode && path === 'auth/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?')
      .bind(await digest(token))
      .run()
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) })
  }
  if (path === 'settings') {
    if (method === 'GET') {
      const row = await env.DB.prepare('SELECT data, revision FROM settings WHERE id = 1').first<{
        data: string
        revision: number
      }>()
      return json({ settings: row ? JSON.parse(row.data) : null, revision: row?.revision ?? 0 })
    }
    if (method === 'PUT') {
      const input = await body(request, 64_000)
      let settings
      try {
        settings = readPreferences(input)
      } catch (error) {
        fail(400, error instanceof Error ? error.message : '设置无效')
      }
      const row = await env.DB.prepare(`INSERT INTO settings(id, data, revision) VALUES (1, ?, 1)
        ON CONFLICT(id) DO UPDATE SET data = excluded.data, revision = settings.revision + 1 RETURNING revision`)
        .bind(JSON.stringify(settings))
        .first()
      return json(row)
    }
  }
  if (path === 'imports' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT import_key AS key, id FROM sessions WHERE deleted = 0 AND import_key IS NOT NULL'
    ).all()
    return json({ items: rows.results })
  }
  if (path === 'imports' && method === 'POST') {
    const input = await body(request)
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 5) {
      fail(400, '每批导入 1–5 个对话')
    }
    const writeToken = crypto.randomUUID(),
      statements: D1PreparedStatement[] = [],
      keys: string[] = []
    for (const item of input.items) {
      if (
        !isObject(item) ||
        typeof item.key !== 'string' ||
        !/^[a-f0-9]{64}$/.test(item.key) ||
        !isObject(item.session) ||
        !validId(item.session.id) ||
        keys.includes(item.key)
      ) {
        fail(400, '导入条目无效')
      }
      const id = item.session.id,
        key = item.key
      const { data, fileIds } = cleanSession(item.session, id)
      if (!Number.isFinite(data.createdAt) || !Number.isFinite(item.session.updatedAt)) {
        fail(400, '对话时间无效')
      }
      data.updatedAt = item.session.updatedAt
      keys.push(key)
      statements.push(
        env.DB.prepare(`INSERT OR IGNORE INTO sessions
        (id, title, created_at, updated_at, revision, write_token, import_key)
        VALUES (?, ?, ?, ?, 1, ?, ?)`).bind(
          id,
          data.title,
          data.createdAt,
          data.updatedAt,
          writeToken,
          key
        )
      )
      const guard =
        'EXISTS (SELECT 1 FROM sessions WHERE id = ? AND write_token = ? AND deleted = 0)'
      for (const [part, text] of chunks(JSON.stringify(data)).entries()) {
        statements.push(
          env.DB.prepare(`INSERT INTO session_chunks(session_id, part, data)
          SELECT ?, ?, ? WHERE ${guard}`).bind(id, part, text, id, writeToken)
        )
      }
      // json_each keeps file references in one query even when a conversation has many files.
      statements.push(
        env.DB.prepare(`INSERT INTO session_files(session_id, file_id)
        SELECT ?, value FROM json_each(?) WHERE ${guard}`).bind(
          id,
          JSON.stringify(fileIds),
          id,
          writeToken
        )
      )
    }
    if (statements.length > 45) {
      fail(413, '此批对话过大，请分批导入')
    }
    statements.push(
      env.DB.prepare(`SELECT import_key AS key, id, write_token = ? AS created
      FROM sessions WHERE deleted = 0 AND import_key IN (SELECT value FROM json_each(?))`).bind(
        writeToken,
        JSON.stringify(keys)
      )
    )
    // Each batch commits snapshots and deduplication keys together. A lost response is safe to retry.
    const results = await env.DB.batch(statements)
    return json({ items: results[results.length - 1].results })
  }
  if (path === 'session-batches/delete' && method === 'POST') {
    const input = await body(request, 64_000)
    if (
      !Array.isArray(input.ids) ||
      !input.ids.length ||
      input.ids.length > 100 ||
      !input.ids.every(validId) ||
      !Array.isArray(input.leases) ||
      input.leases.some((lease) => !isObject(lease) || !validId(lease.id) || !validId(lease.token))
    ) {
      fail(400, '删除参数无效')
    }
    const ids = JSON.stringify([...new Set(input.ids)])
    const selected = 'id IN (SELECT value FROM json_each(?))'
    const results = await env.DB.batch([
      env.DB.prepare(`UPDATE sessions SET deleted = 1, lock_token = NULL, lock_until = 0,
        revision = revision + 1 WHERE ${selected} AND deleted = 0 AND
        (lock_until <= ? OR lock_token = (SELECT json_extract(value, '$.token') FROM json_each(?)
          WHERE json_extract(value, '$.id') = sessions.id))`).bind(
        ids,
        Date.now(),
        JSON.stringify(input.leases)
      ),
      env.DB.prepare(`DELETE FROM session_chunks WHERE session_id IN
        (SELECT id FROM sessions WHERE ${selected} AND deleted = 1)`).bind(ids),
      env.DB.prepare(`DELETE FROM session_files WHERE session_id IN
        (SELECT id FROM sessions WHERE ${selected} AND deleted = 1)`).bind(ids),
      env.DB.prepare(
        `SELECT id, lock_owner AS owner FROM sessions WHERE ${selected} AND deleted = 0`
      ).bind(ids),
    ])
    const blocked = results[3].results as { id: string; owner: string | null }[]
    return json({
      deleted: input.ids.filter((id) => !blocked.some((row) => row.id === id)),
      blocked,
    })
  }
  if (path === 'sessions' && method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT * FROM sessions WHERE deleted = 0 ORDER BY updated_at DESC'
    ).all<SessionRow>()
    return json({ sessions: rows.results.map(summary) })
  }
  if (path === 'sessions' && method === 'POST') {
    const input = await body(request, 4096)
    if (!validId(input.id) || typeof input.owner !== 'string' || input.owner.length > 100) {
      fail(400, '会话参数无效')
    }
    const now = Date.now(),
      lockToken = crypto.randomUUID()
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO sessions(id, created_at, updated_at, lock_token, lock_owner, lock_until) VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(input.id, now, now, lockToken, input.owner, now + LEASE_MS)
      .run()
    if (result.meta.changes !== 1) {
      fail(409, '会话已存在，请刷新')
    }
    return json({ token: lockToken, expiresAt: now + LEASE_MS, revision: 0 }, 201)
  }
  const match = path.match(/^sessions\/([a-zA-Z0-9_-]{1,100})(?:\/(lock))?$/)
  if (match) {
    const id = match[1]
    if (match[2]) {
      if (method === 'POST') {
        const input = await body(request, 4096)
        if (typeof input.owner !== 'string' || input.owner.length > 100) {
          fail(400, '设备名无效')
        }
        const now = Date.now(),
          lockToken = crypto.randomUUID()
        const row =
          await env.DB.prepare(`UPDATE sessions SET lock_token = ?, lock_owner = ?, lock_until = ?
          WHERE id = ? AND deleted = 0 AND (lock_until <= ? OR ? = 1) RETURNING revision`)
            .bind(lockToken, input.owner, now + LEASE_MS, id, now, input.takeover === true ? 1 : 0)
            .first<{ revision: number }>()
        if (!row) {
          const current = await readRow(env, id)
          if (!current) {
            fail(404, '会话不存在')
          }
          return json(
            {
              error: '此对话正在另一端操作',
              owner: current.lock_owner,
              expiresAt: current.lock_until,
            },
            423
          )
        }
        return json({ token: lockToken, expiresAt: now + LEASE_MS, revision: row.revision })
      }
      if (method === 'PUT') {
        const now = Date.now()
        const row = await env.DB.prepare(
          `UPDATE sessions SET lock_until = ? WHERE id = ? AND deleted = 0 AND lock_token = ? AND lock_until > ? RETURNING revision`
        )
          .bind(now + LEASE_MS, id, requireToken(request), now)
          .first()
        if (!row) {
          fail(423, '操作权已失效，请重新获取')
        }
        return json({ ...row, expiresAt: now + LEASE_MS })
      }
      if (method === 'DELETE') {
        await env.DB.prepare(
          'UPDATE sessions SET lock_token = NULL, lock_owner = NULL, lock_until = 0 WHERE id = ? AND lock_token = ?'
        )
          .bind(id, requireToken(request))
          .run()
        return json({ ok: true })
      }
    } else if (method === 'GET') {
      // One batch guarantees metadata and snapshot belong to the same revision.
      const [metadata, parts] = await env.DB.batch([
        env.DB.prepare('SELECT * FROM sessions WHERE id = ? AND deleted = 0').bind(id),
        env.DB.prepare('SELECT data FROM session_chunks WHERE session_id = ? ORDER BY part').bind(
          id
        ),
      ])
      const row = metadata.results[0] as SessionRow | undefined
      if (!row) {
        fail(404, '会话不存在')
      }
      const session = parts.results.length
        ? JSON.parse(parts.results.map((part) => (part as { data: string }).data).join(''))
        : { ...summary(row), messages: [], rootMessageId: null }
      return json({ session, ...summary(row) })
    } else if (method === 'PUT') {
      const lockToken = requireToken(request),
        input = await body(request)
      if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) {
        fail(400, '版本无效')
      }
      const revision = input.revision as number
      const { data, fileIds } = cleanSession(input.session, id)
      const now = Date.now(),
        serialized = chunks(JSON.stringify(data)),
        writeToken = crypto.randomUUID()
      const guard =
        'EXISTS (SELECT 1 FROM sessions WHERE id = ? AND write_token = ? AND lock_token = ? AND deleted = 0)'
      const guarded = (sql: string, values: (string | number | null)[]) =>
        env.DB.prepare(sql).bind(...values, id, writeToken, lockToken)
      const statements = [
        env.DB.prepare(
          `UPDATE sessions SET title = ?, updated_at = ?, revision = revision + 1, write_token = ? WHERE id = ? AND revision = ? AND lock_token = ? AND lock_until > ? AND deleted = 0`
        ).bind(String(data.title), now, writeToken, id, revision, lockToken, now),
        guarded(`DELETE FROM session_chunks WHERE session_id = ? AND ${guard}`, [id]),
        ...serialized.map((part, index) =>
          guarded(
            `INSERT INTO session_chunks(session_id, part, data) SELECT ?, ?, ? WHERE ${guard}`,
            [id, index, part]
          )
        ),
        guarded(`DELETE FROM session_files WHERE session_id = ? AND ${guard}`, [id]),
        ...fileIds.map((file) =>
          guarded(`INSERT INTO session_files(session_id, file_id) SELECT ?, ? WHERE ${guard}`, [
            id,
            file,
          ])
        ),
      ]
      const results = await env.DB.batch(statements)
      if (results[0].meta.changes !== 1) {
        fail(409, '保存被拒绝：操作权或版本已变化，请重新加载')
      }
      return json({ revision: revision + 1, updatedAt: now })
    } else if (method === 'DELETE') {
      const result = await env.DB.prepare(
        `UPDATE sessions SET deleted = 1, lock_token = NULL, lock_until = 0, revision = revision + 1 WHERE id = ? AND lock_token = ? AND lock_until > ? AND deleted = 0`
      )
        .bind(id, requireToken(request), Date.now())
        .run()
      if (result.meta.changes !== 1) {
        fail(423, '删除失败：操作权已失效')
      }
      await env.DB.batch([
        env.DB.prepare('DELETE FROM session_chunks WHERE session_id = ?').bind(id),
        env.DB.prepare('DELETE FROM session_files WHERE session_id = ?').bind(id),
      ])
      return json({ ok: true })
    }
  }
  const fileMatch = path.match(/^files\/([a-zA-Z0-9_-]{1,100})$/)
  if (fileMatch) {
    const id = fileMatch[1],
      objectKey = `attachments/${id}`
    if (method === 'HEAD' || method === 'GET') {
      const object =
        method === 'HEAD' ? await env.FILES.head(objectKey) : await env.FILES.get(objectKey)
      if (!object) {
        fail(404, '原件尚未同步')
      }
      const headers = new Headers({
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'attachment',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      })
      object.writeHttpMetadata(headers)
      headers.set('ETag', object.httpEtag)
      headers.set('Content-Length', String(object.size))
      return new Response('body' in object ? (object as R2ObjectBody).body : null, { headers })
    }
    if (method === 'PUT') {
      const size = Number(request.headers.get('Content-Length'))
      if (!Number.isSafeInteger(size) || size <= 0 || size > 100 * 1024 * 1024 || !request.body) {
        fail(413, '附件必须小于等于 100 MiB')
      }
      const existing = await env.FILES.head(objectKey)
      if (existing) {
        return json({ ok: true })
      }
      const mime = request.headers.get('Content-Type') || 'application/octet-stream'
      await env.FILES.put(objectKey, request.body, { httpMetadata: { contentType: mime } })
      await env.DB.prepare(
        'INSERT OR IGNORE INTO attachments(id, object_key, size, mime_type, created_at) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(id, objectKey, size, mime, Date.now())
        .run()
      return json({ ok: true })
    }
  }
  fail(404, '接口不存在')
}
