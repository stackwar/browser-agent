import { useEffect, useState } from 'react'
import { Button, Dropdown, Menu, Tooltip, message } from 'antd'
import { UserOutlined } from '@ant-design/icons'
import AboutModal from './AboutModal'

/** 客户端右上角的账户入口:登录 / 个人中心 / 关于。 */
export default function AccountMenu() {
  const [aboutOpen, setAboutOpen] = useState(false)
  const [menuTheme, setMenuTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    void window.api.settings.get().then((s) => setMenuTheme(s.theme))
  }, [])

  return (
    <div className="account-menu">
      <Dropdown
        trigger={['click']}
        placement="bottomRight"
        overlay={
          <Menu
            theme={menuTheme}
            onClick={({ key }) => {
              // 账户体系尚未接入,这里先只做入口
              if (key === 'login') message.info('登录功能开发中')
              else if (key === 'profile') message.info('个人中心开发中')
              else if (key === 'about') setAboutOpen(true)
            }}
            items={[
              { key: 'login', label: '登录' },
              { key: 'profile', label: '个人中心' },
              { type: 'divider' },
              { key: 'about', label: '关于' }
            ]}
          />
        }
      >
        <Tooltip title="账户" placement="left">
          <Button shape="circle" type="text" icon={<UserOutlined />} />
        </Tooltip>
      </Dropdown>

      <AboutModal open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  )
}
