import { create } from 'zustand'
import type { Session, SessionSummary } from '../chat/types.js'

export class CloudError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly owner?: string
  ) {
    super(message)
  }
}
type Lease = { token: string; until: number; owner: string; revision: number }
export type CloudSummary = SessionSummary & {
  revision: number
  lockOwner: string | null
  lockUntil: number
}
export const useCloud = create(() => ({
  online: true,
  locks: {} as Record<string, Lease>,
  owners: {} as Record<string, string>,
  busy: {} as Record<string, boolean>,
  errors: {} as Record<string, string>,
  saving: {} as Record<string, boolean>,
  settingsStatus: '已同步' as string,
  authMode: 'password' as 'access' | 'password',
  authLoginUrl: '/',
}))
const deviceName = /iPhone|iPad/.test(navigator.userAgent)
  ? 'iPhone / iPad'
  : /Android/.test(navigator.userAgent)
    ? 'Android 手机'
    : '电脑浏览器'
export const tabName = `${deviceName} · ${crypto.randomUUID().slice(0, 4)}`

export async function cloudApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    let payload = init.body
    const compressed =
      path === 'imports' &&
      typeof payload === 'string' &&
      payload.length > 16_384 &&
      typeof CompressionStream !== 'undefined'
    if (compressed) {
      payload = await new Response(
        new Blob([payload as string]).stream().pipeThrough(new CompressionStream('gzip'))
      ).blob()
    }
    response = await fetch(`/api/${path}`, {
      ...init,
      body: payload,
      credentials: 'same-origin',
      redirect: 'manual',
      cache: 'no-store',
      signal: init.signal ?? AbortSignal.timeout(30_000),
      headers: {
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...(compressed ? { 'X-DSH-Compression': 'gzip' } : {}),
        ...init.headers,
      },
    })
  } catch {
    useCloud.setState({ online: false })
    throw new CloudError(0, '无法连接同步服务，请检查网络')
  }
  useCloud.setState({ online: true })
  if (response.type === 'opaqueredirect' || response.status === 302) {
    useCloud.setState({ authMode: 'access' })
    window.dispatchEvent(new Event('dsh-auth-required'))
    throw new CloudError(401, '邮箱登录已过期，请重新验证')
  }
  const result = (await response.json()) as { error?: string; owner?: string } & T
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('auth')) {
      window.dispatchEvent(new Event('dsh-auth-required'))
    }
    throw new CloudError(response.status, result.error ?? '同步失败', result.owner)
  }
  return result
}
export const canWrite = (id: string | null) =>
  id === null
    ? useCloud.getState().online
    : (useCloud.getState().locks[id]?.until ?? 0) > performance.now()
export function loseLock(id: string, error = '操作权已失效，本地未同步内容已保留') {
  useCloud.setState((state) => ({
    locks: Object.fromEntries(Object.entries(state.locks).filter(([key]) => key !== id)),
    errors: { ...state.errors, [id]: error },
  }))
  window.dispatchEvent(new CustomEvent('dsh-lock-lost', { detail: id }))
}
const recordLease = (id: string, token: string, revision: number, started: number) => {
  useCloud.setState((state) => ({
    locks: { ...state.locks, [id]: { token, revision, until: started + 55_000, owner: tabName } },
    owners: { ...state.owners, [id]: tabName },
    errors: { ...state.errors, [id]: '' },
  }))
}
export async function createCloudSession(id: string) {
  const started = performance.now()
  const lease = await cloudApi<{ token: string; revision: number }>('sessions', {
    method: 'POST',
    body: JSON.stringify({ id, owner: tabName }),
  })
  recordLease(id, lease.token, lease.revision, started)
}
export const listCloudSessions = () => cloudApi<{ sessions: CloudSummary[] }>('sessions')
export async function deleteCloudSessions(ids: string[]) {
  const leases = Object.entries(useCloud.getState().locks)
    .filter(([id]) => ids.includes(id))
    .map(([id, lease]) => ({ id, token: lease.token }))
  const result = await cloudApi<{
    deleted: string[]
    blocked: { id: string; owner: string | null }[]
  }>('session-batches/delete', { method: 'POST', body: JSON.stringify({ ids, leases }) })
  useCloud.setState((state) => ({
    locks: Object.fromEntries(
      Object.entries(state.locks).filter(([id]) => !result.deleted.includes(id))
    ),
  }))
  return result
}
export const readCloudSession = (id: string) =>
  cloudApi<{ session: Session; revision: number; lockOwner: string | null }>(`sessions/${id}`)
