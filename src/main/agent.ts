import OpenAI from 'openai'
import type {
  ChatCompletionMessageParam,
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall
} from 'openai/resources/chat/completions'
import * as actions from './actions'
import * as control from './control'
import * as session from './session'
import type { ImageAttachment, PageSnapshot } from '../shared/types'

/**
 * LLM 接入层。整个模块只在主进程运行 —— API key 不进渲染层。
 *
 * 引擎是 DeepSeek,走它的 OpenAI 兼容端点(官方推荐方式,用 openai SDK
 * 换 baseURL 即可)。相比 Anthropic 的 messages 接口有三处实质差异:
 *
 * 1. **工具参数是 JSON 字符串**,不是结构化对象,必须自己解析且要容错 ——
 *    模型偶尔会吐出截断或带 markdown 围栏的 JSON。
 * 2. **工具结果是独立的 role: 'tool' 消息**,一条对应一个 tool_call_id,
 *    不像 Anthropic 把多个 tool_result 合进一条 user 消息。
 * 3. **图片走 image_url 而非 image block**,且只有部分模型读图(见下)。
 *
 * 用手写循环而非 SDK 的 runTools:我们需要在每次工具调用前后检查 AbortSignal、
 * 在动作边界让出控制权给人工接管、把每一步作为 step 推给 UI。
 *
 * 跨轮对话的历史由 session.ts 维护:这里每次从它取起点,结束时把本轮新增的
 * 消息交回去。system 提示不进历史 —— 每次重新拼上,改提示立刻生效。
 */

const DEFAULT_MODEL = 'deepseek-flash'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const MAX_TOKENS = 8000

/**
 * 支持图像输入的模型。DeepSeek 两个模型里只有 flash 读图
 * (/models 的 input_modalities 含 image),v4-pro 是纯文本。
 *
 * 给不读图的模型送截图只会白烧 token 还可能报错,所以 observe 的
 * screenshot 参数是否出现在 tool schema 里由这里决定 —— 模型看不到
 * 这个参数,就不会去调它。
 */
const VISION_MODELS = new Set(['deepseek-flash'])

/** 单条消息最多附几张图。再多模型也看不过来,还会把上下文挤爆。 */
const MAX_USER_IMAGES = 4

/** 可接受的图片类型。GIF 只取首帧,但 DeepSeek 兼容端点接受它。 */
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function currentModel(): string {
  return process.env.BROWSER_AGENT_MODEL || DEFAULT_MODEL
}

function supportsVision(model: string): boolean {
  return VISION_MODELS.has(model)
}

/** 给 UI 用:当前模型是什么、能不能读图 */
export function modelInfo(): { model: string; vision: boolean } {
  const model = currentModel()
  return { model, vision: supportsVision(model) }
}

export interface AgentDeps {
  /** 汇报一个动作的开始,返回结束回调(failed 为 true 时该步骤标记为失败) */
  onAction: (title: string) => (note: string, failed?: boolean) => void
  /** 汇报模型的思考文本 */
  onText: (text: string) => void
  signal: AbortSignal
}

export function hasApiKey(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY)
}

function createClient(): OpenAI {
  return new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
  })
}

/** 动作工具集。描述要写清楚 index 的来源,否则模型会凭空编号。 */
function buildTools(vision: boolean): ChatCompletionFunctionTool[] {
  return [
  {
    type: 'function',
    function: {
      name: 'observe',
      description:
        '观察当前页面,返回带编号的可交互元素列表、URL、标题和滚动位置。' +
        '其它动作引用的 index 全部来自这里,页面变化后必须重新 observe 才能拿到有效编号。',
      parameters: vision
        ? {
            type: 'object',
            properties: {
              screenshot: {
                type: 'boolean',
                description:
                  '是否同时返回截图。元素列表不足以判断布局或视觉状态时才用,会显著增加开销。'
              }
            }
          }
        : { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: '把浏览器导航到指定 URL。只支持 http/https。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '目标地址,可省略协议头' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: '点击一个元素。index 取自最近一次 observe 的结果。离屏元素会先滚进视口。',
      parameters: {
        type: 'object',
        properties: { index: { type: 'number', description: '最近一次 observe 返回的元素编号' } },
        required: ['index']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description: '在输入框里输入文本(会先清空原有内容)。index 取自最近一次 observe。',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: '最近一次 observe 返回的元素编号' },
          text: { type: 'string', description: '要输入的文本' },
          submit: { type: 'boolean', description: '输入后是否按回车提交,搜索框通常需要' }
        },
        required: ['index', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: '滚动页面。observe 显示「下方有更多内容」时用它翻页。',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] },
          amount: { type: 'number', description: '像素数,省略则滚动约一屏' }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'go_back',
      description: '浏览器后退一步。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_text',
      description:
        '读取页面可见正文。observe 只给可交互元素,需要理解页面内容(文章、搜索结果、价格等)时用这个。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'request_manual',
      description:
        '把浏览器交给用户本人操作,并等待他完成。遇到登录、验证码、支付确认这类' +
        '必须由用户本人决定的环节时调用。调用后你会挂起,直到用户点「交还控制权」,' +
        '返回值里会带上他做了什么。不要用它来回避普通的页面操作。',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: '告诉用户需要他做什么,例如「这里需要登录,请输入账号密码后交还」'
          }
        },
        required: ['reason']
      }
    }
  }
  ]
}

