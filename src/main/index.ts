import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerCdpHandlers, setRemoteDebuggingPort } from './cdp'
import { loadEnv } from './env'
import { abortAllRuns } from './run'

// 先读 .env:下面的端口和 agent.ts 的 API key 都从 process.env 取
loadEnv()

// CDP 远程调试端口,供外部 Agent(Playwright / browser-use 等)连接。
// 可用环境变量 BROWSER_AGENT_DEBUG_PORT 覆盖。
const debugPort = Number(process.env.BROWSER_AGENT_DEBUG_PORT) || 9222
setRemoteDebuggingPort(debugPort)

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    title: 'Browser Agent',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 允许在渲染层嵌入 <webview>,作为内嵌浏览器的可视化区域
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // 开发模式加载 Vite dev server,生产模式加载打包产物
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerCdpHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  abortAllRuns()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => abortAllRuns())
