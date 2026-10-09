import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Dropdown, Image, Menu, Tooltip, message } from 'antd'
import {
  ClearOutlined,
  DeleteOutlined,
  HistoryOutlined,
  PictureOutlined,
  PlusOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
  UserOutlined
} from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { ImageAttachment, RunState, RunStep, SessionMeta } from '@shared/types'
import { useRun } from '../hooks/useRun'
import { useAttachments } from '../hooks/useAttachments'
import { loadMessages, removeMessages, saveMessages } from '../sessionStore'
import StepList from './StepList'
import SettingsModal from './SettingsModal'

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

/** 会话列表里的时间:月-日 时:分 */
const fmtTime = (ts: number): string => {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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

export default function ChatPanel({ targetId, width }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    { id: '0', role: 'assistant', content: GREETING }
  ])
  const [input, setInput] = useState('')
  const { run, busy, start, abort, reset } = useRun()
  const attachments = useAttachments()
  const [vision, setVision] = useState(true)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<string>('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
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
  }, [])

  /**
   * 把某会话载入消息区。优先用渲染层持久化的展示记录(含缩略图),
   * 没有再回退到主进程的文本 transcript;都没有就显示问候语。
   */
  const loadSession = useCallback(async (id: string): Promise<void> => {
    // 先同步切 ref,保证随后的持久化写进这个会话
    sessionIdRef.current = id
    const local = loadMessages(id)
    if (local && local.length > 0) {
      setMessages(local.map((m) => ({ id: m.id, role: m.role, content: m.content, thumbs: m.thumbs })))
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

  // 消息区变化就把展示记录(文字 + 缩略图)写进当前会话的 localStorage,
  // 这样切换会话、重启后卡片里的图片都还在。空 id(未初始化)时跳过。
  useEffect(() => {
    const id = sessionIdRef.current
    if (!id) return
    saveMessages(
      id,
      messages.map((m) => ({ id: m.id, role: m.role, content: m.content, thumbs: m.thumbs }))
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
        setSessions(await window.api.session.list())
        await loadSession(info.activeId)
      } catch {
        setVision(false)
      }
    })()
  }, [loadSession])

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

  /** 清空当前会话:主进程的会话记录和这里的消息列表要一起清,否则两边对不上 */
  const clearHistory = useCallback(async (): Promise<void> => {
    await window.api.session.clear()
    attachments.clear()
    removeMessages(sessionIdRef.current)
    setMessages([{ id: nextId(), role: 'assistant', content: `${GREETING}\n(历史已清空)` }])
    await refreshSessions()
  }, [attachments, refreshSessions])

  const send = async (): Promise<void> => {
    const text = input.trim()
    const pend = attachments.images
    // 只有图没有字也算一条有效消息 —— 「看看这张图」是常见用法
    if ((!text && pend.length === 0) || busy || uploading) return

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
    // 只发图片时气泡不显示占位文案,只展示图片;给模型的 prompt 仍另给默认指令
    const bubble = text

    if (targetId === null) {
      setMessages((m) => [
        ...m,
        { id: nextId(), role: 'user', content: bubble, thumbs },
        { id: nextId(), role: 'assistant', content: '浏览器还没准备好,等右侧页面加载完成后再试。' }
      ])
      setInput('')
      attachments.detach()
      return
    }

    setMessages((m) => [...m, { id: nextId(), role: 'user', content: bubble, thumbs }])
    setInput('')
    // 气泡用的是 COS 链接或缩略图 data URL(都已持久化);object URL 仅作兜底,
    // 可能还被引用,所以这里只摘掉待发列表、不主动释放。
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
        <span className="chat-title" title={sessions.find((s) => s.id === activeId)?.title}>
          {sessions.find((s) => s.id === activeId)?.title ?? 'Agent 对话'}
        </span>
        <div className="chat-actions">
          <Button
            size="small"
            type="primary"
            ghost
            icon={<PlusOutlined />}
            disabled={busy}
            onClick={() => void newSession()}
          >
            新建会话
          </Button>
          <Dropdown
            trigger={['click']}
            disabled={busy}
            placement="bottomRight"
            overlay={
              <Menu
                theme="dark"
                selectedKeys={[activeId]}
                onClick={({ key }) => void selectSession(String(key))}
                items={
                  sessions.length === 0
                    ? [{ key: '__empty__', disabled: true, label: '暂无历史会话' }]
                    : sessions.map((s) => ({
                      key: s.id,
                      label: (
                        <div className="session-item">
                          <span className="session-item-title">{s.title}</span>
                          <span className="session-item-meta">
                            {fmtTime(s.updatedAt)} · {s.messageCount}
                          </span>
                          <Tooltip title="删除会话">
                            <DeleteOutlined
                              className="session-item-del"
                              role="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                void deleteSession(s.id)
                              }}
                            />
                          </Tooltip>
                        </div>
                      )
                    }))
                }
              />
            }
          >
            <Button size="small" icon={<HistoryOutlined />}>
              历史会话
            </Button>
          </Dropdown>
          <Tooltip title="清空当前会话">
            <Button
              size="small"
              type="text"
              icon={<ClearOutlined />}
              disabled={busy}
              onClick={() => void clearHistory()}
            />
          </Tooltip>
          <Tooltip title="设置">
            <Button
              size="small"
              type="text"
              icon={<SettingOutlined />}
              onClick={() => setSettingsOpen(true)}
            />
          </Tooltip>
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            overlay={
              <Menu
                theme="dark"
                onClick={({ key }) => {
                  // 账户体系尚未接入,这里先只做入口
                  if (key === 'login') message.info('登录功能开发中')
                  else if (key === 'profile') message.info('个人中心开发中')
                }}
                items={[
                  { key: 'login', label: '登录' },
                  { key: 'profile', label: '个人中心' }
                ]}
              />
            }
          >
            <Tooltip title="账户">
              <Button size="small" type="text" icon={<UserOutlined />} />
            </Tooltip>
          </Dropdown>
        </div>
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
        <Tooltip
          title={vision ? '附加图片(也可直接粘贴或拖入)' : '当前模型不支持读图,无法附加图片'}
        >
          <Button
            className="attach"
            icon={<PictureOutlined />}
            aria-label="附加图片"
            disabled={busy || uploading || !vision || attachments.full}
            onClick={() => fileRef.current?.click()}
          />
        </Tooltip>
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
          rows={1}
          disabled={busy}
        />
        {busy ? (
          <Button danger type="primary" icon={<StopOutlined />} onClick={() => void abort()}>
            停止
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={uploading}
            disabled={!canSend}
            onClick={() => void send()}
          >
            {uploading ? '上传中' : '发送'}
          </Button>
        )}
      </div>

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
}
