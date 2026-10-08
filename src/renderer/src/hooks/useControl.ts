import { useCallback, useEffect, useState } from 'react'
import type { ControlState, RunEvent } from '@shared/types'

const INITIAL: ControlState = {
  owner: 'idle',
  runId: null,
  agentWaiting: false,
  reason: null,
  message: null
}

/**
 * 跟踪浏览器控制权。
 *
 * 与 useRun 不同,这里不按 runId 过滤 —— 控制权是全局单例,
 * 任何 run 的变更都该反映到 UI 上。
 */
export function useControl() {
  const [control, setControl] = useState<ControlState>(INITIAL)

  useEffect(() => {
    // 订阅前先拉一次:订阅之后才发生的变更靠事件,之前的状态靠这次拉取
    void window.api.control.get().then(setControl)

    return window.api.run.onEvent((event: RunEvent) => {
      if (event.type === 'control-changed') setControl(event.control)
    })
  }, [])

  const takeOver = useCallback(async (): Promise<void> => {
    setControl(await window.api.control.takeOver())
  }, [])

  const handBack = useCallback(async (note?: string): Promise<void> => {
    setControl(await window.api.control.handBack(note))
  }, [])

  return {
    control,
    takeOver,
    handBack,
    /** agent 正在操作浏览器,用户的输入应该被挡住 */
    agentDriving: control.owner === 'agent',
    /** 用户持有控制权 */
    manual: control.owner === 'manual'
  }
}
