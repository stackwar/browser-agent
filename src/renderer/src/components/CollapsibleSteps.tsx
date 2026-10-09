import { useState } from 'react'
import type { RunStep } from '@shared/types'
import StepList from './StepList'

/** 会话卡片里的「思考与操作明细」—— 默认收起,点一下展开。完整原始轨迹见「轨迹」页。 */
export default function CollapsibleSteps({ steps }: { steps: RunStep[] }) {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  return (
    <div className="steps-collapsible">
      <button className="steps-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} 思考与操作明细 · {steps.length} 步
      </button>
      {open && <StepList steps={steps} />}
    </div>
  )
}
