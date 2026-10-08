import type { RunStep } from '@shared/types'

const ICON: Record<RunStep['status'], string> = {
  running: '◌',
  done: '✓',
  error: '✕',
  aborted: '⊘'
}

function duration(step: RunStep): string {
  if (!step.endedAt) return ''
  const ms = step.endedAt - step.startedAt
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export default function StepList({ steps }: { steps: RunStep[] }) {
  if (steps.length === 0) return null

  return (
    <ol className="steps">
      {steps.map((step) => (
        <li key={step.index} className={`step ${step.status}`}>
          <div className="step-head">
            <span className="step-icon" aria-hidden="true">
              {ICON[step.status]}
            </span>
            <span className="step-title">{step.title}</span>
            <span className="step-time">{duration(step)}</span>
          </div>
          {step.notes.length > 0 && (
            <ul className="step-notes">
              {step.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          )}
          {step.error && <div className="step-error">{step.error}</div>}
        </li>
      ))}
    </ol>
  )
}
