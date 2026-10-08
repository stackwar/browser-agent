import { app, BrowserWindow, ipcMain, webContents, type WebContents } from 'electron'
import * as actions from './actions'
import { captureScreenshot, snapshot } from './observe'
import {
  abortRun,
  clearSession,
  getControl,
  getRun,
  getSessionInfo,
  handBackControl,
  startRun,
  takeOverControl
} from './run'
import type {
  ActionPayload,
  CdpTarget,
  ScreenshotOptions,
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

/** 必须在 app ready 之前调用,才能让远程调试端口生效。 */
export function setRemoteDebuggingPort(port: number): void {
  remoteDebuggingPort = port
  app.commandLine.appendSwitch('remote-debugging-port', String(port))
  // 仅监听本机,避免端口暴露到公网
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
}

export function getRemoteDebuggingEndpoint(): string {
  return `http://127.0.0.1:${remoteDebuggingPort}`
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

  ipcMain.handle('status:get', () => ({
    debugPort: remoteDebuggingPort,
    endpoint: getRemoteDebuggingEndpoint()
  }))
}
