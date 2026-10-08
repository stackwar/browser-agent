# Browser Agent

桌面客户端骨架:内嵌 Chromium 浏览器内核(Electron),通过 **CDP(Chrome DevTools Protocol)** 暴露浏览器控制能力,后续可接入 LLM/Agent 以「聊天」的方式操作浏览器。

## 技术栈

- **Electron** —— 内置完整 Chromium 内核
- **electron-vite + Vite** —— 主进程 / preload / 渲染层统一构建
- **React 18 + TypeScript** —— 界面(聊天面板 + 内嵌浏览器 + 状态栏)
- **CDP** —— 浏览器控制协议(事实标准,兼容 Playwright / browser-use / 自研 Agent)
- **DeepSeek** —— 模型引擎,走 OpenAI 兼容端点(`openai` SDK 换 baseURL)

## 目录结构

```
browser-agent/
├── electron.vite.config.ts      # electron-vite 构建配置
├── electron-builder.yml         # 打包配置(后续发布用)
├── src/
│   ├── shared/
│   │   └── types.ts             # 三端共用类型(@shared/types)
│   ├── main/
│   │   ├── index.ts             # 主进程:创建窗口、启用远程调试端口
│   │   ├── cdp.ts               # CDP 控制器 + 全部 IPC handler 注册
│   │   ├── observe.ts           # 观察层:页面快照(元素列表 + 截图)
│   │   ├── actions.ts           # 工具层:navigate/click/type/scroll/…
│   │   ├── agent.ts             # LLM 接入:tool schema + agent 循环
│   │   ├── run.ts               # 执行层:run/step 状态机、事件流、中断
│   │   ├── session.ts           # 会话层:跨 run 的对话历史(修悬空 tool_calls / 压快照 / 限图)
│   │   └── injected/
│   │       └── collect.ts       # 注入页面的元素采集脚本(字符串形式)
│   ├── preload/
│   │   ├── index.ts             # contextBridge 暴露 window.api
│   │   └── index.d.ts           # window.api 的全局声明
│   └── renderer/
│       ├── index.html
│       └── src/
│           ├── App.tsx          # 布局 + 持有 Agent 的 CDP target
│           ├── hooks/
│           │   └── useRun.ts    # 订阅 run 事件流,维护实时状态
│           └── components/
│               ├── ChatPanel.tsx    # 聊天面板 + 步骤轨迹 + 停止
│               ├── StepList.tsx     # 步骤列表(状态图标 / notes / 耗时)
│               ├── BrowserPane.tsx  # <webview> 内嵌浏览器 + 地址栏
│               └── StatusBar.tsx    # CDP 端点 + 当前 target
```

> 构建工具链(rolldown)需要 Node 20.12+;Node 16 下 `pnpm build` 会因缺少 `node:util.styleText` 失败。

## 快速开始

```bash
pnpm install
cp .env.example .env   # 填入 DEEPSEEK_API_KEY
pnpm dev          # 启动开发模式(Vite HMR + Electron)
pnpm typecheck    # 类型检查(主进程/渲染层)
pnpm build        # 构建到 out/
```

配置从项目根目录的 `.env` 读(`src/main/env.ts`,**已在 .gitignore 里** —— key 不该进版本库)。查找顺序是项目根目录 → cwd → `userData`(打包后用),已存在的环境变量优先,命令行显式传的不会被文件覆盖。

| 环境变量 | 说明 |
| --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek API key。**只在主进程读取,不进渲染层。** |
| `DEEPSEEK_BASE_URL` | 覆盖 API 端点(默认 `https://api.deepseek.com`) |
| `BROWSER_AGENT_MODEL` | 覆盖默认模型(`deepseek-flash`) |
| `BROWSER_AGENT_DEBUG_PORT` | 覆盖 CDP 远程调试端口(默认 9222) |

可用模型(来自 `/models`):

| 模型 ID | 名称 | 上下文 | 读图 |
| --- | --- | --- | --- |
| `deepseek-flash` | DeepSeek-V4.1-Flash | 1M | ✅ |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 1M | ❌ |

## CDP 控制通道

项目提供**两条** CDP 通道,Agent 可按需选择:

### 1. 进程内 IPC(渲染层 / 内嵌 Agent)

通过 `window.api.cdp` 直接操作任意浏览器 target:

```ts
// 发现所有 target(主窗口、<webview> 等)
const targets = await window.api.cdp.listTargets()

// 附加并下发原始 CDP 命令
await window.api.cdp.attach(webviewId)
await window.api.cdp.send(webviewId, 'Runtime.evaluate', {
  expression: 'document.title'
})

// 订阅页面 CDP 事件流
const off = window.api.cdp.onEvent(({ targetId, method, params }) => {
  console.log(targetId, method, params)
})
```

