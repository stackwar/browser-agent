import { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { Button, Image, Tooltip, message } from 'antd'
import {
  ClearOutlined,
  PaperClipOutlined,
  SendOutlined,
  StopOutlined
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { FileAttachment, ImageAttachment, RunState, RunStep, SessionMeta } from '@shared/types'
import { useRun } from '../hooks/useRun'
import { useAttachments } from '../hooks/useAttachments'
import { useFiles } from '../hooks/useFiles'
import { loadMessages, removeMessages, saveMessages } from '../sessionStore'
import StepList from './StepList'
import CollapsibleSteps from './CollapsibleSteps'
import SettingsModal from './SettingsModal'
import WelcomeHero from './WelcomeHero'
import TracePanel from './TracePanel'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 用户消息附带的图片缩略图。只存 object URL,base64 发完就不留了。 */
  thumbs?: { id: string; url: string; name: string }[]
  /** 用户消息附带的文档名单(仅展示名称) */
  files?: { id: string; name: string }[]
  /** 助手消息附带的步骤轨迹快照(run 结束时定格) */
  steps?: RunStep[]
  status?: RunState['status']
}

let seq = 0
const nextId = (): string => `m-${Date.now()}-${seq++}`

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`

/**
 * 把 http 图片链接升到 https。
 *
 * CSP 的 img-src 只放行 https/data/blob;历史(localStorage)里可能残留早期
 * 存下的 http COS 链接 —— 直接渲染会被拦成裂图,这里统一升一下。data/blob 不受影响。
 */
const httpsify = (u: string): string => (u.startsWith('http://') ? `https://${u.slice(7)}` : u)

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
  /** 会话列表 / 活动会话变化时通知外层(左侧栏据此刷新) */
  onSessionsChanged?: (sessions: SessionMeta[], activeId: string) => void
}

/** 暴露给左侧栏调用的命令式接口 */
export interface ChatPanelHandle {
  newSession: () => void
  selectSession: (id: string) => void
  deleteSession: (id: string) => void
  openSettings: () => void
}

const GREETING =
  '你好,我是聚运赢客户端 Agent 助手'

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

