import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

const VIEWPORT_MARGIN = 8

export interface ContextMenuAnchor {
  readonly id: number
  readonly x: number
  readonly y: number
}

export interface ViewportSize {
  readonly width: number
  readonly height: number
}

export interface MenuSize {
  readonly width: number
  readonly height: number
}

export function boundedContextMenuPosition(
  anchor: Pick<ContextMenuAnchor, 'x' | 'y'>,
  menu: MenuSize,
  viewport: ViewportSize,
  margin = VIEWPORT_MARGIN,
): { readonly left: number; readonly top: number } {
  const availableWidth = Math.max(0, viewport.width - margin * 2)
  const availableHeight = Math.max(0, viewport.height - margin * 2)
  const fittedWidth = Math.min(Math.max(0, menu.width), availableWidth)
  const fittedHeight = Math.min(Math.max(0, menu.height), availableHeight)
  return {
    left: clamp(
      anchor.x,
      margin,
      Math.max(margin, viewport.width - margin - fittedWidth),
    ),
    top: clamp(
      anchor.y,
      margin,
      Math.max(margin, viewport.height - margin - fittedHeight),
    ),
  }
}

export function useViewportContextMenuPosition(
  menuRef: RefObject<HTMLElement | null>,
  anchor?: ContextMenuAnchor,
): CSSProperties | undefined {
  const [position, setPosition] = useState<{
    readonly left: number
    readonly top: number
  }>()

  useLayoutEffect(() => {
    if (!anchor) {
      setPosition(undefined)
      return
    }
    const place = (): void => {
      const bounds = menuRef.current?.getBoundingClientRect()
      if (!bounds) return
      const next = boundedContextMenuPosition(
        anchor,
        { width: bounds.width, height: bounds.height },
        { width: window.innerWidth, height: window.innerHeight },
      )
      setPosition((current) =>
        current?.left === next.left && current.top === next.top ? current : next,
      )
    }
    place()
    window.addEventListener('resize', place)
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(place)
    if (menuRef.current) observer?.observe(menuRef.current)
    return () => {
      window.removeEventListener('resize', place)
      observer?.disconnect()
    }
  }, [anchor, anchor?.id, anchor?.x, anchor?.y, menuRef])

  if (!anchor) return undefined
  return position ?? { left: anchor.x, top: anchor.y }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
