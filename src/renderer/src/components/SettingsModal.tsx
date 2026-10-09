import { useCallback, useEffect, useState } from 'react'
import { Button, Input, InputNumber, List, Modal, Radio, Segmented, Space, Tabs, Tag, Tooltip, message } from 'antd'
import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ModelOption, PluginToolInfo } from '@shared/types'
import { applyTheme } from '../theme'

interface Props {
  open: boolean
  onClose: () => void
  /** 保存后通知外层刷新(模型 / vision 可能变了) */
  onSaved: () => void
}

/**
 * 设置面板:三块 —— 切换模型、通用设置、插件安装。
 *
 * 模型与 maxTurns 存在主进程 settings.json;插件来自插件目录的 plugin.json 清单。
 * 安装插件 = 往插件目录放文件夹后点「重新加载」。
 */
export default function SettingsModal({ open, onClose, onSaved }: Props) {
  const [models, setModels] = useState<ModelOption[]>([])
  const [model, setModel] = useState<string>('')
  const [maxTurns, setMaxTurns] = useState<number>(50)
  const [apiKey, setApiKey] = useState<string>('')
  const [hasApiKey, setHasApiKey] = useState<boolean>(false)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [saving, setSaving] = useState(false)

  const [plugins, setPlugins] = useState<PluginToolInfo[]>([])
  const [pluginDir, setPluginDir] = useState<string>('')
  const [reloading, setReloading] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const [info, list, d] = await Promise.all([
      window.api.settings.get(),
      window.api.plugins.list(),
      window.api.plugins.dir()
    ])
    setModels(info.models)
    setModel(info.model)
    setMaxTurns(info.maxTurns)
    setHasApiKey(info.hasApiKey)
    setTheme(info.theme)
    setApiKey('') // 不回显密钥;留空表示不改动
    setPlugins(list)
    setPluginDir(d.path)
  }, [])

  // 打开时拉取当前设置与插件
  useEffect(() => {
    if (open) void refresh().catch(() => void 0)
  }, [open, refresh])

  const save = useCallback(async (): Promise<void> => {
    setSaving(true)
    try {
      // apiKey 留空表示不改动,只有填了才下发,避免把已配置的 key 清空
      await window.api.settings.update({
        model,
        maxTurns,
        theme,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {})
      })
      message.success('设置已保存')
      applyTheme(theme)
      onSaved()
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [model, maxTurns, apiKey, theme, onSaved, onClose])

  const clearApiKey = useCallback(async (): Promise<void> => {
    await window.api.settings.update({ apiKey: '' })
    setApiKey('')
    setHasApiKey(false)
    message.success('已清除,改用环境变量 / 内置默认 key')
    onSaved()
  }, [onSaved])

  const reloadPlugins = useCallback(async (): Promise<void> => {
    setReloading(true)
    try {
      setPlugins(await window.api.plugins.reload())
      message.success('插件已重新加载')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '重载失败')
    } finally {
      setReloading(false)
    }
  }, [])

  return (
    <Modal
      title="设置"
      open={open}
      onCancel={onClose}
      onOk={() => void save()}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      width={560}
    >
      <Tabs
        defaultActiveKey="model"
        items={[
          {
            key: 'model',
            label: '模型',
            children: (
              <Radio.Group
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
              >
                {models.map((m) => (
                  <Radio key={m.id} value={m.id}>
                    {m.name}（{m.id}）
                    {m.vision ? (
                      <Tag color="green" style={{ marginLeft: 8 }}>
                        读图
                      </Tag>
                    ) : (
                      <Tag style={{ marginLeft: 8 }}>纯文本</Tag>
                    )}
                  </Radio>
                ))}
              </Radio.Group>
            )
          },
          {
            key: 'general',
            label: '通用',
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <div>
                  <div style={{ marginBottom: 6 }}>
                    API Key {hasApiKey ? <Tag color="green">已配置</Tag> : <Tag color="red">未配置</Tag>}
                  </div>
                  <Space.Compact style={{ width: '100%' }}>
                    <Input.Password
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={hasApiKey ? '已配置,留空则不改动' : '粘贴 sk-… 后保存'}
                      autoComplete="off"
                    />
                    <Button onClick={() => void clearApiKey()}>清除</Button>
                  </Space.Compact>
                  <div style={{ color: '#999', fontSize: 12, marginTop: 6 }}>
                    保存在本机 settings.json,仅主进程调用模型时读取。也可用环境变量
                    BROWSER_AGENT_API_KEY。清除后回退到环境变量 / 内置默认。
                  </div>
                </div>
                <div>
                  <div style={{ marginBottom: 6 }}>界面主题</div>
                  <Segmented
                    value={theme}
                    onChange={(v) => setTheme(v as 'dark' | 'light')}
                    options={[
                      { label: '深色', value: 'dark' },
                      { label: '浅色', value: 'light' }
                    ]}
                  />
                  <div style={{ color: '#999', fontSize: 12, marginTop: 6 }}>
                    保存后生效。
                  </div>
                </div>
                <div>
                  <div style={{ marginBottom: 6 }}>最大往返轮次（maxTurns）</div>
                  <InputNumber
                    min={1}
                    max={200}
                    value={maxTurns}
                    onChange={(v) => setMaxTurns(typeof v === 'number' ? v : 50)}
                    style={{ width: 160 }}
                  />
                  <div style={{ color: '#999', fontSize: 12, marginTop: 6 }}>
                    一次任务里与模型往返的上限。调高能处理更复杂的任务,但失控时更费 token。
                  </div>
                </div>
              </Space>
            )
          },
          {
            key: 'plugins',
            label: '插件',
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Tooltip title="在文件管理器里打开插件目录">
                    <Button
                      icon={<FolderOpenOutlined />}
                      onClick={() => void window.api.plugins.openDir()}
                    >
                      打开插件目录
                    </Button>
                  </Tooltip>
                  <Button
                    icon={<ReloadOutlined />}
                    loading={reloading}
                    onClick={() => void reloadPlugins()}
                  >
                    重新加载
                  </Button>
                </div>
                <div style={{ color: '#999', fontSize: 12, wordBreak: 'break-all' }}>
                  插件目录:{pluginDir || '(未知)'}
                  <br />
                  安装方式:把含 <code>plugin.json</code> 的插件文件夹放进该目录,再点「重新加载」。
                </div>
                <List
                  size="small"
                  bordered
                  locale={{ emptyText: '暂无已加载的插件工具' }}
                  dataSource={plugins}
                  renderItem={(t) => (
                    <List.Item>
                      <List.Item.Meta
                        title={
                          <span>
                            {t.name}
                            {t.plugin ? (
                              <Tag style={{ marginLeft: 8 }}>{t.plugin}</Tag>
                            ) : null}
                          </span>
                        }
                        description={t.description}
                      />
                    </List.Item>
                  )}
                />
              </Space>
            )
          }
        ]}
      />
    </Modal>
  )
}
