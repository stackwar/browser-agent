/**
 * 增强 @types/react 已内置的 HTMLWebViewElement 类型。
 * (<webview> 元素的 JSX 声明与 WebViewHTMLAttributes 由 @types/react 提供,
 *  这里只补充 Electron <webview> 运行时特有的导航 / 调试方法。)
 */
declare global {
  interface HTMLWebViewElement {
    src: string
    loadURL(url: string): Promise<void>
    reload(): void
    stop(): void
    goBack(): void
    goForward(): void
    canGoBack(): boolean
    canGoForward(): boolean
    getURL(): string
    getTitle(): string
    getWebContentsId(): number
    openDevTools(): void
    addEventListener(
      type: 'did-navigate' | 'did-navigate-in-page' | 'dom-ready' | 'did-finish-load' | 'did-fail-load',
      listener: (event: Event) => void
    ): void
    removeEventListener(
      type: 'did-navigate' | 'did-navigate-in-page' | 'dom-ready' | 'did-finish-load' | 'did-fail-load',
      listener: (event: Event) => void
    ): void
  }
}

export {}
