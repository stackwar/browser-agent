import { Button, Tooltip } from 'antd'
import {
  PlusOutlined,
  DeleteOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined
} from '@ant-design/icons'
import type { SessionMeta } from '@shared/types'
import logo from '../assets/logo.png'

interface Props {
  sessions: SessionMeta[]
  activeId: string
  busy: boolean
  collapsed: boolean
  onToggle: () => void
  onNew: () => void
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}

const fmtTime = (ts: number): string => {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 三栏最左栏:应用标识 + 新建会话 + 历史会话列表,可折叠成细条 */
export default function Sidebar({
  sessions,
  activeId,
  busy,
  collapsed,
  onToggle,
  onNew,
  onSelect,
  onDelete
}: Props) {
  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      <div className="sidebar-brand">
        {!collapsed && (
          <>
            <img src={logo} alt="聚运赢" width={24} height={24} />
            <span className="sidebar-brand-name">聚运赢</span>
          </>
        )}
        <Tooltip title={collapsed ? '展开' : '收起'} placement="right">
          <Button
            type="text"
            size="small"
            className="sidebar-toggle"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={onToggle}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          />
        </Tooltip>
      </div>

      {collapsed ? (
        <div className="sidebar-rail">
          <Tooltip title="新建会话" placement="right">
            <Button
              type="primary"
              ghost
              icon={<PlusOutlined />}
              disabled={busy}
              onClick={onNew}
              aria-label="新建会话"
            />
          </Tooltip>
        </div>
      ) : (
        <>
          <div className="sidebar-new">
            <Button
              type="primary"
              ghost
              block
              icon={<PlusOutlined />}
              disabled={busy}
              onClick={onNew}
            >
              新建会话
            </Button>
          </div>

          <div className="sidebar-list">
            {sessions.length === 0 ? (
              <div className="sidebar-empty">暂无会话</div>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.id}
                  className={`sidebar-item${s.id === activeId ? ' active' : ''}`}
                  onClick={() => onSelect(s.id)}
                  title={s.title}
                >
                  <div className="sidebar-item-title">{s.title}</div>
                  <div className="sidebar-item-meta">
                    {fmtTime(s.updatedAt)} · {s.messageCount}
                  </div>
                  <Tooltip title="删除会话">
                    <DeleteOutlined
                      className="sidebar-item-del"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!busy) onDelete(s.id)
                      }}
                    />
                  </Tooltip>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </aside>
  )
}
