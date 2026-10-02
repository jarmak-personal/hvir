import { useEffect, useRef, type ReactElement, type ComponentType } from 'react'
import type { ExtensionView } from '../../../shared/extensions/workbench'
import type { ExtensionPresentation } from '../../../shared/extensions/contract'
import { useAppTheme } from '../theme'
import { useAppSettings } from '../settings/settings'
import {
  ElectronExtensionGuestSurface,
  type ExtensionGuestSurfaceProps,
} from './ElectronExtensionGuestSurface'

/** Workbench-owned chrome stays outside the guest and remains usable if it hangs. */
export function ExtensionViewStack({
  views,
  activeId,
  active,
  onClose,
  Surface = ElectronExtensionGuestSurface,
}: {
  readonly views: readonly ExtensionView[]
  readonly activeId?: string
  readonly active: boolean
  readonly onClose: (id: string) => void
  readonly Surface?: ComponentType<ExtensionGuestSurfaceProps>
}): ReactElement {
  return (
    <>
      {views.map((view) => (
        <ExtensionViewPane
          key={view.id}
          view={view}
          visible={active && view.id === activeId}
          onClose={() => onClose(view.id)}
          Surface={Surface}
        />
      ))}
    </>
  )
}

function ExtensionViewPane({
  view,
  visible,
  onClose,
  Surface,
}: {
  readonly view: ExtensionView
  readonly visible: boolean
  readonly onClose: () => void
  readonly Surface: ComponentType<ExtensionGuestSurfaceProps>
}): ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const theme = useAppTheme()
  const settings = useAppSettings()
  useEffect(() => {
    const publish = (): void => {
      const element = root.current
      if (!element) return
      const style = getComputedStyle(document.documentElement)
      const rect = element.getBoundingClientRect()
      const color = (token: string): string => style.getPropertyValue(token).trim()
      const presentation: ExtensionPresentation = {
        appearance: theme,
        colors: {
          background: color('--app-bg'),
          surface: color('--surface-1'),
          text: color('--text'),
          muted: color('--text-muted'),
          accent: color('--accent'),
        },
        fontFamily: color('--hvir-interface-font') || 'system-ui',
        fontSize: 13 * settings.interfaceScale,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
      window.hvir.send('extensions:presentation', {
        viewId: view.id,
        presentation,
        visible,
      })
    }
    publish()
    const observer = new ResizeObserver(publish)
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [view.id, visible, theme, settings.interfaceScale, settings.interfaceFont])
  return (
    <div
      className="extension-view workspace-view"
      ref={root}
      hidden={!visible}
      data-extension-view={view.id}
    >
      <div className="extension-view-heading">
        <span>
          {view.extensionName} · {view.title}
        </span>
        <button type="button" onClick={onClose} aria-label={`Close ${view.title}`}>
          Close
        </button>
      </div>
      {view.failure ? <p role="status">{view.failure}</p> : <Surface view={view} />}
    </div>
  )
}
