import { useCallback, useEffect, useState } from 'react'
import { Button, Empty, Input } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { TraceEntry } from '@shared/types'

/** markdown 链接不能导航整个窗口,拦下来新开 */
const mdComponents: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href) window.open(href, '_blank', 'noopener,noreferrer')
      }}
    >
      {children}
    </a>
  )
}

interface Props {
  sessionId: string
  /** 轨迹视图是否可见(切过来时拉取) */
  active: boolean
  /** run 是否在跑(跑完翻为 false 时自动刷新) */
  busy: boolean
}

const ROLE_LABEL: Record<TraceEntry['role'], string> = {
  system: '系统',
  user: '用户',
  context: '上下文',
  assistant: '助手',
  tool: '工具'
}

/**
 * 执行轨迹视图:把一次会话里模型看到/产生的每条消息逐行列出 ——
 * 系统提示、用户输入、注入的上下文、助手文字、以及每次工具调用(入参 → 返回)。
 * 比对话气泡里的精简步骤更原始,便于排查「它到底做了什么」。
 */
export default function TracePanel({ sessionId, active, busy }: Props) {
  const [entries, setEntries] = useState<TraceEntry[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    if (!sessionId) return
    setLoading(true)
    try {
      setEntries(await window.api.trace.get(sessionId))
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // 切到轨迹视图、切换会话、或一次 run 刚结束时拉取
  useEffect(() => {
    if (active) void load()
  }, [active, busy, load])

  const q = query.trim().toLowerCase()
  const rows = q
    ? entries.filter((e) => {
        const hay = `${e.content} ${e.tool?.name ?? ''} ${e.tool?.args ?? ''} ${e.tool?.result ?? ''}`
        return hay.toLowerCase().includes(q)
      })
    : entries

  return (
    <div className="trace">
      <div className="trace-toolbar">
        <Input
          allowClear
          size="small"
          placeholder="搜索轨迹…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
      </div>

      <div className="trace-body">
        {rows.length === 0 ? (
          <Empty description={entries.length === 0 ? '本次运行暂无轨迹' : '无匹配结果'} />
        ) : (
          rows.map((e, i) => {
            const prev = rows[i - 1]
            const turnBreak = i === 0 || (prev && prev.turn !== e.turn)
            return (
              <div key={i}>
                {turnBreak && e.turn > 0 && <div className="trace-turn">第 {e.turn} 轮</div>}
                <div className={`trace-row role-${e.role}`}>
                  <span className={`trace-badge badge-${e.role}`}>{ROLE_LABEL[e.role]}</span>
                  {e.tool ? (
                    <span className="trace-content">
                      <span className="trace-tool-name">{e.tool.name}</span>
                      {e.tool.args && <span className="trace-tool-args"> {e.tool.args}</span>}
                      {e.tool.result && (
                        <>
                          <span className="trace-arrow"> → </span>
                          <span className="trace-tool-result">{e.tool.result}</span>
                        </>
                      )}
                    </span>
                  ) : (
                    <span className="trace-content trace-md">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                        {e.content}
                      </ReactMarkdown>
                    </span>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
