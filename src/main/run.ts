import { BrowserWindow } from 'electron'
import { hasApiKey, modelInfo, runAgent } from './agent'
import * as control from './control'
import * as session from './session'
import * as settings from './settings'
import type {
  ControlState,
  ImageAttachment,
  RunEvent,
  RunState,
  RunStep,
  SessionInfo,
  SessionMeta,
  SessionMessage,
  StartRunPayload
} from '../shared/types'

/**
 * 执行层:把一次「让 Agent 做某件事」的请求组织成可观察、可中断的 run。
 *
 * 一个 run 由若干 step 组成,每个 step 的开始 / 说明 / 结束都实时推给渲染层,
 * 用户随时可以 abort。中断通过 AbortSignal 传导:
 * 长动作在每个 await 边界检查一次,取消后 run 状态转为 'aborted'。
 *
 * 每个工具调用对应一个 step:模型决定做什么(agent.ts),这里负责把过程
 * 变成可见的步骤流并处理中断。
 */

/** 与模型的往返轮次上限的默认值。实际值可在设置里改(settings.maxTurns)。 */
const DEFAULT_MAX_TURNS = 50
/** run 保留上限,超出后丢弃最旧的已结束 run,避免长期运行内存无上限增长 */
const MAX_RETAINED_RUNS = 20

interface RunEntry {
  state: RunState
  controller: AbortController
  /** 图片只在执行期间用,不进 RunState —— base64 太大,不该被 clone 到渲染层 */
  images: ImageAttachment[]
}

const runs = new Map<string, RunEntry>()
let runSeq = 0

// 控制权变化同样走 run 事件流,渲染层只需订阅一处
control.onChange((state: ControlState) => {
  emit({ type: 'control-changed', runId: state.runId, control: state })
})

class AbortedError extends Error {
  constructor() {
    super('已中断')
    this.name = 'AbortedError'
  }
}

function emit(event: RunEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send('run:event', event)
  }
}

/** 丢弃最旧的已结束 run */
function pruneRuns(): void {
  if (runs.size <= MAX_RETAINED_RUNS) return
  const finished = [...runs.entries()]
    .filter(([, entry]) => entry.state.status !== 'running')
    .sort(([, a], [, b]) => (a.state.endedAt ?? 0) - (b.state.endedAt ?? 0))
  for (const [id] of finished) {
    if (runs.size <= MAX_RETAINED_RUNS) break
    runs.delete(id)
  }
}

/** 步骤记录器:把一个步骤的生命周期与事件推送收在一处 */
class StepRecorder {
  constructor(
    private readonly runId: string,
    private readonly state: RunState
  ) {}

  private current: RunStep | null = null

  /** 是否有进行中的步骤 */
  isOpen(): boolean {
    return this.current !== null
  }

  start(title: string): RunStep {
    const step: RunStep = {
      index: this.state.steps.length,
      title,
      status: 'running',
      notes: [],
      startedAt: Date.now()
    }
    this.state.steps.push(step)
    this.current = step
    emit({ type: 'step-started', runId: this.runId, step: { ...step, notes: [] } })
    return step
  }

  note(text: string): void {
    if (!this.current) return
    this.current.notes.push(text)
    emit({ type: 'step-note', runId: this.runId, index: this.current.index, note: text })
  }

  finish(status: RunStep['status'], error?: string): void {
    const step = this.current
    if (!step) return
    step.status = status
    step.endedAt = Date.now()
    if (error) step.error = error
    this.current = null
    emit({ type: 'step-finished', runId: this.runId, step: { ...step, notes: [...step.notes] } })
  }

  /** 把 fn 包成一个步骤,自动处理成功 / 中断 / 失败三种收尾 */
  async wrap<T>(title: string, fn: () => Promise<T>): Promise<T> {
    this.start(title)
    try {
      const result = await fn()
      this.finish('done')
      return result
    } catch (err) {
      if (err instanceof AbortedError) {
        this.finish('aborted')
      } else {
        this.finish('error', err instanceof Error ? err.message : String(err))
      }
      throw err
    }
  }
}

/**
 * 驱动一次 agent 循环。
 *
 * 模型的每个工具调用变成一个 step,思考文本作为 note 挂在当前 step 上
 * (没有进行中的 step 时新建一个「思考」step 承载它)。
 */
async function planAndAct(
  prompt: string,
  targetId: number,
  recorder: StepRecorder,
  signal: AbortSignal,
  images: ImageAttachment[]
): Promise<string> {
  if (!hasApiKey()) {
    throw new Error(
      '未配置 API key。设置环境变量 DEEPSEEK_API_KEY 后重启应用(可用 BROWSER_AGENT_MODEL 指定模型)。'
    )
  }

  return await runAgent(
    prompt,
    targetId,
    settings.get().maxTurns || DEFAULT_MAX_TURNS,
    {
      signal,
      onAction: (title) => {
        recorder.start(title)
        return (note: string, failed = false) => {
          if (note) recorder.note(note)
          recorder.finish(failed ? 'error' : 'done', failed ? note : undefined)
        }
      },
      onText: (text) => {
        // 模型在两次工具调用之间的说明:没有开着的 step 时单独立一步承载
        if (!recorder.isOpen()) recorder.start('思考')
        recorder.note(text)
        recorder.finish('done')
      }
    },
    images
  )
}