/**
 * 系统提示。截图那条只对读图模型给 —— 纯文本模型的 observe 没有
 * screenshot 参数,提了它只会让模型对用户吹自己能看图。
 */
function buildSystem(vision: boolean): string {
  const visual = vision
    ? '\n- 元素列表不足以判断布局或视觉状态时,observe 可以带 screenshot 取一张截图(开销较大,别每步都拍)。' +
      '\n- 用户可能随消息附带图片,那是任务的一部分(例如「照着这张图填表」),要看图再动手。'
    : '\n- 你看不到图像:既不能截图,也读不了用户附带的图片。需要知道页面写了什么就用 read_text。'

  return `你是一个浏览器操作助手,通过工具操作用户面前的浏览器来完成任务。

工作方式:
- 先 observe 看清页面,再动作。每次页面变化(点击、导航、滚动)后都要重新 observe,因为元素编号会变。
- click 和 type 的 index 必须来自最近一次 observe 的返回,不要沿用旧编号,也不要自己编。
- 需要理解页面写了什么(而不是有哪些可点的东西)时用 read_text。${visual}
- 任务完成后,直接用文字回答用户,不要再调工具。
- 遇到登录页、验证码、支付确认这类需要用户本人决定的环节,调用 request_manual 交给他处理,不要尝试代替用户操作。
- 用户可能随时接管浏览器自己操作。重新拿到控制权后,页面可能已经变了 —— 先 observe 再继续,别沿用接管前的编号。

回答用中文,简洁说明你做了什么、结果是什么。`
}

interface ToolOutcome {
  /** 回给模型的文本 */
  content: string
  /** 若这次动作产生了新快照,带回来给后续动作做坐标依据 */
  snapshot?: PageSnapshot
  /** 截图,仅在读图模型上产生 */
  screenshot?: { format: 'png' | 'jpeg'; data: string }
  isError?: boolean
}

/**
 * 解析模型给的工具参数。
 *
 * DeepSeek 返回的是 JSON 字符串,偶尔带 markdown 围栏或被截断。解析失败时
 * 返回 null 让调用方把错误回给模型,而不是抛出去终止整个 run。
 */
