import { confirmAction } from '../base/ConfirmAction.js'
import { useState } from 'react'
import { canWrite, useCloud } from '../../services/cloud/client.js'
import { takeSessionControl } from '../../services/chat/store.js'
import { loadRecoveries } from '../../services/chat/db.js'
import './cloud.css'

export async function exportRecoveries() {
  const sessions = await loadRecoveries()
  const blob = new Blob([JSON.stringify({ format: 'dsh-recovery-v1', sessions }, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'dsh-recovery.json'
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
export function CloudStatus({ id }: { id: string }) {
  const cloud = useCloud()
  const [taking, setTaking] = useState(false)
  const writable = canWrite(id)
  return (
    <div className={`cloud-status ${writable ? '' : 'cloud-readonly'}`} role="status">
      <span>
        {cloud.busy[id] || taking
          ? '正在取得操作权…'
          : writable
            ? cloud.saving[id]
              ? '此设备操作中 · 正在保存'
              : '此设备操作中 · 已同步'
            : cloud.owners[id]
              ? `只读 · ${cloud.owners[id]} 正在操作`
              : '只读 · 尚未取得操作权'}
      </span>
      {cloud.errors[id] && <span className="cloud-error">{cloud.errors[id]}</span>}
      {!writable && (
        <button
          disabled={taking || cloud.busy[id] || !cloud.online}
          onClick={async () => {
            if (
              cloud.owners[id] &&
              !(await confirmAction(
                '接管后，另一端将失去操作权；其尚未同步的内容只能在原设备恢复。继续？'
              ))
            ) {
              return
            }
            setTaking(true)
            try {
              await takeSessionControl(id, !!cloud.owners[id])
            } finally {
              setTaking(false)
            }
          }}
        >
          在此设备操作
        </button>
      )}
      {cloud.errors[id] && <button onClick={() => void exportRecoveries()}>导出恢复副本</button>}
    </div>
  )
}
