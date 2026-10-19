import { useEffect, useRef, useState } from 'react'

/** Native window foreground survives child focus; guest documents supply no authority. */
export function useExtensionForeground(onWithdraw?: () => void): {
  readonly foreground: boolean
  readonly revision: number
} {
  const [state, setState] = useState({ foreground: false, revision: 0 })
  const withdrawal = useRef(onWithdraw)
  withdrawal.current = onWithdraw
  useEffect(() => {
    let current = true,
      published = false
    const dispose = window.hvir.on('extensions:foreground-changed', (value) => {
      if (!current) return
      published = true
      if (!value) withdrawal.current?.()
      // Main already withdrew visibility; preserve a return even when React batches both events.
      setState((prior) => ({ foreground: value, revision: prior.revision + 1 }))
    })
    void window.hvir.invoke('extensions:foreground', undefined).then(
      (value) => {
        if (current && !published) {
          if (!value) withdrawal.current?.()
          setState((prior) => ({ foreground: value, revision: prior.revision + 1 }))
        }
      },
      () => undefined,
    )
    return () => {
      current = false
      void dispose()
    }
  }, [])
  return state
}