async function execute(entry: RunEntry): Promise<void> {
  const { state, controller } = entry
  const recorder = new StepRecorder(state.id, state)
  control.beginRun(state.id)

  try {
    const summary = await planAndAct(
      state.prompt,
      state.targetId,
      recorder,
      controller.signal,
      entry.images
    )
    state.status = 'done'
    state.summary = summary
  } catch (err) {
    if (err instanceof AbortedError || controller.signal.aborted) {
      state.status = 'aborted'
      state.summary = '已中断。'
    } else {
      state.status = 'error'
      state.error = err instanceof Error ? err.message : String(err)
    }
  } finally {
    // 先交还控制权再派发 run-finished:否则 UI 会短暂看到「run 结束了但还被 agent 占着」
    control.endRun(state.id)
    state.endedAt = Date.now()
    emit({ type: 'run-finished', runId: state.id, run: structuredClone(state) })
    pruneRuns()
  }
}

export function startRun(payload: StartRunPayload): { runId: string } {
  const prompt = payload.prompt?.trim()
  if (!prompt) throw new Error('指令不能为空')
  if (!Number.isInteger(payload.targetId)) throw new Error('targetId 无效')

  const images = Array.isArray(payload.images) ? payload.images : []

  const id = `run-${Date.now()}-${runSeq++}`
  const state: RunState = {
    id,
    prompt,
    imageCount: images.length || undefined,
    targetId: payload.targetId,
    status: 'running',
    steps: [],
    startedAt: Date.now()
  }
  const entry: RunEntry = { state, controller: new AbortController(), images }
  runs.set(id, entry)

  emit({ type: 'run-started', runId: id, run: structuredClone(state) })
  // 不 await:立即把 runId 还给渲染层,过程通过事件流推送
  void execute(entry)

  return { runId: id }
}

export function abortRun(runId: string): { ok: boolean } {
  const entry = runs.get(runId)
  if (!entry || entry.state.status !== 'running') return { ok: false }
  entry.controller.abort()
  // 挂在人工接管上的 agent 不吃 AbortSignal 以外的信号,显式放掉它
  control.releaseForAbort(runId)
  return { ok: true }
}

/** 用户接管浏览器。agent 会在下一个动作边界挂起。 */
export function takeOverControl(): ControlState {
  return control.takeOver()
}

/** 把控制权交还 agent,note 作为上下文带给模型 */
export function handBackControl(note?: string): ControlState {
  return control.handBack(note)
}

export function getControl(): ControlState {
  return control.snapshot()
}

export function getRun(runId: string): RunState | null {
  const entry = runs.get(runId)
  return entry ? structuredClone(entry.state) : null
}

/** 是否有 run 正在执行。切换/新建/删除会话期间若换掉活动会话,
 *  在跑的 agent 会在 finally 里把消息并进「新的」活动会话,historial 就乱了。 */
function hasRunningRun(): boolean {
  for (const entry of runs.values()) {
    if (entry.state.status === 'running') return true
  }
  return false
}

function assertIdle(): void {
  if (hasRunningRun()) throw new Error('有任务正在执行,请先停止或等待完成再切换会话')
}

/** 清空当前活动会话历史 */
export function clearSession(): { ok: boolean } {
  assertIdle()
  session.clear()
  return { ok: true }
}

/** 会话信息:当前活动会话历史长度 + 活动 id + 当前模型能力 */
export function getSessionInfo(): SessionInfo {
  const { messages, activeId } = session.stats()
  return { messages, activeId, ...modelInfo() }
}

/** 历史会话列表 */
export function listSessions(): SessionMeta[] {
  return session.list()
}

/** 新建会话并切为活动 */
export function createSession(): SessionMeta {
  assertIdle()
  return session.create()
}

/** 切换活动会话 */
export function activateSession(id: string): { ok: boolean } {
  assertIdle()
  return { ok: session.activate(id) }
}

/** 删除会话 */
export function removeSession(id: string): { ok: boolean } {
  assertIdle()
  session.remove(id)
  return { ok: true }
}

/** 取会话的展示用消息 */
export function getSessionTranscript(id: string): SessionMessage[] {
  return session.transcript(id)
}

/** 窗口全部关闭或应用退出时,别留下还在跑的 run */
export function abortAllRuns(): void {
  for (const entry of runs.values()) {
    if (entry.state.status === 'running') {
      entry.controller.abort()
      control.releaseForAbort(entry.state.id)
    }
  }
}
