import { clearAllDrafts } from './drafts.js'
import * as db from './db.js'
import {
  newChat,
  refreshCloudSessions,
  prepareHistoryDeletion,
  forgetDeletedSessions,
  retrySaveSessions,
  useChatStore,
} from './store.js'
import {
  cloudApi,
  CloudError,
  deleteCloudSessions,
  listCloudSessions,
  readCloudSession,
  uploadCloudFile,
} from '../cloud/client.js'
import { getPreferences, updatePreferences } from '../settings.js'
import { readPreferences, type Preferences } from '../../../shared/preferences.js'
import { writeArchive } from './history/zipWriter.js'
import { readArchive, readEntry } from './history/zipReader.js'
import type { Session } from './types.js'
import { importKey, hashBytes } from './history/importIdentity.js'
import { useHistoryProgress } from './history/progress.js'
export { BackupError } from './history/errors.js'
let backupQueue: Promise<unknown> = Promise.resolve()
const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}
const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/
const validate = (value: unknown): Session => {
  if (!value || typeof value !== 'object') {
    throw new Error('会话格式无效')
  }
  const s = value as Session
  if (
    !idPattern.test(s.id) ||
    typeof s.title !== 'string' ||
    !Array.isArray(s.messages) ||
    !Number.isFinite(s.createdAt)
  ) {
    throw new Error('会话格式无效')
  }
  const ids = new Set<string>()
  for (const m of s.messages) {
    if (!m || !idPattern.test(m.id) || ids.has(m.id) || !['user', 'assistant'].includes(m.role)) {
      throw new Error('消息格式无效')
    }
    ids.add(m.id)
    if (
      m.role === 'user' &&
      (typeof m.content !== 'string' ||
        !Array.isArray(m.files) ||
        m.files.some((f) => !idPattern.test(f.id) || typeof f.name !== 'string'))
    ) {
      throw new Error('附件格式无效')
    }
    if (m.role === 'assistant') {
      if (!Array.isArray(m.blocks)) {
        throw new Error('回答格式无效')
      }
      if (m.options) {
        readPreferences(m.options)
      }
    }
  }
  if (s.options) {
    readPreferences(s.options)
  }
  return s
}

export const exportHistory = () =>
  enqueueBackup(async () => {
    const { sessions } = await listCloudSessions()
    const entries: { name: string; blob: Blob }[] = [],
      files = new Map<string, string>(),
      missing: string[] = []
    for (const item of sessions) {
      const { session } = await readCloudSession(item.id)
      entries.push({ name: `sessions/${session.id}.json`, blob: json(session) })
      for (const message of session.messages) {
        if (message.role === 'user') {
          for (const file of message.files) {
            files.set(file.id, file.mimeType)
          }
        }
      }
    }
    for (const [id] of files) {
      const blob = await db.loadFile(id)
      if (blob) {
        entries.push({ name: `files/${id}`, blob })
      } else {
        missing.push(id)
      }
    }
    entries.unshift({
      name: 'dsh-manifest.json',
      blob: json({
        format: 'dsh-backup-v1',
        exportedAt: Date.now(),
        settings: getPreferences(),
        sessions: sessions.map((s) => s.id),
        files: Object.fromEntries(files),
        missingOriginals: missing,
      }),
    })
    return {
      name: `dsh-backup-${new Date().toISOString().slice(0, 10)}.zip`,
      blob: await writeArchive(entries),
      missing: missing.length,
    }
  })

