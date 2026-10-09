import { webContents } from 'electron'
import { snapshot } from './observe'
import type { ObservedElement, PageSnapshot } from '../shared/types'

/**
 * 工具层:在 CDP 原语之上封装成 Agent 可用的动作。
 *
 * 每个动作都以「最近一次快照」为坐标依据 —— 模型看到的是快照里的 index,
 * 动作把 index 翻译成 center 坐标再下发 Input.dispatchMouseEvent。
 * 所以调用顺序必须是 snapshot → action,且页面变化后要重新 snapshot。
 *
 * 这里不直接暴露 Input.dispatchMouseEvent 给模型:原始 CDP 需要模型自己算坐标、
 * 配对 mousePressed/mouseReleased、处理修饰键,交给它做既费 token 又容易错。
 */

/**
 * 导航超时。
 *
 * wc.loadURL() 的 promise 要等**所有**子资源加载完才 resolve,像 github.com
 * 这种页面可能挂几十秒甚至一直不 resolve(分析脚本、长连接)。没有超时的话
 * 整个 run 就卡在那里,用户只能 abort。
 *
 * 超时不算失败:页面这时通常已经可交互了,所以带一句说明返回,让模型
 * observe 一下自己判断。
 */
const NAV_TIMEOUT = 15_000
/** 点击后等页面反应的时间 —— 够触发导航或前端渲染,又不至于拖慢每一步 */
const SETTLE_AFTER_ACTION = 600

export class ActionError extends Error {}

function resolve(targetId: number): Electron.WebContents {
  const wc = webContents.fromId(targetId)
  if (!wc) throw new ActionError(`未找到 target ${targetId}`)
  if (wc.isDestroyed()) throw new ActionError(`target ${targetId} 已销毁`)
  return wc
}

