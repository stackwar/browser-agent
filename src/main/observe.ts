import { webContents } from 'electron'
import { COLLECT_SCRIPT } from './injected/collect'
import type {
  ObservedElement,
  PageSnapshot,
  Screenshot,
  ScreenshotOptions,
  SnapshotOptions
} from '../shared/types'

/**
 * 观察层:把页面变成模型能读的东西。
 *
 * 两种表示,按需组合:
 * - 结构化元素列表(注入脚本遍历 DOM + shadow DOM + 同源 iframe)
 * - 截图(Page.captureScreenshot)
 *
 * 元素的 center 是顶层视口坐标,拿到后可直接下发
 * Input.dispatchMouseEvent 点击,不需要再查一次 DOM。
 */

const DEFAULTS = {
  maxElements: 300,
  maxTextLength: 120,
  viewportOnly: true,
  screenshotFormat: 'jpeg' as const,
  screenshotQuality: 60,
  settleTimeout: 10_000
}

/** 采集脚本的原始返回结构(注入脚本不受类型检查,这里手写对应形状) */
interface RawCollectResult {
  url: string
  title: string
  viewport: { width: number; height: number }
  scroll: { x: number; y: number; height: number }
  hasContentAbove: boolean
  hasContentBelow: boolean
  elements: ObservedElement[]
  truncated: boolean
}

function resolve(targetId: number) {
  const wc = webContents.fromId(targetId)
  if (!wc) throw new Error(`未找到 target ${targetId}`)
  if (wc.isDestroyed()) throw new Error(`target ${targetId} 已销毁`)
  return wc
}

/**
 * 确保 debugger 已附着。
 *
 * 注意:若外部 Agent(Playwright / browser-use)已通过远程调试端口接管
 * 同一个 target,attach 会失败 —— 两条 CDP 通道对同一 target 互斥。
 * 这里把错误原样抛出,让调用方看到真实原因。
 */
function ensureAttached(wc: Electron.WebContents): void {
  if (wc.debugger.isAttached()) return
  try {
    wc.debugger.attach('1.3')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `无法附加调试器到 target ${wc.id}:${msg}。` +
        `若已有外部 Agent 通过远程调试端口连接该页面,请先断开 —— 同一 target 只能被一个调试客户端占用。`
    )
  }
}

/**
 * 等页面进入可观察状态。
 *
 * <webview> 的 dom-ready 会在 about:blank 阶段就触发,此时直接采集只会拿到空页面。
 * 这里等到「不在加载中且 URL 不是 about:blank」,或超时后按现状采集 —— 宁可给出
 * 不完整的快照,也不要无限期挂住 Agent。
 */
