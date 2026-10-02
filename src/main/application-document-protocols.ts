import { protocol } from 'electron'
import { HtmlPreviewProtocol } from './html-preview-protocol'
import { ElectronExtensionGuestSurface } from './extensions/electron-guest-surface'

/** Electron accepts privileged schemes exactly once, before any window or session. */
export function registerApplicationProtocols(): void {
  ElectronExtensionGuestSurface.configureEngine()
  protocol.registerSchemesAsPrivileged([
    HtmlPreviewProtocol.privilegedScheme,
    ElectronExtensionGuestSurface.privilegedScheme,
  ])
}
