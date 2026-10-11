import { useEffect, useRef, useState } from 'react'

/** Native window foreground survives child focus; guest documents supply no authority. */
export function useExtensionForeground(onWithdraw?: () => void): boolean {
  const [foreground, setForeground] = useState(false)
  const withdrawal = useRef(onWithdraw)
  withdrawal.current = onWithdraw
  useEffect(() => {
    let current = true,
      published = false
    const dispose = window.hvir.on('extensions:foreground-changed', (value) => {
      if (!current) return
      published = true
      if (!value) withdrawal.current?.()
      setForeground(value)
    })
    void window.hvir.invoke('extensions:foreground', undefined).then(
      (value) => {
        if (current && !published) {
          if (!value) withdrawal.current?.()
          setForeground(value)
        }
      },
      () => undefined,
    )
    return () => {
      current = false
      void dispose()
    }
  }, [])
  return foreground
}
