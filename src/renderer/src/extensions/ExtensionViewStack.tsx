import { useEffect, useRef, type ReactElement, type ComponentType } from 'react'
import type { ExtensionView } from '../../../shared/extensions/workbench'
import { createExtensionPresentationReader } from './extension-presentation'
import { useExtensionContributions } from './extension-contribution-context'
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
  const model = useExtensionContributions()
  return (
    <>
      {views.map((view) => (
        <ExtensionViewPane
          key={view.id}
          view={view}
          visible={active && view.id === activeId && (!model || !model.obscured)}
          onClose={() => onClose(view.id)}
          Surface={Surface}
        />
      ))}
    </>
  )
}

export function ExtensionViewPane({
  view,
  visible,
  selected = visible,
  onClose,
  Surface,
}: {
  readonly view: ExtensionView
  readonly visible: boolean
  readonly selected?: boolean
  readonly onClose: () => void
  readonly Surface: ComponentType<ExtensionGuestSurfaceProps>
}): ReactElement {
  const model = useExtensionContributions()
  const foreground = model?.foreground ?? true
  const root = useRef<HTMLDivElement>(null)
  const theme = useAppTheme()
  const settings = useAppSettings()
  useEffect(() => {
    let disposed = false
    const readPresentation = createExtensionPresentationReader()
    const publish = (): void => {
      const element = root.current
      if (disposed || !element) return
      const presentation = readPresentation(theme, settings.interfaceScale, element)
      window.hvir.send('extensions:presentation', {
        viewId: view.id,
        presentation,
        visible,
        selected,
        refreshDemand: visible && foreground,
      })
    }
    publish()
    const observer = new ResizeObserver(publish)
    if (root.current) observer.observe(root.current)
    return () => {
      disposed = true
      observer.disconnect()
    }
  }, [
    view.id,
    visible,
    selected,
    foreground,
    theme,
    settings.interfaceScale,
    settings.interfaceFont,
    settings.monospaceFont,
  ])
  return (
    <div
      className="extension-view workspace-view hvir-panel"
      ref={root}
      hidden={!visible}
      data-extension-view={view.id}
    >
      <div className="extension-view-heading">
        <span>
          {view.extensionName} · {view.title}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${view.title}`}
          className="hvir-button"
        >
          Close
        </button>
      </div>
      {view.failure ? (
        <p role="status">{view.failure}</p>
      ) : (
        <Surface view={view} focus={visible && model?.landingFocusId === view.id} />
      )}
    </div>
  )
}
