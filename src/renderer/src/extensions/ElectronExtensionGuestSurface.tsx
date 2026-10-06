import { useEffect, useRef, type ComponentType, type ReactElement } from 'react'
import type { ExtensionView } from '../../../shared/extensions/workbench'

export interface ExtensionGuestSurfaceProps {
  readonly view: ExtensionView
  readonly focus?: boolean
  readonly onFocusSettled?: () => void
}

const GuestTag = 'webview' as unknown as ComponentType<{
  readonly name: string
  readonly src: string
  readonly partition: string
  readonly className: string
  readonly 'aria-label': string
  readonly ref: React.RefObject<HTMLElement | null>
}>

/** The renderer's replaceable Electron embedding edge; identity is allocated by main. */
export function ElectronExtensionGuestSurface({
  view,
  focus = false,
  onFocusSettled,
}: ExtensionGuestSurfaceProps): ReactElement {
  const guest = useRef<HTMLElement>(null)
  const consumed = useRef(false)
  const settled = useRef(onFocusSettled)
  settled.current = onFocusSettled
  useEffect(() => {
    if (!focus || consumed.current) return
    consumed.current = true
    const element = guest.current
    if (!element) return
    let current = true
    const focusReady = (): void => {
      if (!current) return
      void window.hvir.invoke('extensions:foreground', undefined).then(
        (foreground) => {
          if (!current) return
          if (!foreground || !element.checkVisibility()) {
            current = false
            settled.current?.()
            return
          }
          try {
            // Electron refuses this until attachment; dom-ready supplies the late edge.
            ;(element as HTMLElement & { getWebContentsId(): number }).getWebContentsId()
            element.focus()
            current = false
            settled.current?.()
          } catch {
            /* Wait only for this exact guest's readiness. */
          }
        },
        () => {
          if (!current) return
          current = false
          settled.current?.()
        },
      )
    }
    element.addEventListener('dom-ready', focusReady)
    focusReady()
    return () => {
      current = false
      element.removeEventListener('dom-ready', focusReady)
    }
  }, [focus, view.id])
  return (
    <GuestTag
      ref={guest}
      name={view.id}
      src={view.url}
      partition={view.partition}
      className="extension-guest"
      aria-label={view.title}
    />
  )
}
