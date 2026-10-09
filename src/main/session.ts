import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import type { SessionMeta, SessionMessage } from '../shared/types'

/**
 * 会话历史。让模型看得到前几轮聊了什么,「刚才那个链接」这种指代才有意义。
 *
 * 两条硬约束决定了这个模块的形状:
 *
 * 1. **带 tool_calls 的 assistant 消息必须紧跟对应的 tool 回复。** run 被中断
 *    或报错时,历史末尾会留下悬空的 tool_calls,下一个 run 把它当历史发出去
 *    API 直接 400(实测报文:"An assistant message with 'tool_calls' must be
 *    followed by tool messages responding to each 'tool_call_id'")。所以**写入时
 *    就得修好**,而不是发送时再过滤 —— 坏数据不该在存储里躺着。
 *
 * 2. **快照文本很大。** 每个动作都回传一份完整元素列表,一个 run 下来几十 KB。
 *    跨 run 累积会很快吃掉上下文,所以历史里只保留动作的**首行摘要**,
 *    完整快照不留 —— 模型需要当前页面状态时重新 observe 就有,留着旧快照
 *    反而会让它拿过期的 index 去点。
 *
 * 3. **图片比文本重得多。** 观察层的截图一律不留(是「当时那一屏」,过期即无用);
 *    用户自己发的图要留 —— 那是任务的一部分 —— 但只留**最近一条**带图的消息,
 *    否则几张 5 MB 的图 base64 之后会一直压在上下文里。
 */

/**
 * 观察层截图那条 user 消息的开头文本。
 *
 * 截图没法塞进 role:'tool'(工具消息只接受文本 part),只能作为独立的 user
 * 消息补在工具结果后面 —— 于是它和「用户自己发的图」在 role 上完全同形。
 * 历史保留策略要区分两者(见模块头第 3 条),就得有个标记:agent 发送时用
 * 这个常量起头,这里按它识别。两边共用一个常量,不留第二份字面量。
 */
export const SCREENSHOT_NOTE = '以上动作的页面截图:'

/** 历史保留的消息条数上限。超出后从最旧的开始丢。 */
const MAX_MESSAGES = 60

/**
 * 历史里最多保留几条带图的用户消息。
 *
 * 1 = 只留最近那条。用户发新图通常意味着换了参照物,旧图留着只是在烧 token;
 * 真要回看旧图,重新发一次比永久驻留便宜。
 */
const MAX_IMAGE_MESSAGES = 1

/**
 * 工具结果在历史里保留的字符数。
 *
 * 只留首行摘要(「已点击元素 [3]」),完整快照不进历史 —— 见上面第 2 条。
 */
const TOOL_RESULT_LIMIT = 200

interface StoredSession {
  id: string
  /** 标题:取首条用户消息,空会话为空串(列表里显示占位名) */
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatCompletionMessageParam[]
}

interface Store {
  activeId: string
  /** 按创建顺序存,展示时再按 updatedAt 排序 */
  sessions: StoredSession[]
}

/** 标题截断长度 */
const TITLE_LIMIT = 40

let store: Store | null = null

function storePath(): string {
  // 打包后 userData 才是可写目录;放这里会随应用数据一起保留
  return join(app.getPath('userData'), 'sessions.json')
}

