import type { BrowserWindow } from 'electron'
import type { ManagedPty } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import {
  inspectCapacityTerminalTag,
  capacityTerminalTagCellCount,
  type CapacityTerminalTagProfile,
} from './capacity-terminal-tags'
import { nativeTerminalViewRect } from './native-terminal-browser-coordinates'

export interface CapacityTerminalLayout {
  readonly engine: 'web' | 'native'
  readonly x: number
  readonly y: number
  readonly cssWidth: number
  readonly cssHeight: number
  readonly paneWidth: number
  readonly paneHeight: number
  readonly canvasWidth: number
  readonly canvasHeight: number
  readonly scale: number
  readonly columns: number
  readonly rows: number
  readonly cellWidth: number
  readonly cellHeight: number
  readonly paddingLeft: number
  readonly paddingTop: number
  readonly fontSize: number
  readonly viewId?: string
  readonly webViewportY?: number
  readonly nativeEpoch?: string
  readonly attachment?: number
  readonly geometrySerial?: number
}

export class CapacityTerminalLayoutPending extends Error {
  constructor(
    readonly category:
      | 'surface-pending'
      | 'canvas-pending'
      | 'appearance-pending'
      | 'drawn-grant-pending'
      | 'geometry-pending',
  ) {
    super('capacity-compositor:' + category)
  }
}

/** Engine-specific applied grid facts only locate the common compositor read.
 * Neither parser inspection nor a drawn acknowledgement closes a sample. */
