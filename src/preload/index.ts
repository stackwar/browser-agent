import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActionPayload,
  Api,
  CdpEvent,
  RunEvent,
  ScreenshotOptions,
  SnapshotOptions,
  StartRunPayload
} from '../shared/types'

/** 把 ipcRenderer.on 包成「订阅 + 返回退订函数」的形式 */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, data: T): void => cb(data)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: Api = {
  cdp: {
    listTargets: () => ipcRenderer.invoke('cdp:targets'),
    attach: (targetId: number) => ipcRenderer.invoke('cdp:attach', targetId),
    detach: (targetId: number) => ipcRenderer.invoke('cdp:detach', targetId),
    send: (targetId: number, method: string, params?: Record<string, unknown>) =>
      ipcRenderer.invoke('cdp:send', { targetId, method, params }),
    onEvent: (cb: (event: CdpEvent) => void) => subscribe<CdpEvent>('cdp:event', cb)
  },
  observe: {
    snapshot: (targetId: number, options?: SnapshotOptions) =>
      ipcRenderer.invoke('observe:snapshot', { targetId, options }),
    screenshot: (targetId: number, options?: ScreenshotOptions) =>
      ipcRenderer.invoke('observe:screenshot', { targetId, options })
  },
  action: {
    run: (payload: ActionPayload) => ipcRenderer.invoke('action:run', payload)
  },
  control: {
    takeOver: () => ipcRenderer.invoke('control:takeover'),
    handBack: (note?: string) => ipcRenderer.invoke('control:handback', note),
    get: () => ipcRenderer.invoke('control:get')
  },
  run: {
    start: (payload: StartRunPayload) => ipcRenderer.invoke('run:start', payload),
    abort: (runId: string) => ipcRenderer.invoke('run:abort', runId),
    get: (runId: string) => ipcRenderer.invoke('run:get', runId),
    onEvent: (cb: (event: RunEvent) => void) => subscribe<RunEvent>('run:event', cb)
  },
  session: {
    clear: () => ipcRenderer.invoke('session:clear'),
    info: () => ipcRenderer.invoke('session:info'),
    list: () => ipcRenderer.invoke('session:list'),
    create: () => ipcRenderer.invoke('session:create'),
    activate: (id: string) => ipcRenderer.invoke('session:activate', id),
    remove: (id: string) => ipcRenderer.invoke('session:remove', id),
    transcript: (id: string) => ipcRenderer.invoke('session:transcript', id)
  },
  status: {
    get: () => ipcRenderer.invoke('status:get')
  },
  upload: {
    image: (image) => ipcRenderer.invoke('upload:image', image)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch)
  },
  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    reload: () => ipcRenderer.invoke('plugins:reload'),
    openDir: () => ipcRenderer.invoke('plugins:openDir'),
    dir: () => ipcRenderer.invoke('plugins:dir')
  },
  trace: {
    get: (sessionId: string) => ipcRenderer.invoke('trace:get', sessionId),
    clear: (sessionId: string) => ipcRenderer.invoke('trace:clear', sessionId)
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    openDownload: (url: string) => ipcRenderer.invoke('update:open', url)
  }
}

contextBridge.exposeInMainWorld('api', api)