const ChatPanel = forwardRef<ChatPanelHandle, Props>(function ChatPanel(
  { targetId, width, onSessionsChanged },
  ref
) {
  const [messages, setMessages] = useState<Message[]>([
    { id: '0', role: 'assistant', content: GREETING }
  ])
  const [input, setInput] = useState('')
  const { run, busy, streamingText, start, abort, reset } = useRun()
  const attachments = useAttachments()
  const docs = useFiles()
  const [vision, setVision] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [view, setView] = useState<'chat' | 'trace'>('chat')
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // run 已被归档进消息列表,避免 StrictMode 下重复 effect 触发两次归档
  const archived = useRef<string | null>(null)
  // 当前会话 id 的同步副本:持久化 effect 读它来决定写进哪个会话的 localStorage。
  // 必须在 setMessages 之前同步更新,否则切换时会把新会话的消息写进旧会话。
  const sessionIdRef = useRef<string>('')

  /** 拉取会话列表与当前活动 id(侧栏用,不动消息区) */
  const refreshSessions = useCallback(async (): Promise<void> => {
    const [list, info] = await Promise.all([window.api.session.list(), window.api.session.info()])
    setSessions(list)
    setActiveId(info.activeId)
    onSessionsChanged?.(list, info.activeId)
  }, [onSessionsChanged])

  /**
   * 把某会话载入消息区。优先用渲染层持久化的展示记录(含缩略图),
   * 没有再回退到主进程的文本 transcript;都没有就显示问候语。
   */
  const loadSession = useCallback(async (id: string): Promise<void> => {
    // 先同步切 ref,保证随后的持久化写进这个会话
    sessionIdRef.current = id
    const local = loadMessages(id)
    if (local && local.length > 0) {
      setMessages(
        local.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          thumbs: m.thumbs,
          files: m.files,
          steps: m.steps,
          status: m.status
        }))
      )
      return
    }
    const items = await window.api.session.transcript(id)
    setMessages(
      items.length === 0
        ? [{ id: nextId(), role: 'assistant', content: GREETING }]
        : items.map((it) => ({ id: nextId(), role: it.role, content: it.content }))
    )
  }, [])

  const newSession = useCallback(async (): Promise<void> => {
    if (busy) return
    const meta = await window.api.session.create()
    attachments.clear()
    sessionIdRef.current = meta.id
    setMessages([{ id: nextId(), role: 'assistant', content: GREETING }])
    await refreshSessions()
    setActiveId(meta.id)
  }, [busy, attachments, refreshSessions])

  const selectSession = useCallback(
    async (id: string): Promise<void> => {
      if (busy || id === activeId) return
      const res = await window.api.session.activate(id)
      if (!res.ok) return
      attachments.clear()
      await loadSession(id)
      await refreshSessions()
    },
    [busy, activeId, attachments, loadSession, refreshSessions]
  )

  const deleteSession = useCallback(
    async (id: string): Promise<void> => {
      if (busy) return
      const wasActive = id === activeId
      await window.api.session.remove(id)
      removeMessages(id)
      await refreshSessions()
      // 删掉的是当前会话时,主进程已把活动指针挪到别的会话,这里跟着回放它
      if (wasActive) {
        const info = await window.api.session.info()
        await loadSession(info.activeId)
      }
    },
    [busy, activeId, loadSession, refreshSessions]
  )

  // 暴露给左侧栏:新建 / 切换 / 删除会话
  useImperativeHandle(
    ref,
    () => ({ newSession, selectSession, deleteSession, openSettings: () => setSettingsOpen(true) }),
    [newSession, selectSession, deleteSession]
  )

  // 消息区变化就把展示记录(文字 + 缩略图)写进当前会话的 localStorage,
  // 这样切换会话、重启后卡片里的图片都还在。空 id(未初始化)时跳过。
  useEffect(() => {
    const id = sessionIdRef.current
    if (!id) return
    saveMessages(
      id,
      messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        thumbs: m.thumbs,
        files: m.files,
        steps: m.steps,
        status: m.status
      }))
    )
  }, [messages])

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
    void refreshSessions()
  }, [run, reset, refreshSessions])

  // 启动时:读模型能力、会话列表,并回放当前活动会话。
  // 模型由环境变量定,启动后不会变,问一次就够。
  useEffect(() => {
    void (async () => {
      try {
        const info = await window.api.session.info()
        setVision(info.vision)
        setActiveId(info.activeId)
        const list = await window.api.session.list()
        setSessions(list)
        onSessionsChanged?.(list, info.activeId)
        await loadSession(info.activeId)
      } catch {
        setVision(false)
      }
    })()
  }, [loadSession])

  const pickFiles = useCallback(
    (list: FileList | null): void => {
      if (!list || list.length === 0) return
      const arr = [...list]
      const imgs = arr.filter((f) => f.type.startsWith('image/'))
      const others = arr.filter((f) => !f.type.startsWith('image/'))
      if (imgs.length > 0 && vision) void attachments.add(imgs)
      if (others.length > 0) void docs.add(others)
    },
    [attachments, docs, vision]
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
      if (busy) return
      pickFiles(e.dataTransfer.files)
    },
    [vision, busy, pickFiles]
  )

  /** 清空当前会话:主进程的会话记录和这里的消息列表要一起清,否则两边对不上 */
  const clearHistory = useCallback(async (): Promise<void> => {
    await window.api.session.clear()
    attachments.clear()
    removeMessages(sessionIdRef.current)
    setMessages([{ id: nextId(), role: 'assistant', content: `${GREETING}\n(历史已清空)` }])
    await refreshSessions()
  }, [attachments, refreshSessions])

  const send = async (override?: string): Promise<void> => {
    const text = (override ?? input).trim()
    const pend = attachments.images
    const pendFiles = docs.files
    // 有字 / 有图 / 有文件,任一即可发送
    if ((!text && pend.length === 0 && pendFiles.length === 0) || busy || uploading) return

    // 先把图片传到 COS(集成 cos-image-upload skill)。
    // 失败不致命:退回 base64 + 本地缩略图,功能照常。
    let urls: (string | null)[] = []
    if (pend.length > 0) {
      setUploading(true)
      urls = await Promise.all(
        pend.map(async (img) => {
          try {
            const r = await window.api.upload.image({
              name: img.name,
              mediaType: img.mediaType,
              data: img.data
            })
            return r.url
          } catch {
            return null
          }
        })
      )
      setUploading(false)
    }

    const images: ImageAttachment[] = pend.map((img, i) => ({
      name: img.name,
      mediaType: img.mediaType,
      data: img.data,
      url: urls[i] ?? undefined
    }))
    // 卡片缩略图用**本地**缩略图 data URL 显示,不用 COS 远程链接 ——
    // 远程图受 CDN 防盗链 / Referer / 网络影响,渲染层里时好时坏;本地 data URL
    // 必然能显示、也不吃网络。COS 链接只进模型载荷(images[].url,更省 token)。
    const thumbs = pend.map((img) => ({
      id: img.id,
      url: img.thumbUrl || img.previewUrl,
      name: img.name
    }))
    const fileChips = pendFiles.map((f) => ({ id: f.id, name: f.name }))
    const filesPayload: FileAttachment[] = docs.payload()
    // 只发图片时气泡不显示占位文案,只展示图片;给模型的 prompt 仍另给默认指令
    const bubble = text

    if (targetId === null) {
      setMessages((m) => [
        ...m,
        { id: nextId(), role: 'user', content: bubble, thumbs, files: fileChips },
        { id: nextId(), role: 'assistant', content: '浏览器还没准备好,等右侧页面加载完成后再试。' }
      ])
      setInput('')
      attachments.detach()
      docs.clear()
      return
    }

    setMessages((m) => [...m, { id: nextId(), role: 'user', content: bubble, thumbs, files: fileChips }])
    setInput('')
    // 气泡用的是 COS 链接或缩略图 data URL(都已持久化);object URL 仅作兜底,
    // 可能还被引用,所以这里只摘掉待发列表、不主动释放。
    attachments.detach()
    docs.clear()

    try {
      await start({
        prompt: text || '处理我上传的附件/图片,按其内容判断该做什么。',
        targetId,
        images,
        files: filesPayload
      })
      void refreshSessions()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setMessages((m) => [...m, { id: nextId(), role: 'assistant', content: `启动失败:${msg}` }])
    }
  }

  const canSend =
    targetId !== null &&
    (input.trim().length > 0 || attachments.images.length > 0 || docs.files.length > 0)

  // 新会话欢迎页:还没有任何用户消息、且不在跑/流式时,中栏显示预制指令
  const showHero =
    view === 'chat' && !busy && !streamingText && !messages.some((m) => m.role === 'user')

  return (
    <aside
      className={`chat-panel${dragging ? ' dropping' : ''}`}
      style={{ width }}
      onDragOver={(e) => {
        if (busy) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <header className="chat-header">
        <span className="chat-title" title={sessions.find((s) => s.id === activeId)?.title}>
          {sessions.find((s) => s.id === activeId)?.title ?? 'Agent 对话'}
        </span>
        <div className="chat-actions">
          <Tooltip title="清空当前会话">
            <Button
              size="small"
              type="text"
              icon={<ClearOutlined />}
              disabled={busy}
              onClick={() => void clearHistory()}
            />
          </Tooltip>
        </div>
      </header>

      <div className="panel-tabs">
        <button
          className={`panel-tab${view === 'chat' ? ' active' : ''}`}
          onClick={() => setView('chat')}
        >
          对话
        </button>
        <button
          className={`panel-tab${view === 'trace' ? ' active' : ''}`}
          onClick={() => setView('trace')}
        >
          轨迹
        </button>
      </div>

      {view === 'trace' && <TracePanel sessionId={activeId} active={view === 'trace'} busy={busy} />}

      {view === 'chat' && (
        <>
          <div className="messages" ref={scrollRef}>
            {showHero ? (
              <WelcomeHero onPick={(p) => void send(p)} />
            ) : (
              <>
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className={`bubble${m.status && m.status !== 'done' ? ` bubble-${m.status}` : ''}`}>
              {m.steps && m.steps.length > 0 && <CollapsibleSteps steps={m.steps} />}
              {m.thumbs && m.thumbs.length > 0 && (
                <div className="bubble-thumbs">
                  <Image.PreviewGroup>
                    {m.thumbs.map((t) => (
                      <Image
                        key={t.id}
                        src={httpsify(t.url)}
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
              {m.files && m.files.length > 0 && (
                <div className="bubble-files">
                  {m.files.map((f) => (
                    <span key={f.id} className="file-chip" title={f.name}>
                      📄 {f.name}
                    </span>
                  ))}
                </div>
              )}
              {m.content && (
                <div className="bubble-text">
                  <Markdown>{m.content}</Markdown>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* 进行中的 run:步骤实时追加 */}
        {run && run.status === 'running' && (
          <div className="msg assistant">
            <div className="bubble">
              <StepList steps={run.steps} />
              {streamingText && (
                <div className="bubble-text streaming">
                  <Markdown>{streamingText}</Markdown>
                </div>
              )}
              {run.steps.length === 0 && !streamingText && (
                <div className="bubble-text">正在启动…</div>
              )}
            </div>
          </div>
        )}
              </>
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

      {docs.files.length > 0 && (
        <div className="file-tray">
          {docs.files.map((f) => (
            <span className="file-chip removable" key={f.id} title={`${f.name}(${kb(f.size)})`}>
              📄 {f.name}
              <button
                className="file-chip-remove"
                aria-label={`移除 ${f.name}`}
                onClick={() => docs.remove(f.id)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {attachments.rejected && <div className="tray-note">{attachments.rejected}</div>}
      {docs.rejected && <div className="tray-note">{docs.rejected}</div>}

      <div className="composer">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.doc,.docx,.xls,.xlsx,.csv,.tsv,.txt,.md,.json,.log,.xml,.yaml,.yml,.html"
          multiple
          hidden
          onChange={(e) => {
            pickFiles(e.target.files)
            // 同一个文件再次选择也要触发 change,清掉 value 才行
            e.target.value = ''
          }}
        />
        <textarea
          ref={taRef}
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
          placeholder={busy ? '执行中,可点击停止…' : '输入消息,让 Agent 操作浏览器,或直接描述需求'}
          rows={3}
          disabled={busy}
        />
        <div className="composer-bar">
          <div className="composer-left">
            <Tooltip title={vision ? '附加图片或文档(可粘贴/拖入)' : '附加文档(当前模型不读图)'}>
              <Button
                type="text"
                className="attach"
                icon={<PaperClipOutlined />}
                aria-label="附加文件"
                disabled={busy || uploading}
                onClick={() => fileRef.current?.click()}
              />
            </Tooltip>
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
          </div>
          {busy ? (
            <Button
              danger
              type="primary"
              shape="circle"
              icon={<StopOutlined />}
              aria-label="停止"
              onClick={() => void abort()}
            />
          ) : (
            <Button
              type="primary"
              shape="circle"
              icon={<SendOutlined />}
              loading={uploading}
              disabled={!canSend}
              aria-label="发送"
              onClick={() => void send()}
            />
          )}
        </div>
      </div>
        </>
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          // 模型可能变了,读图能力随之变化 —— 刷新 vision 以更新附图入口
          void window.api.session
            .info()
            .then((info) => setVision(info.vision))
            .catch(() => void 0)
        }}
      />
    </aside>
  )
})

export default ChatPanel