async function cdp(
  wc: Electron.WebContents,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  return await wc.debugger.sendCommand(method, params)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 在快照里按 index 取元素,并给出清楚的错误。
 * 模型偶尔会引用上一轮的 index,这里要让它知道自己引用错了而不是静默点空。
 */
function elementAt(snap: PageSnapshot, index: number): ObservedElement {
  const el = snap.elements.find((e) => e.index === index)
  if (!el) {
    throw new ActionError(
      `当前页面没有 index=${index} 的元素(有效范围 0-${snap.elements.length - 1})。` +
        `页面可能已变化,请重新 observe 后再引用新的 index。`
    )
  }
  if (el.disabled) {
    throw new ActionError(`元素 [${index}] ${el.role} "${el.name}" 处于禁用状态,无法操作。`)
  }
  return el
}

/** 把元素滚进视口 —— 离屏元素的坐标点不到 */
async function scrollIntoView(wc: Electron.WebContents, el: ObservedElement): Promise<void> {
  if (el.inViewport) return
  // 没有 xpath 的元素(穿过 shadow root)只能靠滚动窗口逼近
  if (el.xpath) {
    await cdp(wc, 'Runtime.evaluate', {
      expression: `(() => {
        const r = document.evaluate(${JSON.stringify(el.xpath)}, document, null, 9, null);
        if (r.singleNodeValue) r.singleNodeValue.scrollIntoView({ block: 'center', behavior: 'instant' });
      })()`
    })
  } else {
    await cdp(wc, 'Runtime.evaluate', {
      expression: `window.scrollTo({ top: ${el.bbox.y} - window.innerHeight / 2, behavior: 'instant' })`
    })
  }
  await sleep(150)
}

async function clickAt(wc: Electron.WebContents, x: number, y: number): Promise<void> {
  const base = { x, y, button: 'left' as const, clickCount: 1 }
  await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
  await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
}

// ---------- 对外动作 ----------

export async function navigate(targetId: number, url: string): Promise<string> {
  const wc = resolve(targetId)
  const raw = url.trim()

  // 只放行 http(s):file:// 能读本地文件,javascript: / data: 能绕过页面边界。
  // 补全协议头必须限定在「压根没写协议」的情况 —— 否则 file:///etc/passwd 会被
  // 拼成 https://file///etc/passwd 从而绕过下面的协议检查。
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw)
  if (hasScheme && !/^https?:\/\//i.test(raw)) {
    throw new ActionError(`只允许导航到 http/https,收到 ${raw.split(':')[0]}:`)
  }

  let parsed: URL
  try {
    parsed = new URL(hasScheme ? raw : `https://${raw}`)
  } catch {
    throw new ActionError(`无效的 URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ActionError(`只允许导航到 http/https,收到 ${parsed.protocol}`)
  }

  const navigation = wc
    .loadURL(parsed.toString())
    .then(() => false)
    .catch((err: Error) => {
      // 用户主动打断或页面自身重定向会产生 ERR_ABORTED,不算失败
      if (!/ERR_ABORTED/.test(err.message)) throw new ActionError(`导航失败: ${err.message}`)
      return false
    })

  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), NAV_TIMEOUT)
  })

  try {
    const timedOut = await Promise.race([navigation, timeout])
    await sleep(SETTLE_AFTER_ACTION)
    if (timedOut) {
      // 别把在途的 loadURL 变成未处理的 rejection
      void navigation.catch(() => {})
      return (
        `已导航到 ${wc.getURL()},但 ${NAV_TIMEOUT / 1000}s 内页面仍未加载完` +
        `(可能还在加载次要资源)。页面通常已可操作,observe 一下确认当前状态。`
      )
    }
    return `已导航到 ${wc.getURL()}`
  } finally {
    clearTimeout(timer)
  }
}

export async function click(targetId: number, snap: PageSnapshot, index: number): Promise<string> {
  const wc = resolve(targetId)
  const el = elementAt(snap, index)
  await scrollIntoView(wc, el)

  // 滚动后坐标会变,重新量一次
  let point = el.center
  if (!el.inViewport && el.xpath) {
    const measured = (await cdp(wc, 'Runtime.evaluate', {
      expression: `(() => {
        const r = document.evaluate(${JSON.stringify(el.xpath)}, document, null, 9, null);
        if (!r.singleNodeValue) return null;
        const b = r.singleNodeValue.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) });
      })()`,
      returnByValue: true
    })) as { result?: { value?: string | null } }
    const raw = measured.result?.value
    if (raw) point = JSON.parse(raw)
  }

  await clickAt(wc, point.x, point.y)
  await sleep(SETTLE_AFTER_ACTION)
  return `已点击 [${index}] ${el.role} "${el.name}"`
}

/**
 * 按「可见文字」直接定位并点击元素。
 *
 * 用途:observe 的可交互元素列表只收语义化控件(role/input/[onclick]/[tabindex]…),
 * ERP 里很多自定义组件(如顶部「统计时间」选择器)是没有这些标记的 div,observe
 * 看不到、也就没有 index 可点。这个动作直接在 DOM 里按文字找最贴近的那个元素
 *(叶子优先),滚动到可见后点它的中心,绕开 observe 的编号体系。
 */
export async function clickText(targetId: number, text: string, nth = 0): Promise<string> {
  const wc = resolve(targetId)
  const q = text.trim()
  if (!q) throw new ActionError('click_text 需要一个非空的文字')

  const expr = `(() => {
    const q = ${JSON.stringify(q)};
    const nth = ${Number.isFinite(nth) ? Math.max(0, Math.floor(nth)) : 0};
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const matches = [];
    for (const el of document.querySelectorAll('*')) {
      const t = norm(el.innerText || el.textContent);
      if (!t || t.length > 80 || t.indexOf(q) < 0) continue;
      // 叶子优先:若某个子元素也包含该文字,交给更深的那个,避免点到大容器
      let childHas = false;
      for (const c of el.children) { if (norm(c.innerText || c.textContent).indexOf(q) >= 0) { childHas = true; break; } }
      if (childHas) continue;
      let cs; try { cs = getComputedStyle(el); } catch (e) { continue; }
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      matches.push(el);
    }
    if (!matches.length) return JSON.stringify({ count: 0 });
    const el = matches[Math.min(nth, matches.length - 1)];
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    return JSON.stringify({
      count: matches.length,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      text: norm(el.innerText || el.textContent).slice(0, 80)
    });
  })()`

  const res = (await cdp(wc, 'Runtime.evaluate', { expression: expr, returnByValue: true })) as {
    result?: { value?: string }
  }
  const info = JSON.parse(res.result?.value ?? '{"count":0}') as {
    count: number
    x?: number
    y?: number
    text?: string
  }
  if (!info.count || info.x == null || info.y == null) {
    throw new ActionError(`页面上找不到文字包含「${q}」的可点元素。换个更短 / 更准确的文字再试,或先 observe。`)
  }
  await sleep(150) // 等 scrollIntoView 落定
  await clickAt(wc, info.x, info.y)
  await sleep(SETTLE_AFTER_ACTION)
  const more = info.count > 1 ? `(共 ${info.count} 个匹配,点了第 ${Math.min(nth, info.count - 1) + 1} 个)` : ''
  return `已按文字点击「${info.text}」${more}`
}

export async function type(
  targetId: number,
  snap: PageSnapshot,
  index: number,
  text: string,
  submit = false
): Promise<string> {
  const wc = resolve(targetId)
  const el = elementAt(snap, index)
  await scrollIntoView(wc, el)

  // 先点进去拿焦点,再清空原值
  await clickAt(wc, el.center.x, el.center.y)
  await sleep(80)

  // 全选原有内容。必须是 rawKeyDown + commands:['selectAll'] —— 光发 keyDown 带
  // modifiers 不会触发浏览器的编辑命令,insertText 会把新值追加到旧值后面。
  const modifiers = process.platform === 'darwin' ? 4 : 2 // Meta : Ctrl
  await cdp(wc, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers,
    commands: ['selectAll']
  })
  await cdp(wc, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'a',
    code: 'KeyA',
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers
  })
  // insertText 走输入法路径,能正确触发框架的 input 事件(替换掉选中的旧值)
  await cdp(wc, 'Input.insertText', { text })
  await sleep(120)

  if (submit) {
    for (const type of ['keyDown', 'char', 'keyUp'] as const) {
      await cdp(wc, 'Input.dispatchKeyEvent', {
        type,
        key: 'Enter',
        code: 'Enter',
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
        text: type === 'char' ? '\r' : undefined
      })
    }
    await sleep(SETTLE_AFTER_ACTION)
  }

  return `已在 [${index}] ${el.role} "${el.name}" 输入${submit ? '并回车' : ''}`
}

export async function scroll(
  targetId: number,
  direction: 'down' | 'up' | 'top' | 'bottom',
  amount?: number
): Promise<string> {
  const wc = resolve(targetId)

  // 读视口尺寸与当前滚动位置(仅用于定位滚轮落点与步长 / 回报,不是元素观察)
  const readState = async (): Promise<{ w: number; h: number; y: number; sh: number }> => {
    const r = (await cdp(wc, 'Runtime.evaluate', {
      expression:
        'JSON.stringify({ w: window.innerWidth, h: window.innerHeight, y: Math.round(window.scrollY), sh: Math.round(document.documentElement.scrollHeight) })',
      returnByValue: true
    })) as { result?: { value?: string } }
    return JSON.parse(r.result?.value ?? '{"w":1024,"h":768,"y":0,"sh":0}')
  }

  const s0 = await readState()
  const cx = Math.round(s0.w / 2)
  const cy = Math.round(s0.h / 2)
  const step = amount ?? Math.round(s0.h * 0.8)

  // 下发一次真实滚轮事件(模拟人工滚动,能触发懒加载 / 虚拟列表 / 滚动监听)
  const wheel = async (deltaY: number): Promise<void> => {
    await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY })
    await sleep(140)
  }

  if (direction === 'down') {
    await wheel(step)
  } else if (direction === 'up') {
    await wheel(-step)
  } else {
    // top / bottom:连续滚轮直到到顶 / 到底(模拟一直滚),位置不再变化就停
    const dir = direction === 'bottom' ? 1 : -1
    const chunk = Math.max(step, s0.h)
    let last = -1
    for (let i = 0; i < 50; i++) {
      await wheel(dir * chunk)
      const y = (await readState()).y
      if (y === last) break
      last = y
    }
  }

  await sleep(200)
  const s1 = await readState()
  return `已滚动(${direction}),当前位置 ${s1.y}/${s1.sh}`
}

export async function goBack(targetId: number): Promise<string> {
  const wc = resolve(targetId)
  if (!wc.navigationHistory.canGoBack()) return '没有可后退的历史记录'
  wc.navigationHistory.goBack()
  await sleep(SETTLE_AFTER_ACTION)
  return `已后退到 ${wc.getURL()}`
}

/** 读取页面可见正文,给模型判断内容用(元素列表只有可交互项) */
export async function readText(targetId: number, maxLength = 4000): Promise<string> {
  const wc = resolve(targetId)
  const res = (await cdp(wc, 'Runtime.evaluate', {
    expression: `(() => {
      const main = document.querySelector('main, article, [role="main"]') || document.body;
      return (main.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, ${maxLength});
    })()`,
    returnByValue: true
  })) as { result?: { value?: string } }
  const text = res.result?.value ?? ''
  return text || '(页面没有可读文本)'
}

export async function observe(
  targetId: number,
  withScreenshot = false
): Promise<PageSnapshot> {
  return await snapshot(targetId, { viewportOnly: true, screenshot: withScreenshot })
}

export { NAV_TIMEOUT }