### 2. 进程外远程端点(Playwright / browser-use)

主进程以 `--remote-debugging-port=9222` 启动(仅监听 `127.0.0.1`,端口可用环境变量 `BROWSER_AGENT_DEBUG_PORT` 覆盖)。启动后可访问 `http://127.0.0.1:9222/json` 查看 target 列表。

用 **Playwright** 连接:

```ts
import { chromium } from 'playwright'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const contexts = browser.contexts()
const page = contexts[0].pages()[0]
await page.goto('https://example.com')
```

用 **browser-use**(Python):

```python
from browser_use import Browser, BrowserConfig

browser = Browser(config=BrowserConfig(
    cdp_url="http://127.0.0.1:9222",
    headless=False,
))
```

## 观察层

把页面变成模型能读的东西。`src/main/observe.ts` 通过注入脚本遍历 DOM,输出带序号的可交互元素列表:

```ts
const snap = await window.api.observe.snapshot(targetId, { screenshot: true })

snap.text        // 紧凑文本,可直接塞进 prompt
snap.elements    // 结构化列表,含 center 坐标
snap.screenshot  // { format, data(base64), bytes }
```

`snap.text` 形如:

```
URL: https://example.com/
标题: Example Domain
视口: 1024x768  滚动位置: 0/1200
下方有更多内容,可滚动查看

可交互元素(3 个):
[0] link "更多信息" href=https://www.iana.org/domains/example
[1] textbox "搜索词" value="hello"
[2] checkbox "记住我" checked
```

要点:

- **元素的 `center` 是顶层视口坐标**,拿到后可直接下发 `Input.dispatchMouseEvent` 点击,不需要再查一次 DOM。iframe 内的元素已叠加了 iframe 的偏移。
- 覆盖 **shadow DOM** 与**同源 iframe**;跨源 iframe 拿不到 `contentDocument`,会被跳过。
- 穿过 shadow root 的元素 `xpath` 为 `null`,这类元素只能用 `center` 定位。
- `type="password"` 的值一律脱敏为 `***`,不把用户密码带出页面。
- 默认只收视口内元素(`viewportOnly`),上限 300 个(`maxElements`),截断时 `truncated` 为 `true`。
- 采集前会等页面加载完成(`<webview>` 的 `dom-ready` 早于导航完成,不等会拍到 `about:blank`),超时上限 `settleTimeout`,默认 10s。

`src/main/injected/collect.ts` 里的采集脚本以**字符串**形式保存,运行在页面上下文,不受 TypeScript 检查保护,改动时需留意。

## 工具层

`src/main/actions.ts` 把 CDP 原语封装成 Agent 可用的动作:

| 动作 | 说明 |
| --- | --- |
| `navigate(url)` | 导航。只放行 http/https,15s 超时 |
| `click(snap, index)` | 点击快照里的第 index 个元素,离屏时先滚进视口 |
| `type(snap, index, text, submit?)` | 清空原值后输入,可选回车提交 |
| `scroll(direction, amount?)` | `down` / `up` / `top` / `bottom` |
| `goBack()` | 后退 |
| `readText()` | 读页面正文(元素列表只含可交互项) |
| `observe(screenshot?)` | 拍快照 |

这些动作也经 `window.api.action.run(...)` 暴露给渲染层,便于内嵌 Agent 或单独调试。

几个实现上的坑:

- **`type` 清空原值必须用 `rawKeyDown` + `commands: ['selectAll']`。** 只发 `keyDown` 带 `modifiers` 不会触发浏览器的编辑命令,`Input.insertText` 会把新值追加在旧值后面。
- **协议补全要限定在「压根没写协议」时。** 否则 `file:///etc/passwd` 会被拼成 `https://file///etc/passwd`,从而绕过协议白名单。
- **`navigate` 必须有超时。** `wc.loadURL()` 的 promise 要等所有子资源加载完才 resolve,像 github.com 这种页面可能挂几十秒甚至一直不 resolve(分析脚本、长连接),整个 run 就卡死,用户只能 abort。超时不算失败:页面这时通常已可交互,带一句说明返回让模型 observe 自己判断。
- 引用了无效 index 时,错误信息会带上有效范围并提示重新 observe —— 模型看到这条会自己纠偏。

## 执行层与中断

`src/main/run.ts` 把一次请求组织成可观察、可中断的 run。一个 run 由若干 step 组成,每个 step 的开始 / 说明 / 结束实时推给渲染层:

