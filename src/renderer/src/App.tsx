import { useCallback, useState } from 'react'
import ChatPanel from './components/ChatPanel'
import BrowserPane from './components/BrowserPane'
import StatusBar from './components/StatusBar'
import { usePanelWidth } from './hooks/usePanelWidth'

export default function App() {
  // <webview> 的 webContents id:Agent 的 CDP target
  const [targetId, setTargetId] = useState<number | null>(null)
  const onTargetChange = useCallback((id: number | null) => setTargetId(id), [])
  const panel = usePanelWidth()

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
