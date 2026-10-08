/**
 * 主进程 / preload / 渲染层共用的类型。
 * 三端都从这里导入,避免类型在多处重复声明后走样。
 */

// ---------- CDP 基础 ----------

export interface CdpTarget {
  id: number
  type: string
  title: string
  url: string
  attached: boolean
}

export interface CdpEvent {
  targetId: number
  method: string
  params: unknown
}

export interface StatusInfo {
  debugPort: number
  endpoint: string
}

export interface SessionInfo {
  /** 历史里的消息条数 */
  messages: number
  /** 当前模型 ID */
  model: string
  /** 当前模型是否读图 —— 决定 UI 是否放开附图入口 */
  vision: boolean
}

// ---------- 观察层 ----------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** 一个可交互元素。index 只在单次快照内有效,跨快照会变。 */
export interface ObservedElement {
  /** 快照内的序号,喂给模型时用它指代元素 */
  index: number
  /** 小写标签名 */
  tag: string
  /** aria role 或由标签推断的角色 */
  role: string
  /** 可访问名称:aria-label / label / placeholder / alt / 文本 */
  name: string
  /** input 的 type */
  type?: string
  /** 表单控件当前值(password 一律脱敏为 '***') */
  value?: string
  href?: string
  disabled?: boolean
  checked?: boolean
  expanded?: boolean
  /** 顶层视口坐标系下的包围盒(CSS 像素) */
  bbox: Rect
  /** 顶层视口坐标系下的中心点,可直接喂给 Input.dispatchMouseEvent */
  center: Point
  /** 是否落在当前视口内 */
  inViewport: boolean
  /** 跨越 shadow root 时为 null —— 此时用 center 做定位 */
  xpath: string | null
  /** 所在 iframe 的描述,顶层文档为 null */
  frame: string | null
}

export interface PageSnapshot {
  targetId: number
  url: string
  title: string
  viewport: { width: number; height: number }
  scroll: { x: number; y: number; height: number }
  /** 视口上方 / 下方是否还有内容,用于判断要不要滚动 */
  hasContentAbove: boolean
  hasContentBelow: boolean
  elements: ObservedElement[]
  /** 元素列表的紧凑文本形式,直接塞进 prompt */
  text: string
  /** 元素数量触达上限被截断 */
  truncated: boolean
  /** base64(不含 data: 前缀),仅在请求截图时存在 */
  screenshot?: { format: 'png' | 'jpeg'; data: string; bytes: number }
  capturedAt: number
}

export interface SnapshotOptions {
  /** 是否同时抓截图,默认 false */
  screenshot?: boolean
  screenshotFormat?: 'png' | 'jpeg'
  /** jpeg 质量 0-100,默认 60 */
  screenshotQuality?: number
  /** 截整页而非视口,默认 false */
  fullPage?: boolean
  /** 只收视口内的元素,默认 true */
  viewportOnly?: boolean
  /** 元素数量上限,默认 300 */
  maxElements?: number
  /** 单个元素文本截断长度,默认 120 */
  maxTextLength?: number
  /** 等待页面加载完成的上限毫秒数,默认 10000;超时后按现状采集 */
  settleTimeout?: number
}

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg'
  quality?: number
  fullPage?: boolean
}

export interface Screenshot {
  format: 'png' | 'jpeg'
  data: string
  bytes: number
}

// ---------- 工具层动作 ----------

/**
 * 一次动作请求。click / type 的 index 取自最近一次快照 ——
 * 经 IPC 调用时会即时重拍一张,所以 index 必须来自刚拿到的 snapshot。
 */
export type ActionPayload =
  | { action: 'navigate'; targetId: number; url: string }
  | { action: 'click'; targetId: number; index: number }
  | { action: 'type'; targetId: number; index: number; text: string; submit?: boolean }
  | { action: 'scroll'; targetId: number; direction: 'down' | 'up' | 'top' | 'bottom'; amount?: number }
  | { action: 'goBack'; targetId: number }
  | { action: 'readText'; targetId: number }

// ---------- 人工接管 ----------