const acquisitions = new Map<string, Promise<Session>>()
export function acquireSession(id: string, takeover = false): Promise<Session> {
  const existing = acquisitions.get(id)
  if (existing) {
    return existing
  }
  const task = (async () => {
    useCloud.setState((state) => ({ busy: { ...state.busy, [id]: true } }))
    let token: string | undefined
    try {
      const started = performance.now()
      const lease = await cloudApi<{ token: string; revision: number }>(`sessions/${id}/lock`, {
        method: 'POST',
        body: JSON.stringify({ owner: tabName, takeover }),
      })
      token = lease.token
      const latest = await readCloudSession(id)
      recordLease(id, lease.token, latest.revision, started)
      return latest.session
    } catch (error) {
      if (token) {
        void cloudApi(`sessions/${id}/lock`, {
          method: 'DELETE',
          headers: { 'X-Lock-Token': token },
        }).catch(() => {})
      }
      useCloud.setState((state) => ({
        owners: { ...state.owners, [id]: error instanceof CloudError ? (error.owner ?? '') : '' },
      }))
      throw error
    } finally {
      useCloud.setState((state) => ({ busy: { ...state.busy, [id]: false } }))
    }
  })().finally(() => acquisitions.delete(id))
  acquisitions.set(id, task)
  return task
}
export async function renewSession(id: string) {
  const lease = useCloud.getState().locks[id]
  if (!lease || !canWrite(id)) {
    loseLock(id)
    throw new CloudError(423, '操作权已过期')
  }
  try {
    const started = performance.now()
    await cloudApi(`sessions/${id}/lock`, {
      method: 'PUT',
      headers: { 'X-Lock-Token': lease.token },
    })
    if (useCloud.getState().locks[id]?.token === lease.token) {
      useCloud.setState((state) => ({
        locks: { ...state.locks, [id]: { ...state.locks[id], until: started + 55_000 } },
      }))
    }
  } catch (error) {
    if (useCloud.getState().locks[id]?.token === lease.token) {
      loseLock(id)
    }
    throw error
  }
}
const queues = new Map<string, Promise<void>>()
export const waitCloudSave = (id: string) => queues.get(id) ?? Promise.resolve()
export function saveCloudSession(session: Session, upload: () => Promise<void>): Promise<void> {
  const capturedToken = useCloud.getState().locks[session.id]?.token
  if (!capturedToken) {
    return Promise.reject(new CloudError(423, '没有此对话的操作权'))
  }
  const task = (queues.get(session.id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const lease = useCloud.getState().locks[session.id]
      if (!lease || lease.token !== capturedToken || !canWrite(session.id)) {
        throw new CloudError(423, '操作权已失效')
      }
      useCloud.setState((state) => ({ saving: { ...state.saving, [session.id]: true } }))
      try {
        await upload()
        const result = await cloudApi<{ revision: number }>(`sessions/${session.id}`, {
          method: 'PUT',
          headers: { 'X-Lock-Token': capturedToken },
          body: JSON.stringify({
            session,
            revision: useCloud.getState().locks[session.id]?.revision ?? lease.revision,
          }),
        })
        if (useCloud.getState().locks[session.id]?.token === capturedToken) {
          useCloud.setState((state) => ({
            locks: {
              ...state.locks,
              [session.id]: { ...state.locks[session.id], revision: result.revision },
            },
            errors: { ...state.errors, [session.id]: '' },
          }))
        }
      } catch (error) {
        // A lost response may have committed. Never retry a stale snapshot against a new revision.
        if (useCloud.getState().locks[session.id]?.token === capturedToken) {
          loseLock(session.id, error instanceof Error ? error.message : '保存失败')
        }
        throw error
      } finally {
        useCloud.setState((state) => ({ saving: { ...state.saving, [session.id]: false } }))
      }
    })
  queues.set(session.id, task)
  void task
    .finally(() => {
      if (queues.get(session.id) === task) {
        queues.delete(session.id)
      }
    })
    .catch(() => {})
  return task
}
export async function releaseSession(id: string) {
  await waitCloudSave(id).catch(() => {})
  const lease = useCloud.getState().locks[id]
  if (!lease) {
    return
  }
  useCloud.setState((state) => ({
    locks: Object.fromEntries(Object.entries(state.locks).filter(([key]) => key !== id)),
  }))
  await cloudApi(`sessions/${id}/lock`, {
    method: 'DELETE',
    headers: { 'X-Lock-Token': lease.token },
  }).catch(() => {})
}
export async function deleteCloudSession(id: string) {
  await waitCloudSave(id).catch(() => {})
  const lease = useCloud.getState().locks[id]
  if (!lease || !canWrite(id)) {
    throw new CloudError(423, '请先取得操作权再删除')
  }
  await cloudApi(`sessions/${id}`, { method: 'DELETE', headers: { 'X-Lock-Token': lease.token } })
  useCloud.setState((state) => ({
    locks: Object.fromEntries(Object.entries(state.locks).filter(([key]) => key !== id)),
  }))
}
const uploaded = new Set<string>()
export async function uploadCloudFile(id: string, blob: Blob) {
  if (uploaded.has(id)) {
    return
  }
  await cloudApi(`files/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
    signal: AbortSignal.timeout(180_000),
  })
  uploaded.add(id)
}
export async function downloadCloudFile(id: string): Promise<Blob | undefined> {
  const response = await fetch(`/api/files/${id}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(180_000),
  })
  if (response.status === 404) {
    return undefined
  }
  if (!response.ok) {
    throw new CloudError(response.status, '附件下载失败')
  }
  uploaded.add(id)
  return response.blob()
}
export function bindLeases() {
  const expire = () => {
    for (const [id, lease] of Object.entries(useCloud.getState().locks)) {
      if (lease.until <= performance.now()) {
        loseLock(id)
      }
    }
  }
  const heartbeat = setInterval(() => {
    expire()
    for (const id of Object.keys(useCloud.getState().locks)) {
      void renewSession(id).catch(() => {})
    }
  }, 20_000)
  const timer = setInterval(expire, 1000)
  const leave = () => {
    for (const [id, lease] of Object.entries(useCloud.getState().locks)) {
      loseLock(id, '页面已挂起，请重新取得操作权')
      void fetch(`/api/sessions/${id}/lock`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'X-Lock-Token': lease.token },
        keepalive: true,
      }).catch(() => {})
    }
  }
  window.addEventListener('pagehide', leave)
  window.addEventListener('focus', expire)
  return () => {
    clearInterval(timer)
    clearInterval(heartbeat)
    window.removeEventListener('pagehide', leave)
    window.removeEventListener('focus', expire)
  }
}
