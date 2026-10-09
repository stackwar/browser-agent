/**
 * 会话卡片的本地持久化。
 *
 * 主进程的 session.ts 存的是喂给模型的消息(做了压缩、截图不留、图片只留最近一张),
 * 适合续聊,但不适合**展示**:切换会话或重启后想看到当时的卡片(文字 + 图片),
 * 得有一份面向 UI 的记录。
 *
 * 放在渲染层的 localStorage 而不是主进程,是因为:
 * - 图片以**降采样缩略图**(data URL)保存,体积小,localStorage 放得下;
 * - 展示数据天然属于渲染层,不必再走一轮 IPC;
 * - 与主进程的模型历史解耦 —— 后者会按 token 预算压缩,这里要的是原样回看。
 *
 * 存不下(配额超限)时的降级顺序:先丢图只留文字,再不行就放弃本次写入 ——
 * 持久化是增强,不该因为写盘失败影响正在进行的对话。
 */

const PREFIX = 'ba:msgs:'

export interface PersistedThumb {
  id: string
  /** 缩略图 data URL */
  url: string
  name: string
}

export interface PersistedMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  thumbs?: PersistedThumb[]
}

function key(sessionId: string): string {
  return `${PREFIX}${sessionId}`
}

/** 读取某会话的展示消息;没有则返回 null(调用方据此回退到主进程 transcript) */
export function loadMessages(sessionId: string): PersistedMessage[] | null {
  try {
    const raw = localStorage.getItem(key(sessionId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as PersistedMessage[]) : null
  } catch {
    return null
  }
}

/**
 * 写入某会话的展示消息。配额超限时逐级降级:
 * 先去掉图片只存文字,仍失败就放弃。
 */
export function saveMessages(sessionId: string, messages: PersistedMessage[]): void {
  const k = key(sessionId)
  try {
    localStorage.setItem(k, JSON.stringify(messages))
    return
  } catch {
    // 多半是图片把配额撑爆了,去图重试
  }
  try {
    const textOnly = messages.map(({ thumbs: _thumbs, ...rest }) => rest)
    localStorage.setItem(k, JSON.stringify(textOnly))
  } catch {
    // 还不行就算了,持久化不是硬需求
  }
}

/** 删除某会话的展示消息(清空历史 / 删除会话时调用) */
export function removeMessages(sessionId: string): void {
  try {
    localStorage.removeItem(key(sessionId))
  } catch {
    // 忽略
  }
}
