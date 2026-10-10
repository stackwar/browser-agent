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
        e.stopPropagation()
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
type SparkMode = 'calls' | 'turns' | 'duration'

/** 条目归到活动色带哪一行 */
function categoryOf(e: TraceEntry): 'user' | 'context' | 'model' | 'tool' {
  if (e.role === 'tool') return 'tool'
  if (e.role === 'assistant') return 'model'
  if (e.role === 'context') return 'context'
  return 'user'
}

export default function TracePanel({ sessionId, active, busy }: Props) {
  const [entries, setEntries] = useState<TraceEntry[]>([])
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SparkMode>('calls')
  const [loading, setLoading] = useState(false)
  // 默认每条只显示一行,点击展开;记录被展开的行
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const toggle = useCallback((i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }, [])

  const load = useCallback(async (): Promise<void> => {
    if (!sessionId) return
    setLoading(true)
    try {
      setEntries(await window.api.trace.get(sessionId))
      setExpanded(new Set())
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

  // 轮次编号:每当出现开启新一轮的 用户/上下文(其前是 助手/工具 或是开头)就 +1。
  // 这样一轮 = 上下文 + 用户问题 + 若干助手/工具,与参考里的「第 N 轮」一致。
  let turnSeq = 0
  const turnAt = rows.map((e, i) => {
    const prev = rows[i - 1]
    const isStart =
      (e.role === 'user' || e.role === 'context') &&
      (i === 0 || prev.role === 'assistant' || prev.role === 'tool')
    if (isStart) {
      turnSeq += 1
      return turnSeq
    }
    return 0
  })

  // 色带每格宽度:调用=等宽;时长=按工具耗时;轮次=等宽(用轮次分隔线区分)
  const widthOf = (e: TraceEntry): number => {
    if (mode === 'duration') return e.role === 'tool' ? Math.max(1, Math.round((e.ms ?? 0) / 150)) : 1
    return 1
  }

  return (
    <div className="trace">
      <div className="trace-toolbar">
        <div className="trace-modes">
          {([['duration', '时长'], ['turns', '轮次'], ['calls', '调用']] as [SparkMode, string][]).map(
            ([m, label]) => (
              <button
                key={m}
                className={`trace-mode${mode === m ? ' active' : ''}`}
                onClick={() => setMode(m)}
              >
                {label}
              </button>
            )
          )}
        </div>
        <Input
          allowClear
          size="small"
          placeholder="搜索轨迹…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1 }}
        />
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()} />
      </div>

      {rows.length > 0 && (
        <div className="trace-spark">
          <div className="spark-labels">
            <span>输入</span>
            <span>模型</span>
            <span>工具</span>
          </div>
          <div className="spark-cols">
            {rows.map((e, i) => {
              const cat = categoryOf(e)
              const ms = e.ms
              return (
                <div
                  key={i}
                  className={`spark-col${turnAt[i] > 0 ? ' turn-start' : ''}`}
                  style={{ flexGrow: widthOf(e) }}
                  title={
                    e.tool
                      ? `${e.tool.name}${ms != null ? ` · ${ms}ms` : ''}`
                      : ROLE_LABEL[e.role]
                  }
                >
                  <span className={`spark-cell input${cat === 'user' || cat === 'context' ? ` on ${cat}` : ''}`} />
                  <span className={`spark-cell model${cat === 'model' ? ' on' : ''}`} />
                  <span className={`spark-cell tool${cat === 'tool' ? ' on' : ''}`} />
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="trace-body">
        {rows.length === 0 ? (
          <Empty description={entries.length === 0 ? '本次运行暂无轨迹' : '无匹配结果'} />
        ) : (
          rows.map((e, i) => {
            return (
              <div key={i}>
                {turnAt[i] > 0 && <div className="trace-turn">第 {turnAt[i]} 轮</div>}
                <div
                  className={`trace-row role-${e.role}${expanded.has(i) ? ' expanded' : ' clamped'}`}
                  onClick={() => toggle(i)}
                  title={expanded.has(i) ? '收起' : '展开'}
                >
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
