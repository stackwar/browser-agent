import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunEvent, RunState, RunStep, StartRunPayload } from '@shared/types'

/**
 * 订阅主进程的 run 事件流,维护当前 run 的实时状态。
 *
 * 只跟踪「最近一次 start 出来的 run」:事件里带 runId,不属于当前 run 的直接忽略,
 * 避免上一次 run 的收尾事件把新 run 的状态冲掉。
 */
export function useRun() {
  const [run, setRun] = useState<RunState | null>(null)
  // 流式预览文本:模型正在生成的这段话,边收边显;收完/进入下一步就清掉
  const [streamingText, setStreamingText] = useState('')
  // 事件回调里要读最新 runId,用 ref 避免把订阅做成依赖 run 的 effect
  const activeId = useRef<string | null>(null)

  useEffect(() => {
    const off = window.api.run.onEvent((event: RunEvent) => {
      if (event.runId !== activeId.current) return

      if (event.type === 'assistant-delta') {
        setStreamingText(event.text)
        return
      }
      // 其它事件意味着这段话已定格成步骤或已进入下一步 —— 清掉预览,避免重复
      if (event.type === 'step-started' || event.type === 'run-finished') {
        setStreamingText('')
      }

      setRun((prev) => {
        switch (event.type) {
          case 'run-started':
            return event.run

          case 'step-started': {
            if (!prev) return prev
            return { ...prev, steps: [...prev.steps, event.step] }
          }

          case 'step-note': {
            if (!prev) return prev
            return {
              ...prev,
              steps: prev.steps.map((s) =>
                s.index === event.index ? { ...s, notes: [...s.notes, event.note] } : s
              )
            }
          }

          case 'step-finished': {
            if (!prev) return prev
            return {
              ...prev,
              steps: prev.steps.map((s) => (s.index === event.step.index ? event.step : s))
            }
          }

          case 'run-finished':
            return event.run

          default:
            return prev
        }
      })
    })

    return off
  }, [])

  const start = useCallback(async (payload: StartRunPayload): Promise<string> => {
    const { runId } = await window.api.run.start(payload)
    activeId.current = runId
    // run-started 事件可能在 invoke 返回前就已派发(此时 activeId 还是旧值而被忽略),
    // 这里补一次拉取,保证初始状态不丢。
    const state = await window.api.run.get(runId)
    if (state) setRun((prev) => (prev && prev.id === runId ? prev : state))
    return runId
  }, [])

  const abort = useCallback(async (): Promise<void> => {
    const id = activeId.current
    if (!id) return
    await window.api.run.abort(id)
  }, [])

  const reset = useCallback((): void => {
    activeId.current = null
    setRun(null)
    setStreamingText('')
  }, [])

  const busy = run?.status === 'running'

  return { run, busy, streamingText, start, abort, reset }
}

export type { RunState, RunStep }
