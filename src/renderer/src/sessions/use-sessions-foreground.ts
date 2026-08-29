import { useEffect, useState } from 'react'

export function useSessionsForeground(): boolean {
  const [foreground, setForeground] = useState(
    () => document.visibilityState === 'visible' && document.hasFocus(),
  )
  useEffect(() => {
    const update = (): void =>
      setForeground(document.visibilityState === 'visible' && document.hasFocus())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    update()
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return foreground
}
