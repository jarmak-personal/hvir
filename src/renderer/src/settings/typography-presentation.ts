import type { AppSettings } from './settings-model'
import { fontFamilyStack } from './typography-settings'

export interface TypographyPropertyTarget {
  setProperty(name: string, value: string): void
}

export function applyTypographyPresentation(
  settings: Pick<AppSettings, 'interfaceFont' | 'monospaceFont' | 'interfaceScale'>,
  target: TypographyPropertyTarget,
): void {
  target.setProperty(
    '--hvir-interface-font',
    fontFamilyStack(settings.interfaceFont, 'interface'),
  )
  target.setProperty(
    '--hvir-monospace-font',
    fontFamilyStack(settings.monospaceFont, 'monospace'),
  )
  target.setProperty('--hvir-interface-scale', String(settings.interfaceScale))
}
