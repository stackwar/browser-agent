import type { ControlOwner, ControlState } from '../shared/types'

/**
 * 人工接管的状态机。
 *
 * 为什么需要互斥:<webview> 里用户的真实鼠标键盘和 agent 下发的
 * Input.dispatchMouseEvent 走同一个输入通道。两边同时操作不是「协作」,
 * 而是互相打断 —— 用户正在填表时 agent 点了别处,焦点就跑了。
 * 所以控制权同一时刻只有一方持有。
 *
 * 接管的生效点是**动作边界**:已经发出的 CDP 命令无法撤回,
 * 所以 takeOver() 不会打断正在执行的动作,只保证下一个动作之前会挂起。
 * 这与 abort 的语义不同 —— abort 是放弃整个 run,接管是暂停后还要继续。
 */

export class ControlAbortedError extends Error {
  constructor() {
    super('已中断')
    this.name = 'ControlAbortedError'
  }
}

type Listener = (state: ControlState) => void

interface Waiter {
  resolve: () => void
  reject: (err: Error) => void
}

let owner: ControlOwner = 'idle'
let runId: string | null = null
let agentWaiting = false
let reason: ControlState['reason'] = null
let message: string | null = null

/** 用户在接管期间做了什么 —— 交还控制权时作为上下文回给模型 */
let manualNotes: string[] = []

/** 正在等待控制权交还的 agent(同一时刻最多一个 run 在跑,但用数组保证不漏) */
let waiters: Waiter[] = []

const listeners = new Set<Listener>()

export function snapshot(): ControlState {
  return { owner, runId, agentWaiting, reason, message }
}

export function onChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  const state = snapshot()
  for (const listener of listeners) listener(state)
}

/** run 开始:agent 取得控制权 */
export function beginRun(id: string): ControlState {
  runId = id
  owner = 'agent'
  agentWaiting = false
  reason = null
  message = null
  manualNotes = []
  notify()
  return snapshot()
}

/** run 结束:控制权回到用户手里(idle 意味着没人跟他抢) */
export function endRun(id: string): void {
  if (runId !== id) return
  // 还挂着的 waiter 必须放掉,否则 agent 循环永远停在那里
  rejectWaiters(new ControlAbortedError())
  runId = null
  owner = 'idle'
  agentWaiting = false
  reason = null
  message = null
  manualNotes = []
  notify()
}

/**
 * 用户接管。没有 run 在跑时也可以调(owner 本就是 idle,用户随意操作),
 * 此时只是把状态显式标成 manual,让 UI 一致。
 */
export function takeOver(): ControlState {
  owner = 'manual'
  reason = 'user'
  message = null
  notify()
  return snapshot()
}

/**
 * agent 主动请求人工处理(登录、验证码、支付确认)。
 * 与用户主动接管的区别只在 reason 和那句说明 —— 状态机行为一致。
 */
export function requestManual(note: string): ControlState {
  owner = 'manual'
  reason = 'agent-request'
  message = note
  notify()
  return snapshot()
}

/** 把控制权交还 agent。note 会作为上下文带给模型。 */
export function handBack(note?: string): ControlState {
  if (note?.trim()) manualNotes.push(note.trim())

  // 没有 run 在跑时交还 = 回到 idle,不是 agent
  owner = runId ? 'agent' : 'idle'
  agentWaiting = false
  reason = null
  message = null
  notify()

  const pending = waiters
  waiters = []
  for (const waiter of pending) waiter.resolve()

  return snapshot()
}

function rejectWaiters(err: Error): void {
  const pending = waiters
  waiters = []
  for (const waiter of pending) waiter.reject(err)
}

/** run 被 abort 时调用:让挂起的 agent 循环立刻退出,而不是等人交还 */
export function releaseForAbort(id: string): void {
  if (runId !== id) return
  rejectWaiters(new ControlAbortedError())
}

/**
 * agent 在动作边界调用。处于 manual 时挂起,直到用户交还控制权或 run 被中断。
 *
 * 返回用户在接管期间留下的说明(没有则为空数组),调用方负责把它喂给模型 ——
 * 不然模型会以为页面还是它上次看到的样子。
 */
export async function waitForTurn(signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) throw new ControlAbortedError()
  if (owner !== 'manual') return takeManualNotes()

  agentWaiting = true
  notify()

  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { resolve, reject }
    waiters.push(waiter)

    const onAbort = (): void => {
      waiters = waiters.filter((w) => w !== waiter)
      reject(new ControlAbortedError())
    }
    signal.addEventListener('abort', onAbort, { once: true })

    // 无论哪条路径结束,都要摘掉监听,否则长 run 上会堆积
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    waiter.resolve = () => {
      cleanup()
      resolve()
    }
    waiter.reject = (err) => {
      cleanup()
      reject(err)
    }
  })

  return takeManualNotes()
}

/** 取走并清空接管期间的说明 —— 同一批说明不该重复喂给模型 */
function takeManualNotes(): string[] {
  if (manualNotes.length === 0) return []
  const notes = manualNotes
  manualNotes = []
  return notes
}

export function isManual(): boolean {
  return owner === 'manual'
}
