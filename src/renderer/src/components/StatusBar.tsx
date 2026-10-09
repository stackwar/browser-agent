import { useEffect, useState } from 'react'
import type { StatusInfo } from '@shared/types'

interface Props {
  targetId: number | null
}

export default function StatusBar({ targetId }: Props) {
  const [status, setStatus] = useState<StatusInfo | null>(null)

  useEffect(() => {
    window.api.status
      .get()
      .then(setStatus)
      .catch((err) => console.error('获取状态失败', err))
  }, [])

  return (
    <footer className="status-bar">
      <span>内嵌内核: Chromium (Electron)</span>
      <span className="status-sep">·</span>
      <span>
        外部调试端口:{status ? (status.endpoint || '未开启') : '加载中…'}
      </span>
      <span className="status-sep">·</span>
      <span>Agent target: {targetId ?? '未就绪'}</span>
    </footer>
  )
}