```ts
const off = window.api.run.onEvent((e) => {
  // run-started | step-started | step-note | step-finished | run-finished
})

const { runId } = await window.api.run.start({ prompt: '帮我搜索…', targetId })
await window.api.run.abort(runId)   // 随时中断

// 人工接管
await window.api.control.takeOver()
await window.api.control.handBack('我登录好了')
```

渲染层用 `useRun()` 消费这条事件流,`ChatPanel` 把步骤渲染成带状态图标和耗时的轨迹,执行中发送按钮变为「停止」。

中断通过 `AbortSignal` 传导:长动作在每个 `await` 边界检查一次,取消后进行中的 step 标记 `aborted`,已完成的 step 保留,run 状态转为 `aborted` 并照常派发 `run-finished`。应用退出和窗口全关时会中断所有在跑的 run。

## 人工接管

`src/main/control.ts` —— 控制权状态机。

**为什么必须互斥**:`<webview>` 里用户的真实鼠标键盘和 agent 下发的 `Input.dispatchMouseEvent` 走同一个输入通道。两边同时操作不是「协作」而是互相打断 —— 用户正在填表时 agent 点了别处,焦点就跑了。所以同一时刻只有一方持有控制权:

| owner | 含义 | UI |
| --- | --- | --- |
| `idle` | 没有 run 在跑 | 无遮罩,用户随意操作 |
| `agent` | agent 独占 | 遮罩盖住浏览器区,地址栏锁定 |
| `manual` | 用户独占 | 顶部横幅 + 交还按钮,遮罩让开 |

两条进入 `manual` 的路径:用户点遮罩主动接管,或模型调 `request_manual` 请求人工处理(登录、验证码、支付确认)。两者状态机行为一致,只差 `reason` 和那句说明。

几个要点:

- **接管的生效点是动作边界。** 已经发出的 CDP 命令无法撤回,所以 `takeOver()` 不打断正在执行的动作,只保证下一个动作之前挂起。这与 abort 语义不同 —— abort 放弃整个 run,接管是暂停后还要继续。
- **交还时清掉缓存快照。** 接管期间用户可能导航到别的页面,沿用旧编号会点错东西。系统提示也要求模型重新 observe。
- **用户留的说明要带给模型** —— 它看不到用户在页面上做了什么。但不能直接插一条 user 消息:assistant 的 `tool_calls` 和对应的 `role: 'tool'` 消息之间插别的东西会破坏协议,所以搭车在下一条工具结果前面。
- **abort 必须能放掉挂起的 agent。** 挂在接管上的循环不吃 `AbortSignal` 之外的信号,`abortRun` 要显式调 `releaseForAbort`,否则它永远停在那里。
- agent 操作期间地址栏和导航按钮一并锁定:用户这时导航会让 agent 手里的元素编号失效。

## LLM 接入

`src/main/agent.ts` —— **整个模块只在主进程运行,API key 不进渲染层。**

引擎是 DeepSeek,走它的 OpenAI 兼容端点(官方推荐方式,`openai` SDK 换 `baseURL` 即可)。相比 Anthropic 的 messages 接口有三处实质差异:

1. **工具参数是 JSON 字符串**,不是结构化对象,必须自己解析且要容错 —— 模型偶尔吐出截断或带 markdown 围栏的 JSON。解析失败时把错误回给模型让它重试,而不是终止 run。
2. **工具结果是独立的 `role: 'tool'` 消息**,一条对应一个 `tool_call_id`,不像 Anthropic 把多个 `tool_result` 合进一条 user 消息。回传的 assistant 消息必须原样带上 `tool_calls`,否则下一轮的 tool 消息会因找不到对应 id 被拒。
3. **图片走 `image_url` 而非 image block**,且**不能放进 `role: 'tool'` 消息** —— 工具消息只接受文本 part。所以截图攒到本轮所有工具结果 push 完之后,作为一条独立 user 消息补上,这样也不破坏 `tool_calls` 与 tool 回复的相邻性。

**视觉能力按模型区分。** 两个模型里只有 `deepseek-flash` 读图,所以 `observe` 的 `screenshot` 参数**只在读图模型的 tool schema 里出现** —— 模型看不到这个参数就不会去调它,比在运行时拒绝它更省一轮往返。给纯文本模型送图只会白烧 token。

用手写的 agent 循环而非 SDK 的 `runTools`:需要在每次工具调用前后检查 `AbortSignal`、在动作边界让出控制权给人工接管、把每一步作为 step 推给 UI,这些 runner 都不暴露。循环形状:

