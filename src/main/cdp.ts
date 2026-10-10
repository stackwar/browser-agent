import { app, BrowserWindow, ipcMain, shell, webContents, type WebContents } from 'electron'
import * as actions from './actions'
import { captureScreenshot, snapshot } from './observe'
import { uploadImage } from './upload'
import { checkForUpdate, openDownload } from './update'
import { AVAILABLE_MODELS, hasApiKey, modelInfo } from './agent'
import * as settings from './settings'
import * as plugins from './plugins'
import {
  abortRun,
  activateSession,
  clearSession,
  clearTrace,
  createSession,
  getControl,
  getRun,
  getSessionInfo,
  getSessionTranscript,
  getTrace,
  handBackControl,
  listSessions,
  removeSession,
  startRun,
  takeOverControl
} from './run'
import type {
  ActionPayload,
  AppSettings,
  CdpTarget,
  ImageAttachment,
  ScreenshotOptions,
  SettingsInfo,
  SnapshotOptions,
  StartRunPayload
} from '../shared/types'

/**
 * 轻量 CDP 控制器,基于 Electron 的 webContents.debugger API。
 *
 * 两条控制通道:
 * 1. 进程内:渲染层(或未来内嵌的 Agent)通过 IPC 调用 attach/detach/send,
 *    对任意 target(主窗口 / <webview>)下发原始 Chrome DevTools Protocol 命令。
 * 2. 进程外:外部 Agent 通过 `--remote-debugging-port` 暴露的 WebSocket 端点
 *    直接连接(Playwright connectOverCDP / browser-use 均走这条路径)。
 *
 * 注意两条通道对**同一个 target** 是互斥的:CDP 的一个 target 只能被一个
 * 调试客户端占用,外部 Agent 接管后进程内 attach 会失败,反之亦然。
 */

let remoteDebuggingPort = 9222
/** 外部调试端口是否已开启。默认不开 —— 见 index.ts 的说明(安全硬化)。 */
let debugEnabled = false

/** 必须在 app ready 之前调用,才能让远程调试端口生效。 */
export function setRemoteDebuggingPort(port: number): void {
  remoteDebuggingPort = port
  debugEnabled = true
  app.commandLine.appendSwitch('remote-debugging-port', String(port))
  // 仅监听本机,避免端口暴露到公网
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
}

/** 外部 CDP 端点;未开启时返回空串 */
export function getRemoteDebuggingEndpoint(): string {
  return debugEnabled ? `http://127.0.0.1:${remoteDebuggingPort}` : ''
}

function listTargets(): CdpTarget[] {
  return webContents
    .getAllWebContents()
    .filter((wc) => !wc.isDestroyed())
    .map((wc) => ({
      id: wc.id,
      type: wc.getType(),
      title: wc.getTitle(),
      url: wc.getURL(),
      attached: wc.debugger.isAttached()
    }))
}

// 已安装事件转发的 webContents,避免重复挂监听
const forwarded = new WeakSet<WebContents>()

function ensureEventForwarding(wc: WebContents): void {
  if (forwarded.has(wc)) return
  forwarded.add(wc)
  // 把 CDP 事件转发到所有渲染窗口,供 Agent 订阅页面事件流
  wc.debugger.on('message', (_event, method, params) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send('cdp:event', { targetId: wc.id, method, params })
    }
  })
}

function attach(targetId: number): { ok: boolean; attached: boolean } {
  const wc = webContents.fromId(targetId)
  if (!wc) throw new Error(`未找到 target ${targetId}`)
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  ensureEventForwarding(wc)
  return { ok: true, attached: wc.debugger.isAttached() }
}

function detach(targetId: number): { ok: boolean; attached: boolean } {
  const wc = webContents.fromId(targetId)
  if (!wc) return { ok: false, attached: false }
  if (wc.debugger.isAttached()) wc.debugger.detach()
  return { ok: true, attached: wc.debugger.isAttached() }
}

async function send(
  targetId: number,
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  const wc = webContents.fromId(targetId)
  if (!wc) throw new Error(`未找到 target ${targetId}`)
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
  ensureEventForwarding(wc)
  return await wc.debugger.sendCommand(method, params)
}

