import {
  MAX_DIAGNOSTIC_CAPTURE_MASKS,
  type DiagnosticCaptureMask,
  type DiagnosticCaptureSurface,
} from '../../../shared'

/** One-shot owned-surface inventory for an explicitly requested screenshot. */
export function ownedDiagnosticCaptureMasks():
  readonly DiagnosticCaptureMask[] | undefined {
  const ownedSurfaces: readonly [DiagnosticCaptureSurface, HTMLElement][] = [
    ...[...document.querySelectorAll<HTMLElement>('[data-diagnostic-capture]')].flatMap(
      (element): [DiagnosticCaptureSurface, HTMLElement][] => {
        const surface = element.dataset['diagnosticCapture']
        return isCaptureSurface(surface) ? [[surface, element]] : []
      },
    ),
    ...elements('viewer', '[data-viewer-pane]'),
    ...elements('project-navigation', '.tree-panel'),
  ]
  const masks = ownedSurfaces.flatMap(([surface, element]): DiagnosticCaptureMask[] => {
    if (!isVisible(element)) return []
    const bounds = element.getBoundingClientRect()
    if (bounds.width < 1 || bounds.height < 1) return []
    return [
      {
        surface,
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.max(1, Math.round(bounds.width)),
        height: Math.max(1, Math.round(bounds.height)),
      },
    ]
  })
  return masks.length <= MAX_DIAGNOSTIC_CAPTURE_MASKS ? masks : undefined
}

function elements(
  surface: DiagnosticCaptureSurface,
  selector: string,
): [DiagnosticCaptureSurface, HTMLElement][] {
  return [...document.querySelectorAll<HTMLElement>(selector)].map((element) => [
    surface,
    element,
  ])
}

function isCaptureSurface(value: unknown): value is DiagnosticCaptureSurface {
  return ['project-navigation', 'viewer', 'terminal', 'web-pane'].includes(String(value))
}

function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden'
}
