/// <reference lib="dom" />

type ScrollbarAxis = 'horizontal' | 'vertical'

interface AxisPresentation {
  readonly thumbLength: number
  readonly thumbOffset: number
  readonly travel: number
  readonly maximum: number
}

interface TrackPresentation extends AxisPresentation {
  readonly start: number
  readonly clientLength: number
}

interface ScrollbarTrack {
  readonly axis: ScrollbarAxis
  readonly element: HTMLDivElement
  readonly thumb: HTMLDivElement
  presentation?: TrackPresentation
}

interface DragState {
  readonly pointerId: number
  readonly track: ScrollbarTrack
  readonly pointerStart: number
  readonly scrollStart: number
}

interface VisibleRect {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

const TRACK_THICKNESS = 10
const TRACK_INSET = 2
const MINIMUM_THUMB_LENGTH = 24
const IDLE_HIDE_DELAY_MS = 900
const CLIPPING_OVERFLOW = new Set(['auto', 'clip', 'hidden', 'scroll'])

/** Pure thumb geometry shared by both axes. */
export function scrollbarAxisPresentation(
  trackLength: number,
  clientLength: number,
  scrollLength: number,
  scrollPosition: number,
): AxisPresentation | undefined {
  const maximum = scrollLength - clientLength
  if (trackLength <= 0 || clientLength <= 0 || maximum <= 1) return undefined
  const thumbLength = Math.min(
    trackLength,
    Math.max(MINIMUM_THUMB_LENGTH, (trackLength * clientLength) / scrollLength),
  )
  const travel = Math.max(0, trackLength - thumbLength)
  const position = Math.min(maximum, Math.max(0, scrollPosition))
  return {
    thumbLength,
    thumbOffset: maximum === 0 ? 0 : (travel * position) / maximum,
    travel,
    maximum,
  }
}

/** Install one delegated overlay policy for every hvir-owned DOM scroll surface. */
export function installScrollbarPresentation(root: HTMLElement): () => void {
  const owner = new ScrollbarPresentationOwner(root)
  return () => owner.dispose()
}

class ScrollbarPresentationOwner {
  private readonly document: Document
  private readonly window: Window
  private readonly tracks: Record<ScrollbarAxis, ScrollbarTrack>
  private readonly resizeObserver: ResizeObserver
  private readonly forcedColors: MediaQueryList
  private activeSurface?: HTMLElement
  private drag?: DragState
  private hideTimer?: number
  private updateFrame?: number
  private disposed = false

  constructor(private readonly root: HTMLElement) {
    this.document = root.ownerDocument
    const view = this.document.defaultView
    if (!view) throw new Error('hvir: scrollbar presentation requires a window')
    this.window = view
    this.tracks = {
      horizontal: this.createTrack('horizontal'),
      vertical: this.createTrack('vertical'),
    }
    this.resizeObserver = new ResizeObserver(() => this.queueUpdate())
    this.forcedColors = this.window.matchMedia('(forced-colors: active)')

    this.document.addEventListener('scroll', this.handleScroll, true)
    this.document.addEventListener('pointermove', this.handlePointerMove, true)
    this.document.addEventListener('pointerup', this.handlePointerEnd, true)
    this.document.addEventListener('pointercancel', this.handlePointerEnd, true)
    this.document.addEventListener('focusin', this.handleFocus, true)
    this.window.addEventListener('resize', this.handleViewportChange, { passive: true })
    this.window.addEventListener('blur', this.handleWindowBlur)
    this.forcedColors.addEventListener('change', this.handleForcedColors)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.document.removeEventListener('scroll', this.handleScroll, true)
    this.document.removeEventListener('pointermove', this.handlePointerMove, true)
    this.document.removeEventListener('pointerup', this.handlePointerEnd, true)
    this.document.removeEventListener('pointercancel', this.handlePointerEnd, true)
    this.document.removeEventListener('focusin', this.handleFocus, true)
    this.window.removeEventListener('resize', this.handleViewportChange)
    this.window.removeEventListener('blur', this.handleWindowBlur)
    this.forcedColors.removeEventListener('change', this.handleForcedColors)
    this.resizeObserver.disconnect()
    if (this.hideTimer !== undefined) this.window.clearTimeout(this.hideTimer)
    if (this.updateFrame !== undefined) this.window.cancelAnimationFrame(this.updateFrame)
    this.endDrag()
    this.tracks.horizontal.element.remove()
    this.tracks.vertical.element.remove()
    this.activeSurface = undefined
  }

  private readonly handleScroll = (event: Event): void => {
    if (!(event.target instanceof HTMLElement)) return
    if (!this.root.contains(event.target) || !this.isScrollable(event.target)) return
    this.activate(event.target)
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.drag) {
      if (event.pointerId !== this.drag.pointerId) return
      const presentation = this.drag.track.presentation
      const surface = this.activeSurface
      if (!presentation || !surface || presentation.travel <= 0) return
      event.preventDefault()
      const delta =
        this.pointerCoordinate(event, this.drag.track.axis) - this.drag.pointerStart
      this.setScrollPosition(
        surface,
        this.drag.track.axis,
        this.drag.scrollStart + (delta * presentation.maximum) / presentation.travel,
      )
      this.show()
      this.queueUpdate()
      return
    }

