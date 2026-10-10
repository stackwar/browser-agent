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

/** 一个可选模型及其能力 */
export interface ModelOption {
  id: string
  name: string
  /** 是否读图 */
  vision: boolean
}

/** 开发者自定义模型(OpenAI 兼容端点)。隐藏功能,不对普通用户开放。 */
export interface CustomModelConfig {
  /** 启用后覆盖内置模型选择,直连该端点(标准 OpenAI 协议,不发 aihub 计费头) */
  enabled: boolean
  /** OpenAI 兼容 baseURL,如 https://api.openai.com/v1 */
  baseURL: string
  /** 密钥。仅主进程读取,不回传渲染层。 */
  apiKey: string
  /** 模型 id,如 gpt-4o */
  model: string
  /** 是否读图 */
  vision: boolean
}

/** 可持久化的应用设置 */
export interface AppSettings {
  /** 选中的模型 id;空串表示用环境变量 / 默认值 */
  model: string
  /** 与模型的往返轮次上限 */
  maxTurns: number
  /** DeepSeek API key;空串表示用环境变量 DEEPSEEK_API_KEY */
  apiKey: string
  /** 界面主题 */
  theme: 'dark' | 'light'
  /** 开发者自定义模型(隐藏) */
  custom: CustomModelConfig
}

/** 设置面板用:当前生效设置 + 可选模型列表 */
export interface SettingsInfo {
  /** 当前生效的模型 id */
  model: string
  maxTurns: number
  models: ModelOption[]
  /** 是否已配置 API key(设置里或环境变量)。不回传密钥本身。 */
  hasApiKey: boolean
  /** 界面主题 */
  theme: 'dark' | 'light'
  /** 开发者自定义模型配置(隐藏);不含密钥,只回传是否已配置 */
  custom: {
    enabled: boolean
    baseURL: string
    model: string
    vision: boolean
    /** 是否已配置自定义密钥 */
    hasKey: boolean
  }
}

/** 已加载的插件工具信息(设置面板展示用) */
export interface PluginToolInfo {
  name: string
  description: string
  /** 来源插件(目录名) */
  plugin: string
}

/** 轨迹里一行:对应一条模型消息或一次工具调用 */
export interface TraceEntry {
  role: 'system' | 'user' | 'context' | 'assistant' | 'tool'
  /** 文本内容(system/user/context/assistant 用) */
  content: string
  /** 工具调用(role=tool 时):名称、入参、返回 */
  tool?: { name: string; args: string; result: string }
  /** 属于第几轮(从 1 起;同一次 run 内自增) */
  turn: number
  /** 所属 run */
  runId: string
  /** 该条目耗时(毫秒),目前工具调用有真实值,其余为 0/缺省 */
  ms?: number
}

/** 检查更新结果 */
export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  /** 是否有可用新版本 */
  hasUpdate: boolean
  /** 新版本下载地址 */
  url: string
  /** 更新说明 */
  notes: string
  /** 检查失败时的错误(网络 / 清单缺失等);有则视作「未检测到更新」 */
  error?: string
}

export interface SessionInfo {
  /** 历史里的消息条数(当前活动会话) */
  messages: number
  /** 当前活动会话 id */
  activeId: string
  /** 当前模型 ID */
  model: string
  /** 当前模型是否读图 —— 决定 UI 是否放开附图入口 */
  vision: boolean
}

/** 会话列表项:给历史会话列表 UI 用的轻量元信息,不含消息体 */
export interface SessionMeta {
  id: string
  /** 标题(取首条用户消息,空会话显示占位名) */
  title: string
  createdAt: number
  updatedAt: number
  /** 该会话的消息条数 */
  messageCount: number
}

/**
 * 用于展示的会话消息。
 *
 * 历史会话的 UI 回放从主进程存的模型消息里重建:只取 user / assistant 的文本,
 * 工具调用、工具结果、截图都不展示(它们是执行细节,不是对话内容)。
 */
export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
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
  | { type: 'assistant-delta'; runId: string; text: string }
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
  /** 上传到对象存储后的公网链接;有则模型用它当 image_url,省去 base64 */
  url?: string
}

export interface StartRunPayload {
  prompt: string
  targetId: number
  /** 用户附带的图片。模型不读图时会被忽略并在 UI 里说明。 */
  images?: ImageAttachment[]
  /** 用户附带的文档(pdf/excel/word/文本等),主进程解析为文本后并入消息 */
  files?: FileAttachment[]
}

/** 用户附带的文档文件(非图片)。主进程解析为文本喂给模型。 */
export interface FileAttachment {
  /** 文件名 */
  name: string
  /** MIME 类型(可能为空,按扩展名兜底) */
  mediaType: string
  /** base64(不含 data: 前缀) */
  data: string
  /** 字节数,仅用于 UI 展示 */
  size: number
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
    /** 清空当前活动会话的历史 */
    clear: () => Promise<{ ok: boolean }>
    /** 模型能力、历史长度与当前活动会话 id */
    info: () => Promise<SessionInfo>
    /** 历史会话列表(按最近更新排序) */
    list: () => Promise<SessionMeta[]>
    /** 新建一个空会话并切为活动,返回其元信息 */
    create: () => Promise<SessionMeta>
    /** 切换活动会话 */
    activate: (id: string) => Promise<{ ok: boolean }>
    /** 删除一个会话 */
    remove: (id: string) => Promise<{ ok: boolean }>
    /** 取某个会话用于回放展示的消息 */
    transcript: (id: string) => Promise<SessionMessage[]>
  }
  status: {
    get: () => Promise<StatusInfo>
  }
  upload: {
    /** 把图片上传到对象存储,返回公网链接(集成 cos-image-upload skill) */
    image: (image: ImageAttachment) => Promise<{ url: string }>
  }
  settings: {
    /** 当前生效设置 + 可选模型 */
    get: () => Promise<SettingsInfo>
    /** 更新设置(局部),返回更新后的生效设置 */
    update: (patch: Partial<AppSettings>) => Promise<SettingsInfo>
  }
  plugins: {
    /** 已加载的插件工具 */
    list: () => Promise<PluginToolInfo[]>
    /** 重新扫描插件目录并重载 */
    reload: () => Promise<PluginToolInfo[]>
    /** 在系统文件管理器里打开插件目录 */
    openDir: () => Promise<{ path: string }>
    /** 插件目录路径 */
    dir: () => Promise<{ path: string }>
  }
  trace: {
    /** 取某会话的完整执行轨迹(本次应用运行期间产生的) */
    get: (sessionId: string) => Promise<TraceEntry[]>
    /** 清空某会话的轨迹 */
    clear: (sessionId: string) => Promise<{ ok: boolean }>
  }
  update: {
    /** 检查是否有新版本 */
    check: () => Promise<UpdateInfo>
    /** 打开下载地址(系统浏览器) */
    openDownload: (url: string) => Promise<void>
  }
}
