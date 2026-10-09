import type { TraceEntry } from '../shared/types'

/**
 * 执行轨迹存储。按会话 id 累积本次应用运行期间产生的完整轨迹
 *(system / user / context / assistant / tool 逐条),供「轨迹」视图回看。
 *
 * 只放在内存:轨迹体积大(含工具入参/返回),不随应用重启保留。会话历史(对话)
 * 另有持久化,这里专供调试式回看当次运行的细节。
 */

const MAX_PER_SESSION = 2000

const store = new Map<string, TraceEntry[]>()

export function append(sessionId: string, entries: TraceEntry[]): void {
  if (!sessionId || entries.length === 0) return
  const list = store.get(sessionId) ?? []
  list.push(...entries)
  // 上限保护:超出从最旧丢
  if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION)
  store.set(sessionId, list)
}

export function get(sessionId: string): TraceEntry[] {
  return store.get(sessionId) ?? []
}

export function clear(sessionId: string): void {
  store.delete(sessionId)
}