```
observe → 模型决定动作 → (让出控制权?) → 执行 → 把结果(含新快照)回给模型 → …直到模型不再调工具
```

要点:

- 动作执行后**顺带回传一份新快照**,省掉模型再调一次 observe 的往返。
- 模型直接 `click` 而没先 `observe` 时(多轮对话里常见),自动补一张快照而不是报错让它多跑一轮。
- 动作失败不终止 run:错误作为工具结果回给模型,让它换个做法。
- `tool_choice` 保持默认 `auto` —— 强制调工具会让模型没法用文字收尾。
- 处理 `message.refusal`,安全策略拦下时 `content` 为空。
- 请求带 `AbortSignal`,中断能立刻取消在途请求。
- 往返轮次上限 12(`MAX_TURNS`),触达后收尾并说明任务可能未完成。

## 会话层

`src/main/session.ts` —— 跨 run 的对话历史,让模型看得到前几轮聊了什么,「刚才那个链接」这种指代才有意义。历史存在 run 之外:每个 run 从 `session.history()` 取起点,结束时(不论正常收尾、中断还是报错)把本轮新增消息并入历史。**system 提示不进历史**,每次由 agent 现拼 —— 改系统提示立刻生效,不会被旧历史里的版本盖住。

存的时候就把数据修干净,而不是发送时再过滤:

- **修悬空 `tool_calls`。** run 被中断或报错时,历史末尾会留下没有对应 tool 回复的 `tool_calls`,下一个 run 把它当历史发出去 API 直接 400。写入时从尾部往前扫,把没被 tool 消息完整覆盖的 assistant 连同残片一起丢掉;孤立的 tool 消息也扔。
- **压快照。** 每个动作都回传完整元素列表,一个 run 下来几十 KB,跨 run 累积很快吃掉上下文。历史里工具结果只留**首行摘要**(「已点击元素 [3]」/ `URL: …`),完整快照不留 —— 模型要当前页面状态时重新 observe 就有,留旧快照反而会让它拿过期 index 去点。
- **限图。** 观察层截图一律不留(「当时那一屏」,过期即无用);用户自己发的图是任务的一部分,但只留**最近一条**带图消息,更早的降级成「此处有 N 张图片,已省略」的文字说明。
- 还有 `MAX_MESSAGES`(默认 60)条数上限,超出从最旧丢起,丢完再过一遍悬空修复。

渲染层通过 `window.api.session.info()` 读历史长度与模型读图能力,`window.api.session.clear()` 清空历史(主进程记录和界面消息列表一起清,否则两边对不上)。

## 后续接入 Agent 的建议路径

观察层、工具层、LLM 接入、执行反馈与中断、跨 run 会话历史都已就位。继续往下可以做:

- **更智能的上下文压缩** —— 目前历史里旧快照只留首行摘要、按条数硬截断。长任务里可以进一步做语义摘要:把更早的若干轮压成一段「做过什么」的概述,而非逐条截断。
- **动作确认** —— 表单提交、下单这类不可逆操作,可以在 `runTool` 里停下来等用户点确认再继续。接管机制已经提供了「挂起等用户」的骨架,改成硬性拦截不难;目前除了模型主动调 `request_manual`,没有强制门禁。
- **接管期间屏蔽键盘** —— 遮罩只拦鼠标。agent 操作期间用户按键仍会进页面,极端情况下会干扰输入。

## 常用脚本

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 开发模式 |
| `pnpm build` | 构建 `out/` |
| `pnpm typecheck` | 类型检查 |
| `pnpm start` | 预览已构建产物 |
| `pnpm build:mac` / `:win` / `:linux` | 打包对应平台安装包 |

## 注意事项

- 远程调试端口仅监听本机 `127.0.0.1`,避免暴露到公网;如需局域网访问请谨慎评估安全风险。
- 需要提醒的是,**本机任意进程都能通过该端口完整控制浏览器**,包括读取已登录站点的 cookie 与会话。如果用户会在内嵌浏览器里登录真实账号,建议把该端口改为按需开启而非默认常开。
- **两条 CDP 通道对同一个 target 互斥**:一个 target 只能被一个调试客户端占用。外部 Agent(Playwright / browser-use)接管某页面后,进程内的 `attach` / `snapshot` 对该页面会失败,反之亦然。观察层遇到这种情况会抛出带说明的错误。
- 主进程会因启用 `remote-debugging-port` 打印一条安全提示日志,属预期行为。
- `<webview>` 的页面内容运行在独立进程,不受渲染层 CSP 限制。
