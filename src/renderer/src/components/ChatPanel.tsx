import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Image } from 'antd'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
// 只引入 Image 自己的样式,不走 css.js —— 它会连带引入 antd 的全局 reset
// (default.css),把这套手写深色主题冲掉。预览浮层所需的类都在 index.css 里。
import 'antd/es/image/style/index.css'
import type { ImageAttachment, RunState, RunStep } from '@shared/types'
import { useRun } from '../hooks/useRun'
import { useAttachments } from '../hooks/useAttachments'
import StepList from './StepList'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 用户消息附带的图片缩略图。只存 object URL,base64 发完就不留了。 */
  thumbs?: { id: string; url: string; name: string }[]
  /** 助手消息附带的步骤轨迹快照(run 结束时定格) */
  steps?: RunStep[]
  status?: RunState['status']
}

let seq = 0
const nextId = (): string => `m-${Date.now()}-${seq++}`

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`

/** run 的收尾文案:成功用 summary,中断和失败给明确提示 */
function outcomeText(run: RunState): string {
  if (run.status === 'aborted') return '已停止。'
  if (run.status === 'error') return `执行失败:${run.error ?? '未知错误'}`
  return run.summary ?? '完成。'
}

interface Props {
  targetId: number | null
  /** 由 App 的分隔条控制,写成行内样式盖掉 CSS 里的默认宽度 */
  width: number
}

const GREETING =
  '你好,我是浏览器 Agent 助手。发消息后我会观察右侧页面并汇报看到的内容,执行过程中可以随时停止。'

/**
 * markdown 里的链接不能用默认行为点开 —— 在 Electron 渲染层里 `<a href>`
 * 的默认导航会把整个应用窗口带走,直接白屏。拦下来,用系统默认方式新开一个窗口。
 */
const mdComponents: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) window.open(href, '_blank', 'noopener,noreferrer')
      }}
    >
      {children}
    </a>
  )
}

/** 会话气泡正文:按 markdown 渲染(GFM:表格、删除线、任务列表等) */
function Markdown({ children }: { children: string }): ReactNode {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
      {children}
    </ReactMarkdown>
  )
}

export default function ChatPanel({ targetId, width }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { id: '0', role: 'assistant', content: GREETING }
  ])
  const [input, setInput] = useState('')
  const { run, busy, start, abort, reset } = useRun()
  const attachments = useAttachments()
  const [vision, setVision] = useState(true)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // run 已被归档进消息列表,避免 StrictMode 下重复 effect 触发两次归档
  const archived = useRef<string | null>(null)

  // 新消息 / 新步骤时贴住底部
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, run])

  // run 结束后把轨迹和结论定格成一条助手消息
  useEffect(() => {
    if (!run || run.status === 'running') return
    if (archived.current === run.id) return
    archived.current = run.id

    setMessages((m) => [
      ...m,
      {
        id: nextId(),
        role: 'assistant',
        content: outcomeText(run),
        steps: run.steps,
        status: run.status
      }
    ])
    reset()
  }, [run, reset])

  // 模型是否读图决定附图入口是否可用。模型由环境变量定,启动后不会变,问一次就够。
  useEffect(() => {
    void window.api.session
      .info()
      .then((info) => setVision(info.vision))
      .catch(() => setVision(false))
  }, [])

  const pickFiles = useCallback(
    (list: FileList | null): void => {
      if (!list || list.length === 0) return
      void attachments.add([...list].filter((f) => f.type.startsWith('image/')))
    },
    [attachments]
  )

  // 粘贴截图是最顺手的入口,优先支持。剪贴板里没图时不拦默认行为,
  // 否则会把正常的文字粘贴也吃掉。
  const onPaste = useCallback(
    (e: React.ClipboardEvent): void => {
      if (!vision || busy) return
      const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
      if (files.length === 0) return
      e.preventDefault()
      void attachments.add(files)
    },
    [vision, busy, attachments]
  )

  const onDrop = useCallback(
    (e: React.DragEvent): void => {
      e.preventDefault()
      setDragging(false)
      if (!vision || busy) return
      pickFiles(e.dataTransfer.files)
    },
    [vision, busy, pickFiles]
  )

  /** 清空历史:主进程的会话记录和这里的消息列表要一起清,否则两边对不上 */
  const clearHistory = useCallback(async (): Promise<void> => {
    await window.api.session.clear()
    attachments.clear()
    setMessages([{ id: nextId(), role: 'assistant', content: `${GREETING}\n(历史已清空)` }])
  }, [attachments])

  const send = async (): Promise<void> => {
    const text = input.trim()
    const images: ImageAttachment[] = attachments.payload()
    // 只有图没有字也算一条有效消息 —— 「看看这张图」是常见用法
    if ((!text && images.length === 0) || busy) return

    const thumbs = attachments.images.map((img) => ({
      id: img.id,
      url: img.previewUrl,
      name: img.name
    }))
    const bubble = text || '(只发了图片)'

    if (targetId === null) {
      setMessages((m) => [
        ...m,
        { id: nextId(), role: 'user', content: bubble, thumbs },
        { id: nextId(), role: 'assistant', content: '浏览器还没准备好,等右侧页面加载完成后再试。' }
      ])
      setInput('')
      return
    }

    setMessages((m) => [...m, { id: nextId(), role: 'user', content: bubble, thumbs }])
    setInput('')
    // 预览 URL 还要给消息气泡用,所以这里只摘掉待发列表,不释放 URL
    attachments.detach()

    try {
      await start({ prompt: text || '看看这些图片,按图片里的内容判断该做什么。', targetId, images })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMessages((m) => [...m, { id: nextId(), role: 'assistant', content: `启动失败:${msg}` }])
    }
  }

  const canSend = targetId !== null && (input.trim().length > 0 || attachments.images.length > 0)

  return (
    <aside
      className={`chat-panel${dragging ? ' dropping' : ''}`}
      style={{ width }}
      onDragOver={(e) => {
        if (!vision || busy) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="chat-header">
        <span>Agent 对话</span>
        <button
          className="ghost"
          title="清空会话历史"
          disabled={busy}
          onClick={() => void clearHistory()}
        >
          清空历史
        </button>
      </header>

      <div className="messages" ref={scrollRef}>
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className={`bubble${m.status && m.status !== 'done' ? ` bubble-${m.status}` : ''}`}>
              {m.steps && m.steps.length > 0 && <StepList steps={m.steps} />}
              {m.thumbs && m.thumbs.length > 0 && (
                <div className="bubble-thumbs">
                  <Image.PreviewGroup>
                    {m.thumbs.map((t) => (
                      <Image
                        key={t.id}
                        src={t.url}
                        alt={t.name}
                        title={t.name}
                        width={72}
                        height={72}
                        // 默认遮罩是英文「Preview」,换成中文
                        preview={{ mask: '预览' }}
                      />
                    ))}
                  </Image.PreviewGroup>
                </div>
              )}
              <div className="bubble-text">
                <Markdown>{m.content}</Markdown>
              </div>
            </div>
          </div>
        ))}

        {/* 进行中的 run:步骤实时追加 */}
        {run && run.status === 'running' && (
          <div className="msg assistant">
            <div className="bubble">
              <StepList steps={run.steps} />
              {run.steps.length === 0 && <div className="bubble-text">正在启动…</div>}
            </div>
          </div>
        )}
      </div>

      {attachments.images.length > 0 && (
        <div className="tray">
          {attachments.images.map((img) => (
            <div className="tray-item" key={img.id}>
              <img src={img.previewUrl} alt={img.name} title={`${img.name}(${kb(img.bytes)})`} />
              <button
                className="tray-remove"
                aria-label={`移除 ${img.name}`}
                onClick={() => attachments.remove(img.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {attachments.rejected && <div className="tray-note">{attachments.rejected}</div>}

      <div className="composer">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          hidden
          onChange={(e) => {
            pickFiles(e.target.files)
            // 同一个文件再次选择也要触发 change,清掉 value 才行
            e.target.value = ''
          }}
        />
        <button
          className="ghost attach"
          title={
            vision ? '附加图片(也可直接粘贴或拖入)' : '当前模型不支持读图,无法附加图片'
          }
          aria-label="附加图片"
          disabled={busy || !vision || attachments.full}
          onClick={() => fileRef.current?.click()}
        >
          🖼
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          aria-label="给 Agent 的指令"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={busy ? '执行中,可点击停止…' : '输入消息,让 Agent 操作浏览器…'}
          rows={2}
          disabled={busy}
        />
        {busy ? (
          <button className="stop" onClick={() => void abort()}>
            停止
          </button>
        ) : (
          <button onClick={() => void send()} disabled={!canSend}>
            发送
          </button>
        )}
      </div>
    </aside>
  )
}
