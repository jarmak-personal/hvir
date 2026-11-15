/** DOM CSS coordinates include page zoom; Electron capture/input use view DIPs.
 * Keep qualification gestures and sampled pixels on that same view boundary. */
export function nativeTerminalViewPoint(
  point: { x: number; y: number },
  pageZoom: number,
): { x: number; y: number } {
  return { x: point.x * pageZoom, y: point.y * pageZoom }
}

export function nativeTerminalViewRect(
  rect: { x: number; y: number; width: number; height: number },
  pageZoom: number,
): { x: number; y: number; width: number; height: number } {
  return {
    ...nativeTerminalViewPoint(rect, pageZoom),
    width: rect.width * pageZoom,
    height: rect.height * pageZoom,
  }
}