export const importHistory = (file: File): Promise<number> =>
  enqueueBackup(async () => {
    if (useChatStore.getState().importingHistory) {
      throw new Error('已有数据操作正在进行')
    }
    useChatStore.setState({ importingHistory: true })
    useHistoryProgress.setState({
      kind: 'import',
      phase: 'parsing',
      name: file.name,
      running: true,
      total: 0,
      completed: 0,
      skipped: 0,
      error: '',
      detail: '正在解析并校验备份…',
      resumable: false,
      pauseRequested: false,
    })
    let preferences: Partial<Preferences> | undefined
    try {
      await db.clearStaging()
      if (file.name.endsWith('.json')) {
        if (file.size > 64 * 1024 * 1024) {
          throw new Error('恢复文件过大')
        }
        const recovery = JSON.parse(await file.text())
        if (recovery.format !== 'dsh-recovery-v1' || !Array.isArray(recovery.sessions)) {
          throw new Error('恢复文件格式无效')
        }
        for (const raw of recovery.sessions) {
          await db.addStagingSession(validate(raw))
        }
      } else {
        let native = false
        for await (const entry of readArchive(file)) {
          native = entry.path === 'dsh-manifest.json'
          break
        }
        if (native) {
          let manifest:
            | { sessions: string[]; files: Record<string, string>; missingOriginals: string[] }
            | undefined
          const seenSessions = new Set<string>(),
            seenFiles = new Set<string>()
          for await (const entry of readArchive(file)) {
            if (entry.path === 'dsh-manifest.json' && !manifest) {
              const data = JSON.parse(await (await readEntry(entry)).text())
              if (
                data.format !== 'dsh-backup-v1' ||
                !Array.isArray(data.sessions) ||
                !data.files ||
                typeof data.files !== 'object'
              ) {
                throw new Error('备份格式无效')
              }
              preferences = readPreferences(data.settings ?? {})
              manifest = {
                sessions: data.sessions,
                files: data.files,
                missingOriginals: data.missingOriginals ?? [],
              }
            } else if (manifest && /^sessions\/[\w-]+\.json$/.test(entry.path)) {
              const session = validate(JSON.parse(await (await readEntry(entry)).text()))
              if (entry.path !== `sessions/${session.id}.json` || seenSessions.has(session.id)) {
                throw new Error('会话条目无效')
              }
              await db.addStagingSession(session)
              seenSessions.add(session.id)
            } else if (manifest && /^files\/[\w-]+$/.test(entry.path)) {
              const id = entry.path.slice(6)
              if (!Object.hasOwn(manifest.files, id) || seenFiles.has(id)) {
                throw new Error('附件条目无效')
              }
              const blob = await readEntry(entry)
              if (blob.size > 100 * 1024 * 1024) {
                throw new Error('附件过大')
              }
              await db.saveStagingFiles([
                { id, blob: new Blob([blob], { type: manifest.files[id] }) },
              ])
              seenFiles.add(id)
            } else {
              throw new Error('备份条目无效')
            }
          }
          if (
            !manifest ||
            manifest.sessions.length !== seenSessions.size ||
            manifest.sessions.some((id) => !seenSessions.has(id)) ||
            Object.keys(manifest.files).some(
              (id) => !seenFiles.has(id) && !manifest?.missingOriginals.includes(id)
            )
          ) {
            throw new Error('备份不完整')
          }
        } else {
          const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
          await checkArchiveFormat(file)
          await importArchive(file, (count) =>
            useHistoryProgress.setState({ detail: `正在解析备份：已读取 ${count} 个对话` })
          )
        }
      }
      const ids = await db.stagingSessionIds()
      for (const id of ids) {
        validate(await db.loadStagingSession(id))
      }
      await db.saveImportCheckpoint({
        id: 'current',
        name: file.name,
        total: ids.length,
        completedIds: [],
        skipped: 0,
        ready: true,
        preferences: preferences ? { ...preferences } : undefined,
      })
      return await runStagedImport()
    } catch (error) {
      const resumable = !!(await db.loadImportCheckpoint())?.ready
      if (!resumable) {
        await db.clearStaging()
      }
      useHistoryProgress.setState({
        phase: 'failed',
        running: false,
        resumable,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      useChatStore.setState({ importingHistory: false })
      await refreshCloudSessions().catch(() => {})
    }
  })

export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    const { sessions } = await listCloudSessions()
    useHistoryProgress.setState({
      kind: 'delete',
      phase: 'deleting',
      total: sessions.length,
      completed: 0,
      skipped: 0,
      error: '',
      detail: '正在分批删除…',
      running: true,
      resumable: false,
    })
    let completed = 0,
      blocked = 0
    try {
      await prepareHistoryDeletion()
      for (let i = 0; i < sessions.length; i += 100) {
        const result = await retryTransfer(() =>
          deleteCloudSessions(sessions.slice(i, i + 100).map((s) => s.id))
        )
        await forgetDeletedSessions(result.deleted)
        completed += result.deleted.length
        blocked += result.blocked.length
        useHistoryProgress.setState({ completed, skipped: blocked })
      }
      if (blocked) {
        throw new Error(
          `已删除 ${completed} 个对话；${blocked} 个正在其他页面操作，请释放操作权后重试`
        )
      }
      await db.clearStaging()
      // Also remove stale local recovery copies for sessions already deleted by another device.
      for (const recovery of await db.loadRecoveries()) {
        await db.clearRecovery(recovery.id)
      }
      clearAllDrafts()
      useHistoryProgress.setState({ phase: 'done', detail: '删除完成' })
    } catch (error) {
      useHistoryProgress.setState({
        phase: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      useChatStore.setState({ importingHistory: false })
      useHistoryProgress.setState({ running: false })
      newChat()
      retrySaveSessions()
      await refreshCloudSessions().catch(() => {})
    }
  })

async function retryTransfer<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (
        attempt >= 3 ||
        (error instanceof CloudError && ![0, 429, 500, 502, 503, 504].includes(error.status))
      ) {
        throw error
      }
      useHistoryProgress.setState({ detail: `网络请求失败，正在重试（${attempt + 1}/3）…` })
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
    }
  }
}

