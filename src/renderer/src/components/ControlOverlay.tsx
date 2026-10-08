import { useState } from 'react'
import type { ControlState } from '@shared/types'

/**
 * 控制权覆盖层。盖在 <webview> 上面,职责有两个:
 *
 * 1. agent 操作期间挡住用户的鼠标输入 —— 两边同时点会互相打断焦点。
 * 2. 作为接管入口:点遮罩就是「我要自己来」。
 *
 * 用户持有控制权时遮罩必须让开(pointer-events: none),否则他点不到页面。
 * 这时只留一条顶部横幅显示状态和交还按钮。
 */

interface Props {
  control: ControlState
  onTakeOver: () => void
  onHandBack: (note?: string) => void
}

export default function ControlOverlay({ control, onTakeOver, onHandBack }: Props) {
  const [note, setNote] = useState('')

  if (control.owner === 'idle') return null

  if (control.owner === 'manual') {
    const submit = (): void => {
      onHandBack(note.trim() || undefined)
      setNote('')
    }

    return (
      <div className="control-banner manual">
        <div className="control-banner-text">
          {control.reason === 'agent-request' ? (
            <>
              <strong>Agent 请求你处理</strong>
              {control.message && <span className="control-reason">{control.message}</span>}
            </>
          ) : (
            <strong>你正在操作浏览器</strong>
          )}
        </div>
        {/* 这句说明会带给模型 —— 它看不到用户在页面上做了什么 */}
        <input
          className="control-note"
          value={note}
          placeholder={control.runId ? '可选:告诉 Agent 你做了什么' : ''}
          aria-label="交还控制权时给 Agent 的说明"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          disabled={!control.runId}
        />
        <button onClick={submit}>
          {control.runId ? (control.agentWaiting ? '交还给 Agent(等待中)' : '交还给 Agent') : '完成'}
        </button>
      </div>
    )
  }

  // owner === 'agent':盖住整个浏览器区域
  return (
    <div
      className="control-overlay"
      role="button"
      tabIndex={0}
      title="Agent 正在操作,点击接管"
      onClick={onTakeOver}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onTakeOver()
        }
      }}
    >
      <div className="control-overlay-badge">
        <span className="control-dot" aria-hidden="true" />
        Agent 正在操作浏览器
        <span className="control-hint">点击接管</span>
      </div>
    </div>
  )
}
