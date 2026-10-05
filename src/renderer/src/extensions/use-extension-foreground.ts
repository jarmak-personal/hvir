import { useEffect, useState } from 'react'

/** Native window foreground survives child focus; guest documents supply no authority. */
export function useExtensionForeground(): boolean {
  const [foreground, setForeground] = useState(false)
  useEffect(() => {
    let current = true,
      published = false
    const dispose = window.hvir.on('extensions:foreground-changed', (value) => {
      if (!current) return
      published = true
      setForeground(value)
    })
    void window.hvir.invoke('extensions:foreground', undefined).then(
      (value) => {
        if (current && !published) setForeground(value)
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
