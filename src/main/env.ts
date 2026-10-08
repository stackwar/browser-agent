import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/**
 * 从 .env 读配置。
 *
 * 为什么不用 dotenv:只需要「KEY=VALUE 一行一条」,为这点功能加个依赖不值得。
 *
 * 为什么不把 key 写进源码:那等于提交凭据。.env 已在 .gitignore 里。
 *
 * 查找顺序是「开发模式看项目根目录,打包后看 userData」—— 打包产物里
 * 没有项目根目录,而 userData 是用户可写的位置。
 */

/** 已存在的环境变量优先 —— 命令行显式传的不该被文件覆盖 */
function applyLine(line: string): void {
  const text = line.trim()
  if (!text || text.startsWith('#')) return

  const eq = text.indexOf('=')
  if (eq <= 0) return

  const key = text.slice(0, eq).trim()
  let value = text.slice(eq + 1).trim()

  // 去掉包裹的引号,但保留值内部的引号
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1)
  }

  if (!key || process.env[key] !== undefined) return
  process.env[key] = value
}

export function loadEnv(): void {
  const candidates = [
    join(app.getAppPath(), '.env'),
    join(process.cwd(), '.env'),
    join(app.getPath('userData'), '.env')
  ]

  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) applyLine(line)
    } catch {
      // 读不了就跳过:配置缺失会在 UI 里以「未配置 API key」的形式暴露出来,
      // 这里抛错只会让应用起不来。
    }
  }
}
