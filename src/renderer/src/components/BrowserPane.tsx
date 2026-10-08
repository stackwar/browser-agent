import { useCallback, useEffect, useRef, useState } from 'react'
import ControlOverlay from './ControlOverlay'
import { useControl } from '../hooks/useControl'

const DEFAULT_URL = 'https://dev-ss.jushuitan.com'

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_URL
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

interface Props {
  /** 把 <webview> 的 webContents id 交给上层,Agent 用它作为 CDP target */
  onTargetChange: (targetId: number | null) => void
}

export default function BrowserPane({ onTargetChange }: Props) {
  const webviewRef = useRef<HTMLWebViewElement>(null)
  const { control, takeOver, handBack } = useControl()
  const [url, setUrl] = useState(DEFAULT_URL)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return

    const syncNav = (): void => {
      setUrl(wv.getURL())
      setCanBack(wv.canGoBack())
      setCanForward(wv.canGoForward())
    }

    // webContents id 要等 <webview> 真正挂载完(dom-ready)才能取
    const onReady = (): void => {
      onTargetChange(wv.getWebContentsId())
      syncNav()
    }

    wv.addEventListener('dom-ready', onReady)
    wv.addEventListener('did-navigate', syncNav)
    wv.addEventListener('did-navigate-in-page', syncNav)

    return () => {
      wv.removeEventListener('dom-ready', onReady)
      wv.removeEventListener('did-navigate', syncNav)
      wv.removeEventListener('did-navigate-in-page', syncNav)
      onTargetChange(null)
    }
  }, [onTargetChange])

  const go = useCallback((): void => {
    const wv = webviewRef.current
    if (!wv) return
    const target = normalizeUrl(url)
    setUrl(target)
    // 目标与当前地址相同时赋值 src 不会触发导航,这种情况下走 reload
    if (wv.getURL() === target) wv.reload()
    else wv.src = target
  }, [url])

  // agent 操作期间锁住地址栏和导航按钮:用户这时导航会让 agent 手里的
  // 元素编号失效,它下一个动作就会点错地方。
  const locked = control.owner === 'agent'

  return (
    <div className="browser-pane">
      <div className="toolbar">
        <button
          title="后退"
          disabled={!canBack || locked}
          onClick={() => webviewRef.current?.goBack()}
        >
          ←
        </button>
        <button
          title="前进"
          disabled={!canForward || locked}
          onClick={() => webviewRef.current?.goForward()}
        >
          →
        </button>
        <button title="刷新" disabled={locked} onClick={() => webviewRef.current?.reload()}>
          ⟳
        </button>
        <input
          className="url-input"
          value={url}
          spellCheck={false}
          aria-label="地址栏"
          disabled={locked}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
        />
        <button onClick={go} disabled={locked}>
          转到
        </button>
      </div>
      <div className="webview-wrap">
        <webview ref={webviewRef} src={DEFAULT_URL} className="webview" />
        <ControlOverlay
          control={control}
          onTakeOver={() => void takeOver()}
          onHandBack={(note) => void handBack(note)}
        />
      </div>
    </div>
  )
}
