import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtensionView } from '../../../shared/extensions/workbench'

interface ViewPlacement {
  readonly views: readonly ExtensionView[]
  readonly activeId?: string
  readonly active: boolean
}

/** Transient application-level viewer placement, independent of workspace selection. */
export function useExtensionViews(ports: {
  readonly onActivate: () => void
  readonly onError: (message: string) => void
}) {
  const [placement, setPlacement] = useState<ViewPlacement>({ views: [], active: false })
  const activeRef = useRef(false)
  const portsRef = useRef(ports)
  portsRef.current = ports
  activeRef.current = placement.active

  useEffect(() => {
    let current = true,
      updated = false
    const dispose = window.hvir.on(
      'extensions:views-changed',
      ({ views, selectedId }) => {
        updated = true
        setPlacement((previous) => {
          const activeId = selectedId ?? previous.activeId
          const retained = !!activeId && views.some((view) => view.id === activeId)
          return {
            views,
            activeId: retained ? activeId : undefined,
            active: retained && (!!selectedId || previous.active),
          }
        })
        if (selectedId) portsRef.current.onActivate()
      },
    )
    void window.hvir.invoke('extensions:views', undefined).then(
      (views) => {
        // A live publication wins over an older initial snapshot response.
        if (current && !updated) setPlacement((previous) => ({ ...previous, views }))
      },
      (reason: unknown) => {
        if (current) portsRef.current.onError(errorText(reason))
      },
    )
    return () => {
      current = false
      void dispose()
    }
  }, [])

  const activate = useCallback((id: string): void => {
    setPlacement((previous) => ({ ...previous, activeId: id, active: true }))
    portsRef.current.onActivate()
  }, [])
  const deactivate = useCallback(
    () => setPlacement((previous) => ({ ...previous, active: false })),
    [],
  )
  const close = useCallback((id: string): void => {
    void window.hvir
      .invoke('extensions:close-view', { viewId: id })
      .catch((reason: unknown) => portsRef.current.onError(errorText(reason)))
  }, [])
  return { ...placement, activeRef, activate, deactivate, close }
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Extension view is unavailable'
}
