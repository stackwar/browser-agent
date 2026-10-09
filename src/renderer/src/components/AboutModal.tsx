import { useCallback, useEffect, useState } from 'react'
import { Button, Modal, Tag, message } from 'antd'
import type { UpdateInfo } from '@shared/types'
import logo from '../assets/logo.png'

interface Props {
  open: boolean
  onClose: () => void
}

/** 关于弹窗:应用图标 / 名称 / 版本,以及检查更新入口 */
export default function AboutModal({ open, onClose }: Props) {
  const [upd, setUpd] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)

  // 打开时拉一次(拿到当前版本 + 是否有更新)
  useEffect(() => {
    if (open) void window.api.update.check().then(setUpd).catch(() => void 0)
  }, [open])

  const check = useCallback(async (): Promise<void> => {
    setChecking(true)
    try {
      const info = await window.api.update.check()
      setUpd(info)
      if (info.hasUpdate) message.info(`发现新版本 v${info.latestVersion}`)
      else if (info.error) message.warning('检查更新失败,请稍后再试')
      else message.success(`已是最新版本 v${info.currentVersion}`)
    } finally {
      setChecking(false)
    }
  }, [])

  return (
    <Modal title="关于" open={open} onCancel={onClose} footer={null} width={360}>
      <div style={{ textAlign: 'center', padding: '8px 0 4px' }}>
        <img src={logo} alt="聚运赢" width={72} height={72} style={{ borderRadius: 16 }} />
        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 10 }}>聚运赢</div>
        <div style={{ color: '#999', marginTop: 2 }}>
          版本 v{upd?.currentVersion ?? '—'}
          {upd?.hasUpdate && <Tag color="green" style={{ marginLeft: 8 }}>有新版本</Tag>}
        </div>

        <div style={{ marginTop: 16 }}>
          <Button loading={checking} onClick={() => void check()}>
            检查更新
          </Button>
        </div>

        {upd?.hasUpdate && upd.url && (
          <div style={{ marginTop: 10 }}>
            <Button type="primary" onClick={() => void window.api.update.openDownload(upd.url)}>
              下载新版本 v{upd.latestVersion}
            </Button>
            {upd.notes && <div style={{ color: '#999', fontSize: 12, marginTop: 6 }}>{upd.notes}</div>}
          </div>
        )}

        <div style={{ color: '#999', fontSize: 12, marginTop: 18 }}>© 聚水潭 · 聚运赢</div>
      </div>
    </Modal>
  )
}
