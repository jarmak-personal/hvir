import { useEffect } from 'react'

/** Signals usability only after React committed the functional workbench surface. */
export function useRendererReady(usable: boolean): void {
  useEffect(() => {
    if (!usable) return
    const frame = window.requestAnimationFrame(() => window.hvir.rendererReady())
    return () => window.cancelAnimationFrame(frame)
  }, [usable])
}
