import type { PageSnapshot } from '../shared/types'

/**
 * 可扩展工具注册表。
 *
 * 内置的浏览器动作(observe/click/type/…)仍写在 agent.ts 里 —— 它们和执行循环、
 * 控制权、快照回传耦合很深,不走这里。这里收的是**额外**工具:插件 / skill /
 * 将来的 MCP 工具注册进来后,agent 的 tool schema 和分发会自动带上它们,
 * 不必再改 agent.ts。
 */

export interface ToolRunContext {
  targetId: number
  /** 最近一次页面快照,插件工具若需要页面上下文可用(可能为 null) */
  lastSnapshot: PageSnapshot | null
}

export interface RegisteredTool {
  name: string
  description: string
  /** JSON Schema,对应 function.parameters */
  parameters: object
  /** 执行并返回给模型的文本结果;抛错会被 agent 当作工具错误回传给模型 */
  run: (input: Record<string, unknown>, ctx: ToolRunContext) => Promise<string>
  /** 来源(插件目录名),仅用于展示 */
  source?: string
}

/** 内置工具名,禁止被插件覆盖 */
const RESERVED = new Set([
  'observe',
  'navigate',
  'click',
  'type',
  'scroll',
  'go_back',
  'read_text',
  'request_manual'
])

const registry = new Map<string, RegisteredTool>()

export function isReserved(name: string): boolean {
  return RESERVED.has(name)
}

/** 注册一个工具。与内置重名会被拒;插件间重名后者覆盖前者并告警。 */
export function registerTool(tool: RegisteredTool): boolean {
  if (isReserved(tool.name)) {
    console.warn(`[tools] 工具 ${tool.name} 与内置工具重名,拒绝注册`)
    return false
  }
  if (registry.has(tool.name)) {
    console.warn(`[tools] 工具 ${tool.name} 被重复注册,后者覆盖前者`)
  }
  registry.set(tool.name, tool)
  return true
}

export function listTools(): RegisteredTool[] {
  return [...registry.values()]
}

export function getTool(name: string): RegisteredTool | undefined {
  return registry.get(name)
}

/** 清空注册表(重载插件前用) */
export function clearTools(): void {
  registry.clear()
}
