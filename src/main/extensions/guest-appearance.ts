import type { ExtensionPresentation } from '../../shared/extensions/contract'
import { extensionObject, extensionText } from '../../shared/extensions/manifest'
import {
  PRESENTATION_COLOR_PATTERN,
  PRESENTATION_COLOR_TOKENS,
} from '../../shared/presentation/tokens'
import {
  MAX_INTERFACE_FONT_STACK_LENGTH,
  MAX_MONOSPACE_FONT_STACK_LENGTH,
} from '../../shared/interface-typography'

/** Bounded trusted appearance data; visibility and authority stay with the guest owner. */
export function parseGuestAppearance(
  value: ExtensionPresentation,
): ExtensionPresentation {
  const colors = extensionObject(value.colors)
  const color = (key: keyof ExtensionPresentation['colors']): string => {
    const text = extensionText(colors[key], 'presentation color', 80)
    if (!PRESENTATION_COLOR_PATTERN.test(text))
      throw new Error('Invalid presentation color')
    return text
  }
  if (value.appearance !== 'light' && value.appearance !== 'dark')
    throw new Error('Invalid appearance')
  if (
    ![value.width, value.height].every(
      (number) => Number.isFinite(number) && number >= 0 && number <= 16_384,
    ) ||
    !Number.isFinite(value.interfaceScale) ||
    value.interfaceScale < 0.8 ||
    value.interfaceScale > 1.5
  )
    throw new Error('Invalid view presentation size')
  return {
    appearance: value.appearance,
    colors: Object.fromEntries(
      PRESENTATION_COLOR_TOKENS.map((token) => [token, color(token)]),
    ) as ExtensionPresentation['colors'],
    monospaceFontFamily: extensionText(
      value.monospaceFontFamily,
      'monospace font',
      MAX_MONOSPACE_FONT_STACK_LENGTH,
    ),
    interfaceScale: value.interfaceScale,
    fontFamily: extensionText(
      value.fontFamily,
      'interface font',
      MAX_INTERFACE_FONT_STACK_LENGTH,
    ),
    width: value.width,
    height: value.height,
  }
}