function parseArgs(raw: string): Record<string, unknown> | null {
  const text = raw.trim()
  if (!text) return {}
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(unfenced)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** 执行一次工具调用。约定:任何失败都作为工具结果的错误内容回给模型,让它自己纠偏。 */
async function runTool(
  name: string,
  input: Record<string, unknown>,
  targetId: number,
  lastSnapshot: PageSnapshot | null,
  vision: boolean
): Promise<ToolOutcome> {
  // click / type 需要快照来把 index 翻译成坐标。模型可能不先 observe 就直接动作
  // (尤其在多轮对话里它以为自己还记得页面),这时自己补一张,而不是让它多跑一轮。
  const needSnapshot = async (): Promise<PageSnapshot> =>
    lastSnapshot ?? (await actions.observe(targetId))

  switch (name) {
    case 'observe': {
      // 只有读图模型才拍截图 —— 非读图模型的 schema 里压根没这个参数,
      // 但多一层 vision 判断,防的是模型硬塞一个它不该知道的参数。
      const wantShot = vision && input.screenshot === true
      const snap = await actions.observe(targetId, wantShot)
      return {
        content: snap.text,
        snapshot: snap,
        screenshot: snap.screenshot
          ? { format: snap.screenshot.format, data: snap.screenshot.data }
          : undefined
      }
    }
    case 'navigate': {
      const msg = await actions.navigate(targetId, String(input.url ?? ''))
      // 导航后旧快照必然失效,顺手给一份新的,省一轮往返
      const snap = await actions.observe(targetId)
      return { content: `${msg}\n\n${snap.text}`, snapshot: snap }
    }
    case 'click': {
      const msg = await actions.click(targetId, await needSnapshot(), Number(input.index))
      const snap = await actions.observe(targetId)
      return { content: `${msg}\n\n${snap.text}`, snapshot: snap }
    }
    case 'type': {
      const msg = await actions.type(
        targetId,
        await needSnapshot(),
        Number(input.index),
        String(input.text ?? ''),
        input.submit === true
      )
      const snap = await actions.observe(targetId)
      return { content: `${msg}\n\n${snap.text}`, snapshot: snap }
    }
    case 'scroll': {
      const dir = String(input.direction) as 'down' | 'up' | 'top' | 'bottom'
      const msg = await actions.scroll(
        targetId,
        dir,
        input.amount ? Number(input.amount) : undefined
      )
      const snap = await actions.observe(targetId)
      return { content: `${msg}\n\n${snap.text}`, snapshot: snap }
    }
    case 'go_back': {
      const msg = await actions.goBack(targetId)
      const snap = await actions.observe(targetId)
      return { content: `${msg}\n\n${snap.text}`, snapshot: snap }
    }
    case 'read_text':
      return { content: await actions.readText(targetId) }
    default:
      return { content: `未知工具: ${name}`, isError: true }
  }
}

/**
 * 把用户这条消息拼成 API 的 message。
 *
 * 没有图片时用纯字符串 —— 纯文本模型只认这个形状;有图片时才切成
 * text + image_url 的 parts 数组。
 */
function buildUserMessage(prompt: string, images: ImageAttachment[]): ChatCompletionMessageParam {
  if (images.length === 0) return { role: 'user', content: prompt }
  return {
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      ...images.map((img) => ({
        type: 'image_url' as const,
        image_url: { url: `data:${img.mediaType};base64,${img.data}` }
      }))
    ]
  }
}

/** 丢掉类型不对的图片,并裁到数量上限 */
function acceptImages(images: ImageAttachment[]): ImageAttachment[] {
  return images
    .filter((img) => ALLOWED_IMAGE_TYPES.has(img.mediaType) && Boolean(img.data))
    .slice(0, MAX_USER_IMAGES)
}

/** 给 UI 用的动作摘要,比工具名可读 */
function describeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'observe':
      return input.screenshot ? '观察页面(含截图)' : '观察页面'
    case 'navigate':
      return `导航到 ${input.url}`
    case 'click':
      return `点击元素 [${input.index}]`
    case 'type':
      return `输入「${String(input.text ?? '').slice(0, 20)}」到 [${input.index}]${input.submit ? ' 并回车' : ''}`
    case 'scroll':
      return `滚动页面(${input.direction})`
    case 'go_back':
      return '浏览器后退'
    case 'read_text':
      return '读取页面正文'
    case 'request_manual':
      return '请求人工处理'
    default:
      return name
  }
}

class AbortedError extends Error {
  constructor() {
    super('已中断')
    this.name = 'AbortedError'
  }
}

/** 把接管期间用户留下的说明拼成一段喂给模型的文本 */
function describeManualNotes(notes: string[]): string {
  if (notes.length === 0) {
    return '用户已交还控制权,没有留下说明。页面可能已变化,请重新 observe。'
  }
  return `用户已交还控制权。他说:${notes.join(';')}\n\n页面可能已变化,请重新 observe 再继续。`
}

/**
 * 跑一次完整的 agent 循环,返回给用户的最终回答。
 *
 * maxTurns 限制的是与模型的往返次数 —— 每一轮里模型可能调多个工具。
 */