function newSession(): StoredSession {
  const now = Date.now()
  return {
    id: `sess-${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: '',
    createdAt: now,
    updatedAt: now,
    messages: []
  }
}

/**
 * 懒加载:首次访问时从磁盘读。读失败(文件不存在 / 损坏)就起一个全新的
 * 单会话 store —— 持久化不该成为聊天的硬依赖,坏档不能让功能瘫掉。
 */
function load(): Store {
  if (store) return store
  try {
    const raw = readFileSync(storePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Store
    if (parsed && Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
      // 活动 id 可能指向已不存在的会话,校正到第一个
      if (!parsed.sessions.some((s) => s.id === parsed.activeId)) {
        parsed.activeId = parsed.sessions[0].id
      }
      store = parsed
      return store
    }
  } catch {
    // 落到下面的全新 store
  }
  const first = newSession()
  store = { activeId: first.id, sessions: [first] }
  return store
}

/** 写盘。失败只告警,不抛 —— 见 load() 的理由。 */
function persist(): void {
  if (!store) return
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(storePath(), JSON.stringify(store), 'utf-8')
  } catch (err) {
    console.warn('[session] 持久化失败:', err)
  }
}

function active(): StoredSession {
  const s = load()
  return s.sessions.find((x) => x.id === s.activeId) ?? s.sessions[0]
}

/** 从消息里取首条用户文本做标题 */
function deriveTitle(messages: ChatCompletionMessageParam[]): string {
  for (const m of messages) {
    if (m.role !== 'user') continue
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((p): p is { type: 'text'; text: string } => (p as { type?: string }).type === 'text')
              .map((p) => p.text)
              .join(' ')
          : ''
    const trimmed = cleanForTitle(text)
    if (trimmed) return trimmed.length > TITLE_LIMIT ? `${trimmed.slice(0, TITLE_LIMIT)}…` : trimmed
  }
  return ''
}

/** 去掉并入用户消息的「【当前页面】…」行与「【附件:…】…」块,只留用户真正的问题 */
function cleanForTitle(text: string): string {
  return text
    .replace(/^【当前页面】[^\n]*\n+/, '')
    .replace(/【附件:[^\n]*\n[\s\S]*?(?:\n\n|$)/g, '')
    .trim()
}

/** run 开始时用「干净的」用户 prompt 定标题(避免被页面上下文/附件前缀污染) */
export function setTitleFromPrompt(prompt: string): void {
  const s = active()
  if (s.title) return
  const t = prompt.trim()
  if (!t) return
  s.title = t.length > TITLE_LIMIT ? `${t.slice(0, TITLE_LIMIT)}…` : t
  s.updatedAt = Date.now()
  persist()
}

function toMeta(s: StoredSession): SessionMeta {
  return {
    id: s.id,
    title: s.title || '新会话',
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length
  }
}

/**
 * 把一条工具结果压成适合长期保留的摘要。
 *
 * 快照文本的第一行是 `URL: ...`,动作结果的第一行是「已点击…」这类摘要,
 * 两种情况取首行都是对的。
 */
function condenseToolContent(content: string): string {
  const firstLine = content.split('\n')[0] ?? ''
  if (firstLine.length <= TOOL_RESULT_LIMIT) return firstLine
  return `${firstLine.slice(0, TOOL_RESULT_LIMIT)}…`
}

/**
 * 去掉图片 part,只留文字。
 *
 * 截图是「当时那一屏」,对后续轮次没有参考价值,但 base64 极占 token。
 * 用户自己发的图不一样 —— 那是任务的一部分(「照着这张图填表」),
 * 由 keepImages 决定是否保留。
 */
function stripImages(
  message: ChatCompletionMessageParam,
  keepImages: boolean
): ChatCompletionMessageParam {
  if (keepImages) return message
  if (!Array.isArray(message.content)) return message

  const texts = message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
  const imageCount = message.content.length - texts.length

  // 告诉模型这里原本有图,否则它会以为用户什么都没发。
  // 说「图片」而不是「截图」—— 这条路径既走观察层的截图,也走用户发的图。
  const note =
    imageCount > 0
      ? `${texts.join('\n')}\n(此处有 ${imageCount} 张图片,已省略)`
      : texts.join('\n')
  return { ...message, content: note || '(空消息)' } as ChatCompletionMessageParam
}

/**
 * 修掉悬空的 tool_calls。
 *
 * 从尾部往前扫:带 tool_calls 的 assistant 消息,若它后面没有覆盖全部
 * tool_call_id 的 tool 回复,就把这条 assistant 连同它后面的残片一起丢掉。
 * 保守一点没关系 —— 丢掉的是一次没跑完的动作,模型重新 observe 就能恢复。
 */
function dropDanglingToolCalls(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]

    if (m.role === 'assistant' && 'tool_calls' in m && m.tool_calls?.length) {
      const ids = new Set(m.tool_calls.map((c) => c.id))
      // 紧随其后的 tool 消息
      let j = i + 1
      const answered = new Set<string>()
      while (j < messages.length && messages[j].role === 'tool') {
        const id = (messages[j] as { tool_call_id?: string }).tool_call_id
        if (id) answered.add(id)
        j++
      }

      const complete = [...ids].every((id) => answered.has(id))
      if (!complete) {
        // 这条 assistant 和它后面的残缺 tool 回复一起不要
        i = j - 1
        continue
      }

      out.push(m)
      for (let k = i + 1; k < j; k++) out.push(messages[k])
      i = j - 1
      continue
    }

    // 孤立的 tool 消息(前面的 assistant 已被丢掉)也要扔
    if (m.role === 'tool') continue

    out.push(m)
  }

  return out
}

/**
 * 这条 user 消息是不是观察层的截图。
 *
 * 截图和用户发的图都是 role:'user' + image_url,只能靠开头的标记文本分辨。
 * 认错的代价不对称:把用户的图当截图丢掉,模型就瞎了(它会拿手边仅有的
 * 那张图作答,通常是某一屏空白页面);所以只认完全匹配的标记。
 */
function isScreenshotMessage(message: ChatCompletionMessageParam): boolean {
  if (message.role !== 'user') return false
  const parts: unknown = message.content
  if (!Array.isArray(parts)) return false
  const first = parts.find((p) => (p as { type?: string }).type === 'text')
  return (first as { text?: string } | undefined)?.text === SCREENSHOT_NOTE
}

/**
 * 这条消息里是否带图。
 *
 * 不靠 TS 的联合类型收窄来判断 —— 只有 user 消息的 content 数组里允许
 * image_url,收窄之后这个比较在某些 moduleResolution 下会被判成不可能而报错。
 * 这里按运行时形状看。
 */
function hasImages(message: ChatCompletionMessageParam): boolean {
  const parts: unknown = message.content
  if (!Array.isArray(parts)) return false
  return parts.some((p) => (p as { type?: string }).type === 'image_url')
}

/**
 * 只保留最近 MAX_IMAGE_MESSAGES 条带图消息里的图,更早的降级成文字说明。
 *
 * 从尾部往前数,所以「最近」是按时间算的。
 */
function capImages(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  let budget = MAX_IMAGE_MESSAGES
  const out = [...messages]

  for (let i = out.length - 1; i >= 0; i--) {
    if (!hasImages(out[i])) continue
    if (budget > 0) {
      budget--
      continue
    }
    out[i] = stripImages(out[i], false)
  }

  return out
}

/** 读取当前活动会话的历史,作为新 run 的起点 */
export function history(): ChatCompletionMessageParam[] {
  return dropDanglingToolCalls(active().messages)
}

/**
 * 把一个 run 产生的消息并入当前活动会话。
 *
 * 传入的是该 run 的完整 messages(不含 system —— 它每次由 agent 重新加上,
 * 这样改系统提示立刻生效,不会被旧历史里的版本盖住)。
 */
export function append(
  messages: ChatCompletionMessageParam[],
  options: { keepUserImages?: boolean } = {}
): void {
  const session = active()

  const condensed = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') {
        const content = typeof m.content === 'string' ? m.content : ''
        return { ...m, content: condenseToolContent(content) }
      }
      // 用户发的图可以留;观察层的截图一律丢 —— 两者同为 role:'user',
      // 不排掉截图的话它会把用户那张图挤出 capImages 的额度(它更靠后,
      // 从尾部数时先占额度),模型下一轮就只剩一张过期的页面截图可看。
      const keep =
        m.role === 'user' && options.keepUserImages === true && !isScreenshotMessage(m)
      return stripImages(m, keep)
    })

  session.messages = capImages(dropDanglingToolCalls([...session.messages, ...condensed]))

  // 超长时从头丢。丢完可能又出现孤立的 tool 消息,所以再过一遍。
  if (session.messages.length > MAX_MESSAGES) {
    session.messages = dropDanglingToolCalls(session.messages.slice(-MAX_MESSAGES))
  }

  // 首条用户消息定标题
  if (!session.title) session.title = deriveTitle(session.messages)
  session.updatedAt = Date.now()
  persist()
}

/** 清空当前活动会话(保留会话本身,标题一并重置) */
export function clear(): void {
  const session = active()
  session.messages = []
  session.title = ''
  session.updatedAt = Date.now()
  persist()
}

/** 历史会话列表,按最近更新倒序 */
export function list(): SessionMeta[] {
  return load()
    .sessions.slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toMeta)
}

/** 新建会话并切为活动 */
export function create(): SessionMeta {
  const s = load()
  const created = newSession()
  s.sessions.push(created)
  s.activeId = created.id
  persist()
  return toMeta(created)
}

/** 切换活动会话 */
export function activate(id: string): boolean {
  const s = load()
  if (!s.sessions.some((x) => x.id === id)) return false
  s.activeId = id
  persist()
  return true
}

/**
 * 删除会话。删掉当前活动会话时,活动指针落到最近更新的那个;
 * 全删光则自动起一个新空会话,保证永远有一个活动会话。
 */
export function remove(id: string): void {
  const s = load()
  s.sessions = s.sessions.filter((x) => x.id !== id)
  if (s.sessions.length === 0) {
    const fresh = newSession()
    s.sessions.push(fresh)
    s.activeId = fresh.id
  } else if (s.activeId === id) {
    s.activeId = [...s.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].id
  }
  persist()
}

/**
 * 取某会话用于展示回放的消息:只保留 user / assistant 的文本内容,
 * 工具调用、工具结果、截图都不展示(它们是执行细节,不是对话)。
 */
export function transcript(id: string): SessionMessage[] {
  const session = load().sessions.find((x) => x.id === id)
  if (!session) return []
  const out: SessionMessage[] = []
  for (const m of session.messages) {
    if (m.role === 'user') {
      const text =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((p): p is { type: 'text'; text: string } => (p as { type?: string }).type === 'text')
                .map((p) => p.text)
                .join('\n')
            : ''
      if (text.trim()) out.push({ role: 'user', content: text })
    } else if (m.role === 'assistant') {
      // 带 tool_calls 的 assistant 通常 content 为空,跳过;只回放有文字的那些
      const text = typeof m.content === 'string' ? m.content : ''
      if (text.trim()) out.push({ role: 'assistant', content: text })
    }
  }
  return out
}

/** 给 UI 用的轻量信息:当前活动会话的消息数与 id */
export function stats(): { messages: number; activeId: string } {
  const s = load()
  return { messages: active().messages.length, activeId: s.activeId }
}