async function waitForSettled(wc: Electron.WebContents, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (wc.isDestroyed()) throw new Error(`target ${wc.id} 已销毁`)
    const url = wc.getURL()
    const blank = !url || url === 'about:blank'
    if (!wc.isLoadingMainFrame() && !blank) return
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function captureScreenshot(
  targetId: number,
  options: ScreenshotOptions = {}
): Promise<Screenshot> {
  const wc = resolve(targetId)
  ensureAttached(wc)

  const format = options.format ?? DEFAULTS.screenshotFormat
  const params: Record<string, unknown> = {
    format,
    captureBeyondViewport: options.fullPage === true,
    fromSurface: true
  }
  if (format === 'jpeg') {
    params.quality = options.quality ?? DEFAULTS.screenshotQuality
  }

  const result = (await wc.debugger.sendCommand('Page.captureScreenshot', params)) as { data: string }
  const data = result?.data ?? ''
  return {
    format,
    data,
    // base64 每 4 字符编码 3 字节,末尾 '=' 是填充
    bytes: Math.floor((data.length * 3) / 4)
  }
}

/** 把元素列表压成紧凑文本。每行一个元素,尽量短 —— 这些 token 都要进 prompt。 */
export function formatElements(elements: ObservedElement[]): string {
  return elements
    .map((el) => {
      const parts = [`[${el.index}]`, el.role]
      if (el.type && el.type !== el.role) parts.push(`(${el.type})`)
      if (el.name) parts.push(JSON.stringify(el.name))
      if (el.value) parts.push(`value=${JSON.stringify(el.value)}`)
      if (el.href) parts.push(`href=${el.href}`)
      if (el.checked !== undefined) parts.push(el.checked ? 'checked' : 'unchecked')
      if (el.expanded !== undefined) parts.push(el.expanded ? 'expanded' : 'collapsed')
      if (el.disabled) parts.push('disabled')
      if (!el.inViewport) parts.push('offscreen')
      if (el.frame) parts.push(`in=${el.frame}`)
      return parts.join(' ')
    })
    .join('\n')
}

/** 拼出快照的完整文本表示,含页面元信息与滚动提示。 */
function buildText(raw: RawCollectResult, elements: ObservedElement[], truncated: boolean): string {
  const lines = [
    `URL: ${raw.url}`,
    `标题: ${raw.title}`,
    `视口: ${raw.viewport.width}x${raw.viewport.height}  滚动位置: ${raw.scroll.y}/${raw.scroll.height}`
  ]

  const hints: string[] = []
  if (raw.hasContentAbove) hints.push('上方有更多内容')
  if (raw.hasContentBelow) hints.push('下方有更多内容')
  if (hints.length) lines.push(hints.join(',可滚动查看;') + ',可滚动查看')

  lines.push('')
  if (elements.length === 0) {
    lines.push('可交互元素: 无(页面可能仍在加载,或内容都在跨源 iframe 内)')
  } else {
    lines.push(`可交互元素(${elements.length} 个${truncated ? ',已截断' : ''}):`)
    lines.push(formatElements(elements))
  }

  return lines.join('\n')
}

export async function snapshot(
  targetId: number,
  options: SnapshotOptions = {}
): Promise<PageSnapshot> {
  const wc = resolve(targetId)
  ensureAttached(wc)
  await waitForSettled(wc, options.settleTimeout ?? DEFAULTS.settleTimeout)

  const collectOptions = {
    maxElements: options.maxElements ?? DEFAULTS.maxElements,
    maxTextLength: options.maxTextLength ?? DEFAULTS.maxTextLength,
    viewportOnly: options.viewportOnly ?? DEFAULTS.viewportOnly
  }

  const expression = COLLECT_SCRIPT.replace('__OPTIONS__', JSON.stringify(collectOptions))

  const evaluated = (await wc.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
    // 页面可能覆盖了 Object.prototype 之类的全局,但采集脚本只用基础 API,
    // 这里保持在页面主世界执行,才能读到 shadowRoot 与同源 iframe。
    userGesture: false
  })) as {
    result?: { value?: string }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }

  if (evaluated.exceptionDetails) {
    const detail =
      evaluated.exceptionDetails.exception?.description ??
      evaluated.exceptionDetails.text ??
      '未知错误'
    throw new Error(`采集脚本执行失败: ${detail}`)
  }

  const payload = evaluated.result?.value
  if (typeof payload !== 'string') {
    throw new Error('采集脚本未返回结果,页面可能正在导航')
  }

  const raw = JSON.parse(payload) as RawCollectResult
  const elements = raw.elements ?? []

  const result: PageSnapshot = {
    targetId,
    url: raw.url,
    title: raw.title,
    viewport: raw.viewport,
    scroll: raw.scroll,
    hasContentAbove: raw.hasContentAbove,
    hasContentBelow: raw.hasContentBelow,
    elements,
    text: buildText(raw, elements, raw.truncated),
    truncated: raw.truncated,
    capturedAt: Date.now()
  }

  if (options.screenshot) {
    result.screenshot = await captureScreenshot(targetId, {
      format: options.screenshotFormat,
      quality: options.screenshotQuality,
      fullPage: options.fullPage
    })
  }

  return result
}
