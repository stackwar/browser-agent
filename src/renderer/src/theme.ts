/** 把主题应用到文档根(CSS 用 :root[data-theme='light'] 覆盖变量) */
export function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark'
}
