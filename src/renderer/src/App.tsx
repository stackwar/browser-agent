import { useCallback, useEffect, useRef, useState } from 'react'
import { Modal } from 'antd'
import ChatPanel from './components/ChatPanel'
import BrowserPane from './components/BrowserPane'
import StatusBar from './components/StatusBar'
import { usePanelWidth } from './hooks/usePanelWidth'
import { applyTheme } from './theme'

export default function App() {
  // <webview> 的 webContents id:Agent 的 CDP target
  const [targetId, setTargetId] = useState<number | null>(null)
  const onTargetChange = useCallback((id: number | null) => setTargetId(id), [])
  const panel = usePanelWidth()

  // 启动时按设置应用主题(默认深色)
  useEffect(() => {
    void window.api.settings
      .get()
      .then((info) => applyTheme(info.theme))
      .catch(() => applyTheme('dark'))
  }, [])

  // 启动时检查更新:有新版本就提示去下载(清单缺失 / 网络失败则静默)。
  // 开发态跳过(版本是占位 0.1.0,且 StrictMode 会重复触发);只执行一次。
  const updateChecked = useRef(false)
  useEffect(() => {
    if (import.meta.env.DEV) return
    if (updateChecked.current) return
    updateChecked.current = true
    void window.api.update
      .check()
      .then((info) => {
        if (info.hasUpdate && info.url) {
          Modal.confirm({
            title: `发现新版本 ${info.latestVersion}`,
            content: info.notes || `当前版本 ${info.currentVersion},有新版本可用。`,
            okText: '前往下载',
            cancelText: '以后再说',
            onOk: () => window.api.update.openDownload(info.url)
          })
        }
      })
      .catch(() => void 0)
  }, [])

  return (
    // 拖动期间整棵树加 resizing:拿它屏掉 webview 的命中测试,
    // 否则指针进到 webview 里就不再回传事件,拖动会断。
    <div className={`app${panel.dragging ? ' resizing' : ''}`}>
      <ChatPanel targetId={targetId} width={panel.width} />
      <div
        className="splitter"
        onPointerDown={panel.onPointerDown}
        onKeyDown={panel.onKeyDown}
        // 双击回到默认宽度是这类分隔条的通用约定
        onDoubleClick={panel.reset}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整聊天面板宽度"
        aria-valuenow={panel.width}
        aria-valuemin={panel.min}
        aria-valuemax={panel.max}
        tabIndex={0}
      />
      <div className="workspace">
        <BrowserPane onTargetChange={onTargetChange} />
        <StatusBar targetId={targetId} />
      </div>
    </div>
  )
}
