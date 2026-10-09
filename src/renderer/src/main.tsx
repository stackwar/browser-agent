// antd 组件样式必须在 app 的 styles.css **之前** 引入:antd 的 css 带一个全局
// reset(含浅色 body),放后面会把这套深色主题冲掉。styles.css 最后加载,
// 等权重冲突时它赢(body 等基础标签维持深色)。
// 用完整 antd.css 而非逐组件引入 —— 设置面板用到 Modal/Tabs/Select/… 多种组件,
// 全量样式省得逐个漏引。
import 'antd/dist/antd.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