export async function runAgent(
  prompt: string,
  targetId: number,
  maxTurns: number,
  deps: AgentDeps,
  rawImages: ImageAttachment[] = []
): Promise<string> {
  const client = createClient()
  const model = currentModel()
  const vision = supportsVision(model)
  const tools = buildTools(vision)

  const images = vision ? acceptImages(rawImages) : []
  if (rawImages.length > 0 && !vision) {
    // 明确说出来而不是静默丢掉 —— 用户发了图却没人看是最糟的沉默失败
    deps.onAction(`当前模型 ${model} 不读图`)(
      `已忽略随消息附带的 ${rawImages.length} 张图片。换用支持读图的模型(如 deepseek-flash)后可用。`
    )
  } else if (images.length < rawImages.length) {
    deps.onAction('部分图片未采用')(
      `收到 ${rawImages.length} 张,采用 ${images.length} 张(超出 ${MAX_USER_IMAGES} 张上限或格式不支持)。`
    )
  }

  // 历史在前,本轮用户消息在后。system 不进历史,每次现拼。
  const prior = session.history()
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystem(vision) },
    ...prior,
    buildUserMessage(prompt, images)
  ]
  // 本轮新增消息的起点:结束时只把这之后的部分并入历史,避免历史被重复累加
  const freshFrom = messages.length - 1
  let lastSnapshot: PageSnapshot | null = null
  const replies: string[] = []
  /**
   * 用户接管后留下的说明,等下一条工具结果带给模型。
   *
   * 不能直接插一条 user 消息:assistant 的 tool_calls 和对应的 role:'tool'
   * 消息之间插别的东西会破坏协议。所以搭车在下一条工具结果前面。
   */
  let pendingManual: string | null = null
  /**
   * 本轮待发的截图。
   *
   * 不能塞进 role:'tool' 消息 —— OpenAI 形状的工具消息只接受文本 part,
   * 图片必须走独立的 user 消息。所以攒到本轮所有工具结果都 push 完之后
   * 再作为一条 user 消息补上,这样也不破坏 tool_calls 与 tool 回复的相邻性。
   */
  let pendingShots: { format: 'png' | 'jpeg'; data: string }[] = []

  // 不论正常收尾、中断还是报错,本轮消息都要并入历史 —— 中断留下的悬空
  // tool_calls 由 session 自己修掉,这里不必特殊处理。
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (deps.signal.aborted) throw new AbortedError()

      // 请求模型之前先确认控制权在自己手上 —— 用户可能在上一轮动作之后接管了
      {
        const notes = await yieldToManual(deps)
        if (notes) {
          // 轮次边界上没有待回的工具结果,可以直接作为 user 消息插进去
          lastSnapshot = null
          messages.push({ role: 'user', content: notes })
        }
      }

      const response = await client.chat.completions.create(
        {
          model,
          max_tokens: MAX_TOKENS,
          messages,
          tools
          // tool_choice 保持默认 auto:强制调工具会让模型没法用文字收尾
        },
        // SDK 支持 AbortSignal,中断时能立刻取消在途请求而不用等它返回
        { signal: deps.signal }
      )

      const choice = response.choices[0]
      if (!choice) return '模型没有返回任何内容。'

      const msg = choice.message

      // 安全策略拦下请求时 content 为空、refusal 带说明
      if (msg.refusal) {
        messages.push({ role: 'assistant', content: `(拒绝回答)${msg.refusal}` })
        return `模型拒绝了这个请求:${msg.refusal}`
      }

      const text = typeof msg.content === 'string' ? msg.content.trim() : ''
      if (text) {
        deps.onText(text)
        replies.push(text)
      }

      // 只处理 function 类型的 tool_call;custom tool 我们没注册,不会出现
      const toolCalls = (msg.tool_calls ?? []).filter(
        (c): c is ChatCompletionMessageFunctionToolCall => c.type === 'function'
      )

      // 模型不再调工具,说明它认为任务结束
      if (toolCalls.length === 0) {
        // 收尾的回答也要进历史,否则下一轮模型看不到自己刚说过什么
        if (text) messages.push({ role: 'assistant', content: text })
        return replies.length ? replies[replies.length - 1] : '(模型没有给出回答)'
      }

      // 回传给模型的 assistant 消息必须原样带上 tool_calls,否则下一轮
      // 的 role:'tool' 消息会因为找不到对应的 tool_call_id 被拒。
      messages.push({
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: msg.tool_calls
      })

      for (const call of toolCalls) {
        if (deps.signal.aborted) throw new AbortedError()

        const pushResult = (content: string): void => {
          const prefix = pendingManual ? `${pendingManual}\n\n` : ''
          pendingManual = null
          messages.push({ role: 'tool', tool_call_id: call.id, content: prefix + content })
        }

        const input = parseArgs(call.function.arguments)
        if (!input) {
          const note = `工具参数不是合法 JSON,无法执行:${call.function.arguments.slice(0, 100)}`
          // 参数没解析出来,就别用 describeTool 拼出「点击元素 [undefined]」这种话
          const done = deps.onAction(`${call.function.name}(参数无效)`)
          done(note, true)
          pushResult(`${note}\n请重新调用,参数必须是合法 JSON。`)
          continue
        }

        // 模型主动请求人工处理:把控制权交给用户并挂起等他做完
        if (call.function.name === 'request_manual') {
          const reason = String(input.reason ?? '需要你本人处理')
          const done = deps.onAction(`等待人工处理:${reason}`)
          control.requestManual(reason)
          try {
            const notes = await control.waitForTurn(deps.signal)
            done('用户已交还控制权')
            lastSnapshot = null // 接管期间页面大概率变了,旧快照的编号不可信
            pushResult(describeManualNotes(notes))
          } catch (err) {
            if (err instanceof control.ControlAbortedError || deps.signal.aborted) {
              done('已中断', true)
              throw new AbortedError()
            }
            throw err
          }
          continue
        }

        // 每个动作之前让出一次控制权 —— 这是接管生效的边界
        const resumeNote = await yieldToManual(deps)
        if (resumeNote) {
          lastSnapshot = null // 接管期间可能导航到别处,旧编号不可信
          pendingManual = resumeNote
        }

        const done = deps.onAction(describeTool(call.function.name, input))
        try {
          const outcome = await runTool(call.function.name, input, targetId, lastSnapshot, vision)
          if (outcome.snapshot) lastSnapshot = outcome.snapshot
          if (outcome.screenshot) pendingShots.push(outcome.screenshot)
          done(outcome.content.split('\n')[0])
          pushResult(outcome.content)
        } catch (err) {
          if (err instanceof AbortedError || err instanceof control.ControlAbortedError) {
            throw new AbortedError()
          }
          if (deps.signal.aborted) throw new AbortedError()
          // 动作失败不终止 run:把错误回给模型,让它换个做法
          const message = err instanceof Error ? err.message : String(err)
          done(message, true)
          pushResult(`执行失败:${message}`)
        }
      }

      // 工具结果都回完了,截图作为独立 user 消息补在后面。
      // 开头必须是 session.SCREENSHOT_NOTE —— 历史层靠它把截图和用户自己
      // 发的图区分开,换成别的文案会导致用户的图被截图挤掉。
      if (pendingShots.length > 0) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: session.SCREENSHOT_NOTE },
            ...pendingShots.map((shot) => ({
              type: 'image_url' as const,
              image_url: {
                url: `data:image/${shot.format === 'png' ? 'png' : 'jpeg'};base64,${shot.data}`
              }
            }))
          ]
        })
        pendingShots = []
      }
    }

    return replies.length
      ? `${replies[replies.length - 1]}\n\n(已达到 ${maxTurns} 轮上限,任务可能未完成)`
      : `已达到 ${maxTurns} 轮上限,任务未完成。`
  } finally {
    session.append(messages.slice(freshFrom), { keepUserImages: vision })
  }
}

/**
 * 在动作边界检查控制权。用户接管时挂起,直到他交还。
 *
 * 返回要带给模型的说明文本;没发生接管时返回 null,调用方据此决定是否
 * 清掉缓存快照 —— 接管期间用户可能导航到别的页面,沿用旧编号会点错东西。
 */
async function yieldToManual(deps: AgentDeps): Promise<string | null> {
  if (!control.isManual()) return null

  const done = deps.onAction('用户接管中,等待交还控制权')
  try {
    const notes = await control.waitForTurn(deps.signal)
    done(notes.length ? `用户:${notes.join(';')}` : '已交还控制权')
    return describeManualNotes(notes)
  } catch (err) {
    if (err instanceof control.ControlAbortedError || deps.signal.aborted) {
      done('已中断', true)
      throw new AbortedError()
    }
    throw err
  }
}