export function registerCdpHandlers(): void {
  // 对新创建的 webContents(包括 <webview>)提前挂上事件转发
  app.on('web-contents-created', (_event, contents) => ensureEventForwarding(contents))

  ipcMain.handle('cdp:targets', () => listTargets())
  ipcMain.handle('cdp:attach', (_event, targetId: number) => attach(targetId))
  ipcMain.handle('cdp:detach', (_event, targetId: number) => detach(targetId))
  ipcMain.handle(
    'cdp:send',
    (_event, payload: { targetId: number; method: string; params?: Record<string, unknown> }) =>
      send(payload.targetId, payload.method, payload.params)
  )

  // 观察层
  ipcMain.handle(
    'observe:snapshot',
    (_event, payload: { targetId: number; options?: SnapshotOptions }) =>
      snapshot(payload.targetId, payload.options)
  )
  ipcMain.handle(
    'observe:screenshot',
    (_event, payload: { targetId: number; options?: ScreenshotOptions }) =>
      captureScreenshot(payload.targetId, payload.options)
  )

  // 工具层:把动作暴露给渲染层(内嵌 Agent 用,也便于单独调试)
  ipcMain.handle('action:run', async (_event, payload: ActionPayload) => {
    switch (payload.action) {
      case 'navigate':
        return await actions.navigate(payload.targetId, payload.url)
      case 'click':
        return await actions.click(payload.targetId, await actions.observe(payload.targetId), payload.index)
      case 'type':
        return await actions.type(
          payload.targetId,
          await actions.observe(payload.targetId),
          payload.index,
          payload.text,
          payload.submit
        )
      case 'scroll':
        return await actions.scroll(payload.targetId, payload.direction, payload.amount)
      case 'goBack':
        return await actions.goBack(payload.targetId)
      case 'readText':
        return await actions.readText(payload.targetId)
    }
  })

  // 执行层
  ipcMain.handle('run:start', (_event, payload: StartRunPayload) => startRun(payload))
  ipcMain.handle('run:abort', (_event, runId: string) => abortRun(runId))
  ipcMain.handle('run:get', (_event, runId: string) => getRun(runId))

  ipcMain.handle('control:takeover', () => takeOverControl())
  ipcMain.handle('control:handback', (_event, note?: string) => handBackControl(note))
  ipcMain.handle('control:get', () => getControl())

  // 会话层
  ipcMain.handle('session:clear', () => clearSession())
  ipcMain.handle('session:info', () => getSessionInfo())
  ipcMain.handle('session:list', () => listSessions())
  ipcMain.handle('session:create', () => createSession())
  ipcMain.handle('session:activate', (_event, id: string) => activateSession(id))
  ipcMain.handle('session:remove', (_event, id: string) => removeSession(id))
  ipcMain.handle('session:transcript', (_event, id: string) => getSessionTranscript(id))

  ipcMain.handle('status:get', () => ({
    debugPort: debugEnabled ? remoteDebuggingPort : 0,
    endpoint: getRemoteDebuggingEndpoint()
  }))

  // 图片上传(集成 cos-image-upload skill)
  ipcMain.handle('upload:image', (_event, image: ImageAttachment) => uploadImage(image))

  // 设置
  const settingsInfo = (): SettingsInfo => {
    const s = settings.get()
    return {
      model: modelInfo().model,
      maxTurns: s.maxTurns,
      models: AVAILABLE_MODELS.map((m) => ({ id: m.id, name: m.name, vision: m.vision })),
      hasApiKey: hasApiKey(),
      theme: s.theme,
      custom: {
        enabled: s.custom.enabled,
        baseURL: s.custom.baseURL,
        model: s.custom.model,
        vision: s.custom.vision,
        hasKey: Boolean(s.custom.apiKey)
      }
    }
  }
  ipcMain.handle('settings:get', () => settingsInfo())
  ipcMain.handle('settings:update', (_event, patch: Partial<AppSettings>) => {
    settings.update(patch)
    return settingsInfo()
  })

  // 插件
  ipcMain.handle('plugins:list', () => plugins.list())
  ipcMain.handle('plugins:reload', () => plugins.reload())
  ipcMain.handle('plugins:dir', () => ({ path: plugins.dir() }))
  ipcMain.handle('plugins:openDir', async () => {
    const path = plugins.dir()
    await shell.openPath(path)
    return { path }
  })

  // 执行轨迹
  ipcMain.handle('trace:get', (_event, sessionId: string) => getTrace(sessionId))
  ipcMain.handle('trace:clear', (_event, sessionId: string) => clearTrace(sessionId))

  // 检查更新
  ipcMain.handle('update:check', () => checkForUpdate())
  ipcMain.handle('update:open', (_event, url: string) => openDownload(url))
}
