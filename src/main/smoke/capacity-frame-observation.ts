import type { BrowserWindow } from 'electron'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { addCapacityTerminals } from './capacity-terminals'
import { focusSmokeWindow } from './window-focus'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'

interface ObservationGeometry {
  engine: 'web' | 'native'
  x: number
  y: number
  width: number
  height: number
  canvasWidth: number
  canvasHeight: number
  cssWidth: number
  cssHeight: number
  scale: number
}

/** Diagnostic only: real VT colors reach the same BrowserWindow compositor in
 * either engine. No ACK/rAF qualifies a color; no bitmap/transcript is retained. */
export async function diagnoseCapacityFrameObservation(
  win: BrowserWindow,
  supervisor: PtySupervisor,
  native?: NativeTerminalApplication,
): Promise<void> {
  await addCapacityTerminals(win, 1)
  await focusSmokeWindow(win)
  const terminal = supervisor.list()[0]
  if (!terminal || supervisor.list().length !== 1)
    throw new Error('capacity-observation-terminal-count')
  const nativeSession = native?.sessions.get(terminal.id)
  const requestedEngine = process.env['HVIR_NATIVE_TERMINAL_LIBRARY'] ? 'native' : 'web'
  if (
    requestedEngine === 'native' &&
    (!nativeSession ||
      nativeSession.unavailable ||
      nativeSession.session.instanceId !== terminal.instanceId)
  )
    throw new Error('capacity-observation-native-instance-mismatch')
  const baseline = await measureFrameGaps(win)
  const geometry = await readGeometry(win)
  if (geometry.engine !== requestedEngine)
    throw new Error('capacity-observation-engine-mismatch')
  const captureDurationsMs: number[] = []
  const observationDurationsMs: number[] = []
  const captureRequests: number[] = []
  const captureCompletions: number[] = []
  let complete = false
  await win.webContents.executeJavaScript(`(() => {
    const state={gaps:[],previous:undefined,animation:undefined,truncated:false};
    const sample=now=>{
      if(state.previous!==undefined){
        if(state.gaps.length<8192)state.gaps.push(now-state.previous);
        else state.truncated=true;
      }
      state.previous=now;state.animation=requestAnimationFrame(sample);
    };state.animation=requestAnimationFrame(sample);
    globalThis.__hvirCapacityObservation=state;return true;
  })()`)
  let during: unknown
  try {
    // Fixed diagnostic population includes cold capture. Unique colors prevent
    // a frame from an earlier update satisfying a later observation.
    for (let sequence = 0; sequence < 20; sequence++) {
      const rgb: [number, number, number] = [
        32 + (sequence % 5) * 40,
        64 + Math.floor(sequence / 5) * 40,
        224,
      ]
      const started = performance.now()
      await supervisor.writeConfirmed(
        terminal.id,
        terminal.ownerId,
        `printf '\\033[2J\\033[H\\033[48;2;${rgb.join(';')}m\\033[2K\\033[2;1H\\033[0m'\r`,
        terminal.ownerGeneration,
      )
      const deadline = started + 5_000
      let matched = false
      while (performance.now() < deadline) {
        if (captureRequests.length === 1000)
          throw new Error('capacity-observation-diagnostic-sample-bound')
        const requested = performance.now()
        const image = await win.webContents.capturePage(geometry)
        const completed = performance.now()
        captureRequests.push(requested)
        captureCompletions.push(completed)
        captureDurationsMs.push(completed - requested)
        if (matchesCapacityFrameColor(image.toBitmap(), rgb)) {
          observationDurationsMs.push(completed - started)
          matched = true
          break
        }
      }
      if (!matched) throw new Error('capacity-observation-color-timeout')
    }
    const finalGeometry = await readGeometry(win)
    if (JSON.stringify(finalGeometry) !== JSON.stringify(geometry))
      throw new Error('capacity-observation-geometry-changed')
    complete = true
  } finally {
    during = await win.webContents.executeJavaScript(`(() => {
      const state=globalThis.__hvirCapacityObservation;
      if(!state)throw new Error('capacity-observation-missing-cadence');
      cancelAnimationFrame(state.animation);
      delete globalThis.__hvirCapacityObservation;
      return {gaps:state.gaps,truncated:state.truncated,
        visible:document.visibilityState==='visible',focused:document.hasFocus()};
    })()`)
    console.log(
      '[smoke:capacity:observation-diagnostic] ' +
        JSON.stringify({
          schema: 1,
          diagnosticOnly: true,
          complete,
          physicalPresentationQualified: false,
          controlledComparisonQualified: false,
          productionZeroReadbackQualified: false,
          observation: 'BrowserWindow capturePage compositor BGRA color',
          clock:
            'main performance.now; writeConfirmed start to matching capture completion',
          geometry,
          requestedEngine,
          observedEngine: geometry.engine,
          nativeInstanceMatched: !!nativeSession,
          scheduledUpdates: 20,
          matchedUpdates: observationDurationsMs.length,
          captureRequests,
          captureCompletions,
          captureDurationsMs,
          observationDurationsMs,
          baselineFrameGapsMs: baseline,
          duringCaptureCadence: during,
        }),
    )
  }
}

/** NativeImage.toBitmap returns BGRA. A stale cursor or edge cannot qualify the
 * real sampled region: at least three quarters must match with opaque alpha. */
export function matchesCapacityFrameColor(
  bitmap: Uint8Array,
  rgb: readonly [number, number, number],
): boolean {
  if (bitmap.length === 0 || bitmap.length % 4 !== 0) return false
  let matching = 0
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    if (
      Math.abs(bitmap[offset + 2]! - rgb[0]) <= 12 &&
      Math.abs(bitmap[offset + 1]! - rgb[1]) <= 12 &&
      Math.abs(bitmap[offset]! - rgb[2]) <= 12 &&
      bitmap[offset + 3]! >= 240
    )
      matching++
  }
  return matching / (bitmap.length / 4) >= 0.75
}

async function readGeometry(win: BrowserWindow): Promise<ObservationGeometry> {
  const value: unknown = await win.webContents.executeJavaScript(`(() => {
    const surface=document.querySelector('.terminal-surface.active');
    const canvas=surface?.querySelector('.terminal-engine-host canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('capacity-observation-canvas');
    const b=canvas.getBoundingClientRect();
    return {engine:surface.querySelector('.native-terminal-pane')?'native':'web',
      x:Math.ceil(b.x)+4,y:Math.ceil(b.y)+4,width:32,height:4,
      canvasWidth:canvas.width,canvasHeight:canvas.height,
      cssWidth:b.width,cssHeight:b.height,scale:devicePixelRatio};
  })()`)
  return value as ObservationGeometry
}

async function measureFrameGaps(win: BrowserWindow): Promise<readonly number[]> {
  const value: unknown = await win.webContents.executeJavaScript(`new Promise(resolve=>{
    const gaps=[];let previous;
    const sample=now=>{
      if(previous!==undefined)gaps.push(now-previous);
      previous=now;
      if(gaps.length===20)resolve(gaps);else requestAnimationFrame(sample);
    };requestAnimationFrame(sample);
  })`)
  return value as readonly number[]
}
