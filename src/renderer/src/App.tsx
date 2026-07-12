import { useEffect, useState, type ReactElement } from 'react'

/**
 * Phase 1 renders an intentionally empty window (non-goal: any styling beyond
 * blank). The one thing it does is round-trip `app:info` through the typed
 * bridge, proving renderer→main IPC is wired end-to-end.
 */
export function App(): ReactElement {
  const [label, setLabel] = useState('hvir')

  useEffect(() => {
    void window.hvir.invoke('app:info', undefined).then((info) => {
      setLabel(`hvir · electron ${info.electronVersion} · node ${info.nodeVersion}`)
    })
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        fontFamily: 'system-ui, sans-serif',
        color: '#6b7280',
        background: '#0b0d10',
        userSelect: 'none',
      }}
    >
      <span style={{ opacity: 0.5, fontSize: 13 }}>{label}</span>
    </div>
  )
}
