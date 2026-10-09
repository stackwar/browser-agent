import { app, shell } from 'electron'
import type { UpdateInfo } from '../shared/types'

/**
 * 检查更新(轻量版)。
 *
 * 拉一个远端 JSON 清单,和当前版本比较,有新版本就通知用户去下载。
 * 为什么不用 electron-updater 的「静默自动更新」:macOS 的自动更新要求应用
 * **已签名并公证**,当前是未签名分发包,自动更新装不上。等有签名了可再切到
 * electron-updater。
 *
 * 清单格式(托管在 BROWSER_AGENT_UPDATE_URL,或下面默认地址):
 *   { "version": "0.2.0", "url": "https://…/聚运赢-0.2.0-arm64.dmg", "notes": "更新说明" }
 */

const DEFAULT_FEED = 'https://kb-resources.juxieyun.com/ss/client/jyy/app/update.json'

function feedUrl(): string {
  return process.env.BROWSER_AGENT_UPDATE_URL || DEFAULT_FEED
}

function currentVersion(): string {
  // 开发态 app.getVersion() 会返回 Electron 版本,固定用应用自身版本
  return app.isPackaged ? app.getVersion() : '0.1.0'
}

/** 语义化版本比较:a>b 返回 1,a<b 返回 -1,相等 0 */
function compareVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = currentVersion()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    const res = await fetch(feedUrl(), { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const m = (await res.json()) as {
      version?: string
      url?: string
      notes?: string
      platforms?: Record<string, string>
    }
    const latest = String(m.version ?? '').trim()
    const hasUpdate = latest.length > 0 && compareVersion(latest, current) > 0
    // 按平台/架构选下载地址:platforms['darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'linux-x64' | …],
    // 没有对应项则回退到顶层 url
    const key = `${process.platform}-${process.arch}`
    const url = m.platforms?.[key] || m.url || ''
    return {
      currentVersion: current,
      latestVersion: latest || current,
      hasUpdate,
      url,
      notes: m.notes ?? ''
    }
  } catch (err) {
    return {
      currentVersion: current,
      latestVersion: current,
      hasUpdate: false,
      url: '',
      notes: '',
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

export async function openDownload(url: string): Promise<void> {
  if (/^https?:\/\//i.test(url)) await shell.openExternal(url)
}
