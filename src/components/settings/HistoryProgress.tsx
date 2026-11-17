import { pauseHistoryImport, useHistoryProgress } from '../../services/chat/history/progress.js'
import { resumeHistoryImport } from '../../services/chat/backup.js'
import { openSettings } from './settingsDialogState.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

export const HistoryProgress = ({ compact = false }: { compact?: boolean }) => {
  const state = useHistoryProgress()
  if (state.phase === 'idle' || (compact && state.phase === 'done')) {
    return null
  }
  const label = state.kind === 'delete' ? '删除记录' : '导入记录'
  return (
    <div className={styles.historyProgress} role="status" aria-live="polite">
      <div>
        {label} ·{' '}
        {state.total
          ? `${state.completed.toLocaleString()} / ${state.total.toLocaleString()}`
          : '准备中'}
      </div>
      {!compact && (
        <>
          {state.name && state.kind === 'import' ? <small>{state.name}</small> : null}
          <progress
            aria-label={`${label}进度`}
            max={state.total || 1}
            value={state.total ? state.completed : undefined}
          />
          <div>{state.detail}</div>
          {state.skipped > 0 ? (
            <small>
              {state.kind === 'import'
                ? `已跳过 ${state.skipped} 个重复对话`
                : `${state.skipped} 个对话正在其他页面操作`}
            </small>
          ) : null}
          {state.error ? <div role="alert">{state.error}</div> : null}
          {state.running && state.kind === 'import' ? (
            <small>请保持页面打开；需要离开时可暂停，稍后继续。</small>
          ) : null}
        </>
      )}
      <div className={styles.historyActions}>
        {compact ? (
          <Button variant="outlined" size="s" onClick={() => openSettings('data')}>
            查看进度
          </Button>
        ) : (
          <>
            {state.phase === 'uploading' && state.running ? (
              <Button
                variant="outlined"
                size="s"
                disabled={state.pauseRequested}
                onClick={pauseHistoryImport}
              >
                暂停导入
              </Button>
            ) : null}
            {state.resumable && !state.running ? (
              <Button
                variant="outlined"
                size="s"
                onClick={() =>
                  void resumeHistoryImport().catch((error: unknown) =>
                    showToast(error instanceof Error ? error.message : '导入失败')
                  )
                }
              >
                继续导入
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