export async function readCapacityTerminalLayout(
  win: BrowserWindow,
  terminal: ManagedPty,
  native?: NativeTerminalApplication,
): Promise<CapacityTerminalLayout> {
  const observed = (await win.webContents.executeJavaScript(`(() => {
    const surface=document.querySelector('.terminal-surface[data-terminal-session='+
      JSON.stringify(${JSON.stringify(terminal.id)})+']');
    const engine=surface?.querySelector('.terminal-engine-host');
    if(!(engine instanceof HTMLElement))return {state:'pending',category:'surface-pending'};
    const canvas=engine?.querySelector('canvas');
    if(!(canvas instanceof HTMLCanvasElement))return {state:'pending',category:'canvas-pending'};
    const b=canvas.getBoundingClientRect(),pane=engine.getBoundingClientRect(),stats=engine.__hvirTerminalPerformance;
    const appearance=engine.__hvirNativeTerminalAppearance;
    if(engine.classList.contains('native-terminal-pane')&&!appearance?.applied)
      return {state:'pending',category:'appearance-pending'};
    return {state:'ready',layout:{engine:engine.classList.contains('native-terminal-pane')?'native':'web',
      x:b.x,y:b.y,cssWidth:b.width,cssHeight:b.height,
      paneWidth:pane.width,paneHeight:pane.height,
      canvasWidth:canvas.width,canvasHeight:canvas.height,scale:devicePixelRatio,
      columns:stats?.cols,rows:stats?.rows,cellWidth:stats?.cellWidth,
      cellHeight:stats?.cellHeight,paddingLeft:0,paddingTop:0,
      fontSize:appearance?.fontSize??stats?.fontSize,
      webViewportY:engine.__hvirTerminalViewport?.viewportY,
      viewId:engine.querySelector('[id^="native-terminal-"]')?.id.slice('native-terminal-'.length)}};
  })()`)) as
    | { state: 'ready'; layout: CapacityTerminalLayout }
    | {
        state: 'pending'
        category: ConstructorParameters<typeof CapacityTerminalLayoutPending>[0]
      }
  if (observed.state === 'pending')
    throw new CapacityTerminalLayoutPending(observed.category)
  const layout = observed.layout
  if (layout.engine === 'native') {
    const record = native?.sessions.get(terminal.id)
    if (
      !record ||
      record.unavailable ||
      record.session.instanceId !== terminal.instanceId
    )
      throw new Error('capacity-compositor-native-instance')
    const owner = { id: terminal.ownerId, generation: terminal.ownerGeneration }
    const { geometry } = await native!.inspectRetained(terminal.id, owner)
    const grant =
      layout.viewId && native!.targets.drawn(layout.viewId, win.webContents.mainFrame)
    if (!grant || grant.geometrySerial !== geometry.serial)
      throw new CapacityTerminalLayoutPending('drawn-grant-pending')
    if (geometry.width !== layout.canvasWidth || geometry.height !== layout.canvasHeight)
      throw new CapacityTerminalLayoutPending('geometry-pending')
    return {
      ...layout,
      geometrySerial: geometry.serial,
      nativeEpoch: grant.nativeEpoch,
      attachment: grant.attachment,
      columns: geometry.columns,
      rows: geometry.rows,
      cellWidth: geometry.cellWidth / geometry.backingScale,
      cellHeight: geometry.cellHeight / geometry.backingScale,
      paddingLeft: geometry.paddingLeft / geometry.backingScale,
      paddingTop: geometry.paddingTop / geometry.backingScale,
    }
  }
  if (native) throw new Error('capacity-compositor-native-selected-web-observed')
  if (
    ![layout.columns, layout.rows, layout.cellWidth, layout.cellHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    throw new Error('capacity-compositor-web-geometry')
  return layout
}

export async function captureCapacityTerminalTag(
  win: BrowserWindow,
  layout: CapacityTerminalLayout,
  viewportRow: number,
  profile?: CapacityTerminalTagProfile,
) {
  if (!Number.isInteger(viewportRow) || viewportRow < 0 || viewportRow >= layout.rows)
    throw new Error('capacity-compositor-viewport-row')
  const count = capacityTerminalTagCellCount(profile)
  const start = layout.x + layout.paddingLeft
  const center = layout.y + layout.paddingTop + (viewportRow + 0.5) * layout.cellHeight
  const pageZoom = win.webContents.getZoomFactor()
  const view = nativeTerminalViewRect(
    {
      x: start,
      y: center,
      width: count * layout.cellWidth,
      height: 2,
    },
    pageZoom,
  )
  const rectangle = {
    x: Math.floor(view.x),
    y: Math.floor(view.y),
    width: Math.ceil(view.width + view.x - Math.floor(view.x)),
    height: Math.max(1, Math.ceil(view.height)),
  }
  const requestedAtMs = performance.now()
  const image = await win.webContents.capturePage(rectangle)
  const completedAtMs = performance.now()
  // Pinned Electron CapturePage wraps physical CopyFromSurface pixels as a 1x
  // NativeImage. Its representation label is NOT the CSS-to-bitmap scale.
  if (!image.getScaleFactors().includes(1))
    throw new Error('capacity-compositor-capture-representation')
  const size = image.getSize(1)
  const bitmap = image.toBitmap({ scaleFactor: 1 })
  if (bitmap.length !== size.width * size.height * 4)
    throw new Error('capacity-compositor-bitmap-dimensions')
  const scale = size.width / rectangle.width
  const pixelProbe = Array.from({ length: count }, (_, index) => {
    const x = Math.floor(
      (view.x - rectangle.x + (index + 0.5) * layout.cellWidth * pageZoom) * scale,
    )
    const offset = (Math.floor(size.height / 2) * size.width + x) * 4
    return [...bitmap.subarray(offset, offset + 4)]
  })
  const decoded = inspectCapacityTerminalTag(
    bitmap,
    size.width,
    size.height,
    layout.cellWidth * pageZoom * scale,
    (view.x - rectangle.x + layout.cellWidth * pageZoom * 0.5) * scale,
    profile,
  )
  return {
    requestedAtMs,
    completedAtMs,
    captureMs: completedAtMs - requestedAtMs,
    pixelProbe: {
      size,
      scale,
      pageZoom,
      rectangle,
      bitmapBytes: bitmap.length,
      colors: pixelProbe,
      decoderRejection: decoded.rejection,
    },
    tag: decoded.tag,
  }
}
