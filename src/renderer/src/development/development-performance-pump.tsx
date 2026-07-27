import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

const FIXTURE_COMMIT_COUNT = 40
const COMMITS_PER_TURN = 1
const COMPONENTS_PER_COMMIT = 512

export function PerformanceMeasurePump({
  schedule,
  onComplete,
}: {
  readonly schedule: (callback: () => void) => void
  readonly onComplete: () => void
}) {
  const [commit, setCommit] = useState(0)

  useEffect(() => {
    let remaining = FIXTURE_COMMIT_COUNT
    const pump = (): void => {
      const count = Math.min(remaining, COMMITS_PER_TURN)
      for (let index = 0; index < count; index += 1) {
        flushSync(() => setCommit((value) => value + 1))
      }
      remaining -= count
      if (remaining > 0) schedule(pump)
      else onComplete()
    }
    schedule(pump)
  }, [onComplete, schedule])

  return (
    <>
      {Array.from({ length: COMPONENTS_PER_COMMIT }, (_, index) => (
        <MeasuredCommit key={index} value={commit} />
      ))}
    </>
  )
}

function MeasuredCommit({ value }: { readonly value: number }) {
  return <span>{value}</span>
}