    if (this.trackForTarget(event.target)) {
      this.show()
      this.scheduleHide()
      return
    }
    const surface = this.scrollableSurface(event.composedPath())
    if (surface) this.activate(surface)
    else this.scheduleHide()
  }

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return
    this.endDrag()
    this.scheduleHide()
  }

  private readonly handleFocus = (event: FocusEvent): void => {
    const path: EventTarget[] = []
    let candidate = event.target instanceof HTMLElement ? event.target : null
    while (candidate) {
      path.push(candidate)
      candidate = candidate.parentElement
    }
    const surface = this.scrollableSurface(path)
    if (surface) this.activate(surface)
    else this.scheduleHide()
  }

  private readonly handleViewportChange = (): void => this.queueUpdate()
  private readonly handleWindowBlur = (): void => this.deactivate()
  private readonly handleForcedColors = (): void => {
    if (this.forcedColors.matches) this.deactivate()
    else this.queueUpdate()
  }

  private createTrack(axis: ScrollbarAxis): ScrollbarTrack {
    const element = this.document.createElement('div')
    element.className = 'hvir-scrollbar'
    element.dataset.axis = axis
    element.setAttribute('aria-hidden', 'true')
    const thumb = this.document.createElement('div')
    thumb.className = 'hvir-scrollbar-thumb'
    element.append(thumb)
    element.addEventListener('pointerdown', (event) =>
      this.handleTrackPointerDown(event, axis),
    )
    this.document.body.append(element)
    return { axis, element, thumb }
  }

  private handleTrackPointerDown(event: PointerEvent, axis: ScrollbarAxis): void {
    const surface = this.activeSurface
    const track = this.tracks[axis]
    const presentation = track.presentation
    if (!surface || !presentation || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    this.show()
    const coordinate = this.pointerCoordinate(event, axis)
    if (event.target === track.thumb) {
      this.clearHideTimer()
      this.drag = {
        pointerId: event.pointerId,
        track,
        pointerStart: coordinate,
        scrollStart: this.scrollPosition(surface, axis),
      }
      track.element.dataset.dragging = 'true'
      this.document.body.classList.add('hvir-scrollbar-dragging')
      track.thumb.setPointerCapture(event.pointerId)
      return
    }

    const thumbStart = presentation.start + presentation.thumbOffset
    const direction = coordinate < thumbStart ? -1 : 1
    this.setScrollPosition(
      surface,
      axis,
      this.scrollPosition(surface, axis) + direction * presentation.clientLength * 0.9,
    )
    this.queueUpdate()
    this.scheduleHide()
  }

  private activate(surface: HTMLElement): void {
    if (this.disposed || this.forcedColors.matches) return
    if (this.activeSurface !== surface) {
      this.resizeObserver.disconnect()
      this.activeSurface = surface
      this.resizeObserver.observe(surface)
    }
    this.show()
    this.queueUpdate()
    this.scheduleHide()
  }

  private deactivate(): void {
    this.endDrag()
    this.resizeObserver.disconnect()
    this.activeSurface = undefined
    this.hide()
  }

  private show(): void {
    for (const track of Object.values(this.tracks)) {
      if (track.presentation) track.element.dataset.visible = 'true'
    }
  }

  private hide(): void {
    this.clearHideTimer()
    if (this.drag) return
    for (const track of Object.values(this.tracks)) {
      delete track.element.dataset.visible
    }
  }

  private scheduleHide(): void {
    if (this.drag || this.forcedColors.matches) return
    this.clearHideTimer()
    this.hideTimer = this.window.setTimeout(() => {
      this.hideTimer = undefined
      this.hide()
    }, IDLE_HIDE_DELAY_MS)
  }

  private clearHideTimer(): void {
    if (this.hideTimer === undefined) return
    this.window.clearTimeout(this.hideTimer)
    this.hideTimer = undefined
  }

  private queueUpdate(): void {
    if (this.disposed || this.updateFrame !== undefined) return
    this.updateFrame = this.window.requestAnimationFrame(() => {
      this.updateFrame = undefined
      this.update()
    })
  }

  private update(): void {
    const surface = this.activeSurface
    if (!surface?.isConnected || this.forcedColors.matches) {
      this.deactivate()
      return
    }
    const rect = this.visibleRect(surface)
    if (!rect) {
      this.hide()
      return
    }
    const hasHorizontal = surface.scrollWidth - surface.clientWidth > 1
    const hasVertical = surface.scrollHeight - surface.clientHeight > 1
    this.updateTrack(
      this.tracks.vertical,
      rect.top + TRACK_INSET,
      rect.right - TRACK_THICKNESS - TRACK_INSET,
      rect.bottom - rect.top - TRACK_INSET * 2 - (hasHorizontal ? TRACK_THICKNESS : 0),
      surface.clientHeight,
      surface.scrollHeight,
      surface.scrollTop,
      hasVertical,
    )
    this.updateTrack(
      this.tracks.horizontal,
      rect.left + TRACK_INSET,
      rect.bottom - TRACK_THICKNESS - TRACK_INSET,
      rect.right - rect.left - TRACK_INSET * 2 - (hasVertical ? TRACK_THICKNESS : 0),
      surface.clientWidth,
      surface.scrollWidth,
      surface.scrollLeft,
      hasHorizontal,
    )
    this.show()
  }

  private updateTrack(
    track: ScrollbarTrack,
    start: number,
    crossStart: number,
    trackLength: number,
    clientLength: number,
    scrollLength: number,
    scrollPosition: number,
    enabled: boolean,
  ): void {
    const axis = enabled
      ? scrollbarAxisPresentation(trackLength, clientLength, scrollLength, scrollPosition)
      : undefined
    if (!axis) {
      track.presentation = undefined
      delete track.element.dataset.visible
      return
    }
    track.presentation = { ...axis, start, clientLength }
    if (track.axis === 'vertical') {
      Object.assign(track.element.style, {
        top: `${start}px`,
        left: `${crossStart}px`,
        height: `${trackLength}px`,
      })
      Object.assign(track.thumb.style, {
        height: `${axis.thumbLength}px`,
        transform: `translateY(${axis.thumbOffset}px)`,
      })
    } else {
      Object.assign(track.element.style, {
        top: `${crossStart}px`,
        left: `${start}px`,
        width: `${trackLength}px`,
      })
      Object.assign(track.thumb.style, {
        width: `${axis.thumbLength}px`,
        transform: `translateX(${axis.thumbOffset}px)`,
      })
    }
  }

  private visibleRect(surface: HTMLElement): VisibleRect | undefined {
    const surfaceRect = surface.getBoundingClientRect()
    const rect = {
      top: Math.max(0, surfaceRect.top),
      right: Math.min(this.window.innerWidth, surfaceRect.right),
      bottom: Math.min(this.window.innerHeight, surfaceRect.bottom),
      left: Math.max(0, surfaceRect.left),
    }
    let ancestor = surface.parentElement
    while (ancestor && ancestor !== this.document.body) {
      const style = this.window.getComputedStyle(ancestor)
      const ancestorRect = ancestor.getBoundingClientRect()
      if (CLIPPING_OVERFLOW.has(style.overflowY)) {
        rect.top = Math.max(rect.top, ancestorRect.top)
        rect.bottom = Math.min(rect.bottom, ancestorRect.bottom)
      }
      if (CLIPPING_OVERFLOW.has(style.overflowX)) {
        rect.left = Math.max(rect.left, ancestorRect.left)
        rect.right = Math.min(rect.right, ancestorRect.right)
      }
      ancestor = ancestor.parentElement
    }
    return rect.right - rect.left > TRACK_THICKNESS &&
      rect.bottom - rect.top > TRACK_THICKNESS
      ? rect
      : undefined
  }

  private scrollableSurface(path: readonly EventTarget[]): HTMLElement | undefined {
    for (const target of path) {
      if (
        target instanceof HTMLElement &&
        this.root.contains(target) &&
        this.isScrollable(target)
      ) {
        return target
      }
    }
    return undefined
  }

  private isScrollable(element: HTMLElement): boolean {
    const style = this.window.getComputedStyle(element)
    return (
      (CLIPPING_OVERFLOW.has(style.overflowY) &&
        element.scrollHeight - element.clientHeight > 1) ||
      (CLIPPING_OVERFLOW.has(style.overflowX) &&
        element.scrollWidth - element.clientWidth > 1)
    )
  }

  private trackForTarget(target: EventTarget | null): ScrollbarTrack | undefined {
    if (!(target instanceof Node)) return undefined
    return Object.values(this.tracks).find((track) => track.element.contains(target))
  }

  private pointerCoordinate(event: PointerEvent, axis: ScrollbarAxis): number {
    return axis === 'vertical' ? event.clientY : event.clientX
  }

  private scrollPosition(surface: HTMLElement, axis: ScrollbarAxis): number {
    return axis === 'vertical' ? surface.scrollTop : surface.scrollLeft
  }

  private setScrollPosition(
    surface: HTMLElement,
    axis: ScrollbarAxis,
    position: number,
  ): void {
    if (axis === 'vertical') surface.scrollTop = position
    else surface.scrollLeft = position
  }

  private endDrag(): void {
    if (!this.drag) return
    const { track, pointerId } = this.drag
    if (track.thumb.hasPointerCapture(pointerId))
      track.thumb.releasePointerCapture(pointerId)
    delete track.element.dataset.dragging
    this.document.body.classList.remove('hvir-scrollbar-dragging')
    this.drag = undefined
  }
}
