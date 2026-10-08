import { useCallback, useState } from 'react'

/**
 * 聊天面板的可拖动宽度。
 *
 * 两个实现要点:
 *
 * 1. **用 pointer capture,不要在 window 上挂 mousemove。** 右侧是 `<webview>`,
 *    它自己是一套独立的渲染流程 —— 指针移到它上面之后,事件不会冒泡回宿主
 *    document,拖动会在越过分隔条的那一刻「断线」。`setPointerCapture` 把后续
 *    指针事件钉在分隔条上,鼠标经过哪个元素都不影响。
 *    保险起见拖动期间还会给 .app 加 resizing 类,顺手屏掉 webview 的命中测试。
 *
 * 2. **按下时记住起点,用增量算宽度**,而不是直接拿 clientX 当宽度 ——
 *    后者会让面板边缘「跳」到指针位置(落差等于你按在分隔条上的偏移量)。
 */

/** 再窄输入框和按钮就挤在一起了 */
const MIN_WIDTH = 280

/** 再宽就没给浏览器留出可用空间了 */
const MAX_WIDTH = 720

const DEFAULT_WIDTH = 360

/** 键盘调节时每次按键走多少像素 */
const STEP = 16

const clamp = (px: number): number => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px))

export function usePanelWidth() {
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      // 只响应主键;右键和中键按下不该开始拖动
      if (e.button !== 0) return
      e.preventDefault()

      const startX = e.clientX
      const startWidth = width
      const el = e.currentTarget
      el.setPointerCapture(e.pointerId)
      setDragging(true)

      const onMove = (ev: PointerEvent): void => setWidth(clamp(startWidth + ev.clientX - startX))

      const onUp = (): void => {
        setDragging(false)
        el.removeEventListener('pointermove', onMove)
        el.removeEventListener('pointerup', onUp)
        el.removeEventListener('pointercancel', onUp)
      }

      // 监听挂在捕获元素上,配合 setPointerCapture 才拿得到全程事件
      el.addEventListener('pointermove', onMove)
      el.addEventListener('pointerup', onUp)
      // 指针被系统抢走(比如拖出窗口后松手)也要收尾,否则 dragging 卡在 true
      el.addEventListener('pointercancel', onUp)
    },
    [width]
  )

  /** 键盘调节:分隔条可聚焦,左右方向键改宽度,Home/End 回到两端 */
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = (fn: (w: number) => number): void => {
      e.preventDefault()
      setWidth((w) => clamp(fn(w)))
    }
    if (e.key === 'ArrowLeft') next((w) => w - STEP)
    else if (e.key === 'ArrowRight') next((w) => w + STEP)
    else if (e.key === 'Home') next(() => MIN_WIDTH)
    else if (e.key === 'End') next(() => MAX_WIDTH)
  }, [])

  /** 双击分隔条回到默认宽度 */
  const reset = useCallback((): void => setWidth(DEFAULT_WIDTH), [])

  return { width, dragging, onPointerDown, onKeyDown, reset, min: MIN_WIDTH, max: MAX_WIDTH }
}