/**
 * 浏览器控制权。
 *
 * agent 的 CDP 输入事件和用户的真实鼠标键盘走同一个输入通道,同时操作会互相打断,
 * 所以控制权是互斥的,不是「两边都能动」。
 *
 * - idle:没有 run 在跑,用户随意操作
 * - agent:agent 独占,渲染层用遮罩挡住用户输入
 * - manual:用户独占,agent 在下一个动作边界挂起等待
 *
 * 接管只能在动作之间生效 —— 已经发出的 CDP 命令无法撤回。
 */
export type ControlOwner = 'idle' | 'agent' | 'manual'

export interface ControlState {
  owner: ControlOwner
  /** 当前 run(没有则为 null) */
  runId: string | null
  /** agent 是否正被挂起等待交还控制权 */
  agentWaiting: boolean
  /** 进入 manual 的原因:用户主动接管,还是 agent 主动请求人工处理 */
  reason: 'user' | 'agent-request' | null
  /** agent 请求接管时留给用户的说明(如「这里需要登录」) */
  message: string | null
}

// ---------- 执行与反馈 ----------

export type RunStatus = 'running' | 'done' | 'error' | 'aborted'
export type StepStatus = 'running' | 'done' | 'error' | 'aborted'

export interface RunStep {
  index: number
  title: string
  status: StepStatus
  /** 步骤过程中产生的说明行,按时间顺序 */
  notes: string[]
  startedAt: number
  endedAt?: number
  error?: string
}

export interface RunState {
  id: string
  prompt: string
  /** 本次请求附带的图片数量(不存 base64,避免 run 状态被撑大) */
  imageCount?: number
  targetId: number
  status: RunStatus
  steps: RunStep[]
  startedAt: number
  endedAt?: number
  summary?: string
  error?: string
}

export type RunEvent =
  | { type: 'run-started'; runId: string; run: RunState }
  | { type: 'step-started'; runId: string; step: RunStep }
  | { type: 'step-note'; runId: string; index: number; note: string }
  | { type: 'step-finished'; runId: string; step: RunStep }
  | { type: 'run-finished'; runId: string; run: RunState }
  | { type: 'control-changed'; runId: string | null; control: ControlState }

/** 用户随消息附带的图片 */
export interface ImageAttachment {
  /** 原始文件名,仅用于 UI 展示 */
  name: string
  /** image/png | image/jpeg | image/webp | image/gif */
  mediaType: string
  /** base64(不含 data: 前缀) */
  data: string
}

export interface StartRunPayload {
  prompt: string
  targetId: number
  /** 用户附带的图片。模型不读图时会被忽略并在 UI 里说明。 */
  images?: ImageAttachment[]
}

// ---------- preload 暴露的 API ----------

export interface Api {
  cdp: {
    listTargets: () => Promise<CdpTarget[]>
    attach: (targetId: number) => Promise<{ ok: boolean; attached: boolean }>
    detach: (targetId: number) => Promise<{ ok: boolean; attached: boolean }>
    send: (targetId: number, method: string, params?: Record<string, unknown>) => Promise<unknown>
    onEvent: (cb: (event: CdpEvent) => void) => () => void
  }
  observe: {
    snapshot: (targetId: number, options?: SnapshotOptions) => Promise<PageSnapshot>
    screenshot: (targetId: number, options?: ScreenshotOptions) => Promise<Screenshot>
  }
  action: {
    run: (payload: ActionPayload) => Promise<string>
  }
  control: {
    /** 用户接管:agent 会在下一个动作边界挂起 */
    takeOver: () => Promise<ControlState>
    /** 把控制权交还 agent,可附带一句说明告诉它刚才做了什么 */
    handBack: (note?: string) => Promise<ControlState>
    get: () => Promise<ControlState>
  }
  run: {
    start: (payload: StartRunPayload) => Promise<{ runId: string }>
    abort: (runId: string) => Promise<{ ok: boolean }>
    get: (runId: string) => Promise<RunState | null>
    onEvent: (cb: (event: RunEvent) => void) => () => void
  }
  session: {
    /** 清空会话历史,下一条消息重新开始 */
    clear: () => Promise<{ ok: boolean }>
    /** 模型能力与历史长度,UI 据此决定是否允许附图 */
    info: () => Promise<SessionInfo>
  }
  status: {
    get: () => Promise<StatusInfo>
  }
}
