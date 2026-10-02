import type { ComponentType, ReactElement } from 'react'
import type { ExtensionView } from '../../../shared/extensions/workbench'

export interface ExtensionGuestSurfaceProps {
  readonly view: ExtensionView
}

const GuestTag = 'webview' as unknown as ComponentType<{
  readonly name: string
  readonly src: string
  readonly partition: string
  readonly className: string
  readonly 'aria-label': string
}>

/** The renderer's replaceable Electron embedding edge; identity is allocated by main. */
export function ElectronExtensionGuestSurface({
  view,
}: ExtensionGuestSurfaceProps): ReactElement {
  return (
    <GuestTag
      name={view.id}
      src={view.url}
      partition={view.partition}
      className="extension-guest"
      aria-label={view.title}
    />
  )
}
