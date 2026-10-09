import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import type { AppSettings } from '../shared/types'

/**
 * 应用设置(可在设置面板里改并持久化)。
 *
 * 存到 userData/settings.json。model 为空串表示「不覆盖」,由 agent 回退到
 * 环境变量 BROWSER_AGENT_MODEL 或内置默认值 —— 这样没点过设置的用户行为不变。
 */

const DEFAULTS: AppSettings = { model: '', maxTurns: 50, apiKey: '' }

let cache: AppSettings | null = null

function file(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function load(): AppSettings {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf-8')) as Partial<AppSettings>
    cache = { ...DEFAULTS, ...raw }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

export function get(): AppSettings {
  return { ...load() }
}

export function update(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...load(), ...patch }
  // maxTurns 兜底:别让 UI 传来 0 / 负数 / 非数把 run 卡死
  if (!Number.isFinite(next.maxTurns) || next.maxTurns < 1) next.maxTurns = DEFAULTS.maxTurns
  next.maxTurns = Math.min(200, Math.round(next.maxTurns))
  cache = next
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(file(), JSON.stringify(next), 'utf-8')
  } catch (err) {
    console.warn('[settings] 持久化失败:', err)
  }
  return { ...next }
}
