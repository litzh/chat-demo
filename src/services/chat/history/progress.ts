import { create } from 'zustand'
export const useHistoryProgress = create(() => ({
  kind: 'import' as 'import' | 'delete',
  phase: 'idle' as 'idle' | 'parsing' | 'uploading' | 'paused' | 'failed' | 'done' | 'deleting',
  name: '',
  total: 0,
  completed: 0,
  skipped: 0,
  error: '',
  detail: '',
  running: false,
  resumable: false,
  pauseRequested: false,
}))
export const pauseHistoryImport = () =>
  useHistoryProgress.setState({ pauseRequested: true, detail: '正在完成当前批次，随后暂停…' })
