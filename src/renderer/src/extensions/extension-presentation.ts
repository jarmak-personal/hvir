import type { ExtensionPresentation } from '../../../shared/extensions/contract'
import { PRESENTATION_COLOR_TOKENS } from '../../../shared/presentation/tokens'

/** Resolve aliases/color-mix in Chromium before sending bounded values to the guest. */
export function readExtensionPresentation(
  appearance: ExtensionPresentation['appearance'],
  interfaceScale: number,
  element: HTMLElement,
): ExtensionPresentation {
  const root = document.documentElement
  const style = getComputedStyle(root)
  const probe = document.createElement('span')
  probe.hidden = true
  root.append(probe)
  try {
    const colors = Object.fromEntries(
      PRESENTATION_COLOR_TOKENS.map((token) => {
        probe.style.color = `var(${token})`
        return [token, getComputedStyle(probe).color]
      }),
    ) as ExtensionPresentation['colors']
    const rect = element.getBoundingClientRect()
    return {
      appearance,
      colors,
      fontFamily: style.getPropertyValue('--hvir-interface-font').trim(),
      monospaceFontFamily: style.getPropertyValue('--hvir-monospace-font').trim(),
      interfaceScale,
      fontSize: 13 * interfaceScale,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }
  } finally {
    probe.remove()
  }
}
