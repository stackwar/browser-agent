import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { PluginToolInfo } from '../shared/types'
import { clearTools, isReserved, listTools, registerTool } from './tools'

/**
 * 插件加载器:从插件目录扫描 `plugin.json` 清单,把其中声明的「命令型工具」
 * 注册进工具注册表,agent 下一次构建 tool schema 时就会带上它们。
 *
 * 「安装插件」= 往插件目录放一个文件夹(含 plugin.json 和脚本),然后重载。
 *
 * 插件目录:环境变量 BROWSER_AGENT_PLUGINS_DIR,否则 userData/plugins。
 *
 * ⚠️ 安全:命令型工具会在本机执行清单里声明的任意命令(与安装一个本地程序同等
 * 信任级别)。目录默认空、不联网、不自动安装 —— 只加载用户自己放进去的插件。
 *
 * plugin.json 形如:
 * {
 *   "name": "weather",
 *   "tools": [{
 *     "name": "get_weather",
 *     "description": "查询城市天气",
 *     "parameters": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] },
 *     "command": "python3",
 *     "args": ["weather.py"],
 *     "input": "stdin",        // stdin(默认)把入参 JSON 写进 stdin;arg 作为末位参数
 *     "timeoutMs": 30000
 *   }]
 * }
 * 约定:工具 stdout 作为结果回给模型,非 0 退出码按失败处理(stderr 作错误说明)。
 */

interface ManifestTool {
  name: string
  description?: string
  parameters?: object
  command: string
  args?: string[]
  input?: 'stdin' | 'arg'
  timeoutMs?: number
}

interface Manifest {
  name?: string
  tools?: ManifestTool[]
}

const DEFAULT_TIMEOUT = 30_000

export function dir(): string {
  return process.env.BROWSER_AGENT_PLUGINS_DIR || join(app.getPath('userData'), 'plugins')
}

/** 扫描插件目录并注册所有命令型工具。不清空已注册的工具。 */
export function loadPlugins(): void {
  const base = dir()
  // 顺手把目录建出来,方便用户直接往里放插件
  try {
    mkdirSync(base, { recursive: true })
  } catch {
    /* ignore */
  }

  let entries: string[]
  try {
    entries = readdirSync(base)
  } catch {
    return
  }

  for (const entry of entries) {
    const pdir = join(base, entry)
    const manifestPath = join(pdir, 'plugin.json')
    try {
      if (!statSync(pdir).isDirectory() || !existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest
      for (const t of manifest.tools ?? []) {
        if (!t.name || !t.command) {
          console.warn(`[plugins] ${entry}: 工具缺少 name 或 command,跳过`)
          continue
        }
        if (isReserved(t.name)) {
          console.warn(`[plugins] ${entry}: ${t.name} 与内置工具重名,跳过`)
          continue
        }
        registerTool({
          name: t.name,
          description: t.description || t.name,
          parameters: t.parameters ?? { type: 'object', properties: {} },
          source: manifest.name || entry,
          run: (input) => runCommandTool(pdir, t, input)
        })
        console.log(`[plugins] 已加载工具 ${t.name}(来自 ${entry})`)
      }
    } catch (err) {
      console.warn(`[plugins] 加载 ${entry} 失败:`, err)
    }
  }
}

/** 清空并重新加载 */
export function reload(): PluginToolInfo[] {
  clearTools()
  loadPlugins()
  return list()
}

export function list(): PluginToolInfo[] {
  return listTools().map((t) => ({
    name: t.name,
    description: t.description,
    plugin: t.source ?? ''
  }))
}

/** 启动命令型工具的子进程,入参 JSON 经 stdin 或末位参数传入,stdout 为结果 */
function runCommandTool(
  cwd: string,
  tool: ManifestTool,
  input: Record<string, unknown>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(input ?? {})
    const args = [...(tool.args ?? [])]
    if (tool.input === 'arg') args.push(payload)

    const child = spawn(tool.command, args, { cwd, env: process.env })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`工具 ${tool.name} 执行超时`))
    }, tool.timeoutMs ?? DEFAULT_TIMEOUT)

    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`无法启动 ${tool.command}:${e.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim() || '(工具无输出)')
      else reject(new Error(`工具 ${tool.name} 退出码 ${code}:${err.trim().slice(0, 300) || '无输出'}`))
    })

    if (tool.input !== 'arg') {
      child.stdin.write(payload)
      child.stdin.end()
    }
  })
}
