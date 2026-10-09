import { app, BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { registerCdpHandlers, setRemoteDebuggingPort } from './cdp'
import { loadEnv } from './env'
import { loadPlugins } from './plugins'
import { abortAllRuns } from './run'

// 应用名。打包后由 electron-builder 的 productName 决定;开发态(直接跑 Electron)
// 不走打包配置,菜单栏/Dock 会显示 "Electron",这里显式设一下。
// 必须在任何 app.getPath('userData') 之前调用(loadEnv 会用到)。
app.setName('聚运赢')

// 先读 .env:下面的端口和 agent.ts 的 API key 都从 process.env 取
loadEnv()

// CDP 远程调试端口,供外部 Agent(Playwright / browser-use 等)连接。
// **默认不开** —— 本机任意进程都能通过它完整控制浏览器(含读取已登录站点的
// cookie/会话)。分发给他人、且用户会登录真实账号时,常开是风险。
// 需要外接 Playwright/browser-use 时,设环境变量 BROWSER_AGENT_DEBUG_PORT 显式开启。
// 注意:应用内置 agent 走进程内 CDP(webContents.debugger),不依赖这个端口。
const debugPortEnv = process.env.BROWSER_AGENT_DEBUG_PORT
if (debugPortEnv) {
  const port = Number(debugPortEnv)
  if (Number.isInteger(port) && port > 0) setRemoteDebuggingPort(port)
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    title: '聚运赢',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // 允许在渲染层嵌入 <webview>,作为内嵌浏览器的可视化区域
      webviewTag: true
    }
  })

  // 打开即铺满屏幕:先 maximize 再 show,避免先弹小窗再跳大的闪烁
  mainWindow.on('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })

  // 开发模式加载 Vite dev server,生产模式加载打包产物
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 开发态设置 Dock 图标(打包后用 .icns,无需这步)。build/icon.png 在项目根。
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    const iconPath = join(process.cwd(), 'build', 'icon.png')
    if (existsSync(iconPath)) {
      try {
        app.dock.setIcon(iconPath)
      } catch {
        /* ignore */
      }
    }
  }

  registerCdpHandlers()
  // 加载插件目录里的扩展工具(命令型)。失败不影响启动。
  try {
    loadPlugins()
  } catch (err) {
    console.warn('[plugins] 启动加载失败:', err)
  }
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
