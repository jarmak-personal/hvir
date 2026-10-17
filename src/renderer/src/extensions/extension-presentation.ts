import type { ExtensionPresentation } from '../../../shared/extensions/contract'
import { PRESENTATION_COLOR_TOKENS } from '../../../shared/presentation/tokens'

/** The pane's publication lifetime owns a resolved palette; resize changes only extent. */
export function createExtensionPresentationReader(): (
  appearance: ExtensionPresentation['appearance'],
  interfaceScale: number,
  element: HTMLElement,
) => ExtensionPresentation {
  let key: string | undefined
  let current: Omit<ExtensionPresentation, 'width' | 'height'> | undefined
  return (appearance, interfaceScale, element) => {
    const root = document.documentElement
    const next = JSON.stringify([
      appearance,
      interfaceScale,
      root.dataset.theme,
      root.getAttribute('style'),
    ])
    if (!current || next !== key) {
      const style = getComputedStyle(root)
      const probe = document.createElement('span')
      probe.hidden = true
      root.append(probe)
      try {
        current = {
          appearance,
          interfaceScale,
          colors: Object.fromEntries(
            PRESENTATION_COLOR_TOKENS.map((token) => {
              probe.style.color = `var(${token})`
              return [token, getComputedStyle(probe).color]
            }),
          ) as ExtensionPresentation['colors'],
          fontFamily: style.getPropertyValue('--hvir-interface-font').trim(),
          monospaceFontFamily: style.getPropertyValue('--hvir-monospace-font').trim(),
        }
        key = next
      } finally {
        probe.remove()
      }
    }
    const rect = element.getBoundingClientRect()
    return { ...current, width: Math.round(rect.width), height: Math.round(rect.height) }
  }
}