export async function restoreHistoryProgress() {
  if (useHistoryProgress.getState().running) {
    return
  }
  const job = await db.loadImportCheckpoint()
  if (job?.ready && !useHistoryProgress.getState().running) {
    useHistoryProgress.setState({
      kind: 'import',
      name: job.name,
      phase: 'paused',
      total: job.total,
      completed: job.completedIds.length,
      skipped: job.skipped,
      resumable: true,
      detail: '有未完成的导入，可以继续',
      error: '',
    })
  }
}
export const resumeHistoryImport = () =>
  enqueueBackup(async () => {
    useChatStore.setState({ importingHistory: true })
    try {
      return await runStagedImport()
    } finally {
      useChatStore.setState({ importingHistory: false })
      await refreshCloudSessions().catch(() => {})
    }
  })

async function runStagedImport(): Promise<number> {
  const job = await db.loadImportCheckpoint()
  if (!job?.ready) {
    throw new Error('没有可继续的导入，请重新选择备份')
  }
  useHistoryProgress.setState({
    kind: 'import',
    phase: 'uploading',
    name: job.name,
    running: true,
    resumable: true,
    pauseRequested: false,
    total: job.total,
    completed: job.completedIds.length,
    skipped: job.skipped,
    error: '',
    detail: '正在同步对话与附件…',
  })
  try {
    const ids = await db.stagingSessionIds()
    const existing = new Set(
      (await retryTransfer(() => cloudApi<{ items: { key: string }[] }>('imports'))).items.map(
        (i) => i.key
      )
    )
    const fileTasks = new Map<string, Promise<string>>()
    const fileId = (oldId: string) => {
      let task = fileTasks.get(oldId)
      if (!task) {
        task = (async () => {
          const blob = (await db.loadStagingFile(oldId)) ?? (await db.loadLocalFile(oldId))
          if (!blob) {
            return 'missing-' + (await hashBytes(new TextEncoder().encode(oldId).buffer))
          }
          const id = 'import-' + (await hashBytes(await blob.arrayBuffer()))
          await retryTransfer(async () => {
            const head = await fetch(`/api/files/${id}`, {
              method: 'HEAD',
              cache: 'no-store',
              credentials: 'same-origin',
              signal: AbortSignal.timeout(30_000),
            })
            if (head.status === 404) {
              await uploadCloudFile(id, blob)
            } else if (!head.ok) {
              throw new CloudError(head.status, `附件检查失败（${head.status}）`)
            }
          })
          return id
        })()
        fileTasks.set(oldId, task)
      }
      return task
    }
    let cursor = 0,
      failure: unknown
    const done = async (sourceIds: string[], skipped: string[]) => {
      const checkpoint = await db.completeImportItems(sourceIds, skipped)
      useHistoryProgress.setState({
        completed: checkpoint.completedIds.length,
        skipped: checkpoint.skipped,
        detail: useHistoryProgress.getState().pauseRequested
          ? '正在完成当前批次，随后暂停…'
          : '正在同步对话与附件…',
      })
    }
    const worker = async () => {
      while (cursor < ids.length && !failure && !useHistoryProgress.getState().pauseRequested) {
        const batchIds = ids.slice(cursor, cursor + 5)
        cursor += batchIds.length
        try {
          let batch: { key: string; session: Session; sourceId: string }[] = [],
            size = 0
          const send = async () => {
            if (!batch.length) {
              return
            }
            const items = batch.map(({ key, session }) => ({ key, session }))
            const result = await retryTransfer(() =>
              cloudApi<{ items: { key: string; id: string; created: number }[] }>('imports', {
                method: 'POST',
                body: JSON.stringify({ items }),
              })
            )
            if (result.items.length !== batch.length) {
              throw new Error('未能确认整批导入结果，可以安全重试')
            }
            await done(
              batch.map((i) => i.sourceId),
              batch
                .filter((i) => !result.items.find((r) => r.key === i.key)?.created)
                .map((i) => i.sourceId)
            )
            for (const item of batch) {
              existing.add(item.key)
            }
            batch = []
            size = 0
          }
          for (const sourceId of batchIds) {
            const original = validate(await db.loadStagingSession(sourceId))
            const key = await importKey(original)
            if (existing.has(key)) {
              await done([sourceId], [sourceId])
              continue
            }
            const session = structuredClone(original)
            session.id = crypto.randomUUID()
            for (const message of session.messages) {
              if (
                message.role === 'assistant' &&
                ['pending', 'streaming'].includes(message.status)
              ) {
                message.status = 'stopped'
              }
              if (message.role === 'user') {
                for (const file of message.files) {
                  file.id = await fileId(file.id)
                  file.serverId = null
                }
              }
            }
            const bytes = new Blob([JSON.stringify(session)]).size
            if (size + bytes > 512 * 1024) {
              await send()
            }
            batch.push({ key, session, sourceId })
            size += bytes
          }
          await send()
        } catch (error) {
          failure ??= error
        }
      }
    }
    // Bounded concurrency keeps mobile memory and provider request volume predictable.
    await Promise.all([worker(), worker(), worker()])
    if (failure) {
      throw failure
    }
    const completed = (await db.loadImportCheckpoint())?.completedIds.length ?? 0
    if (completed < ids.length) {
      useHistoryProgress.setState({ phase: 'paused', detail: '已暂停，已完成的内容不会重复导入' })
      return completed
    }
    if (job.preferences) {
      updatePreferences(readPreferences(job.preferences))
    }
    await db.clearStaging()
    useHistoryProgress.setState({ phase: 'done', resumable: false, detail: '导入完成' })
    return completed
  } catch (error) {
    useHistoryProgress.setState({
      phase: 'failed',
      resumable: true,
      error: error instanceof Error ? error.message : String(error),
      detail: '已保存进度，可以继续导入',
    })
    throw error
  } finally {
    useHistoryProgress.setState({ running: false, pauseRequested: false })
  }
}
