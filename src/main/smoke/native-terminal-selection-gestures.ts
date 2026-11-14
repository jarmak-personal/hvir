import type { BrowserWindow } from 'electron'
import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import type { NativeTerminalApplication } from '../terminal/native-terminal-application'
import {
  paneScript,
  nativeSelectionHitCensusScript,
  type nativeSelectionBrowser,
} from './native-terminal-selection-browser'

type Browser = ReturnType<typeof nativeSelectionBrowser>
type Copy = () => Promise<{ bytes: number; sha256: string }>
interface GestureObservation {
  pointerId?: number
  events: {
    type: string
    trusted: boolean
    outside: boolean
    pointerId?: number
    buttons?: number
    targetInput?: boolean
    targetSurface?: boolean
    targetRoot?: boolean
    relatedInside?: boolean
    captured?: boolean
  }[]
  captured: boolean
  activeTag?: string
  activeRole?: string
  activeClasses?: string
  inputConnected?: boolean
  inputActive: boolean
  sourceActive: boolean
  connected: boolean
  overflow: boolean
}

/** Qualification-only trusted-event observation; no terminal text or protocol state mirror. */
export function nativeSelectionGestureObserver(session: string): string {
  return `(()=>{${paneScript(session)}
 const abort=new AbortController(),events=[];let pointerId,observing=true,overflow=false;
 for(const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture','focusin','focusout'])window.addEventListener(type,event=>{
   if(!observing)return;if(type==='pointerdown'&&pane.contains(event.target)&&pointerId===undefined)pointerId=event.pointerId;
   const focus=type==='focusin'||type==='focusout';
   if(pointerId===undefined||(!focus&&event.pointerId!==pointerId)||(focus&&!pane.contains(event.target)&&!pane.contains(event.relatedTarget)))return;
   if(events.length===16){overflow=true;return;}
   events.push({type,trusted:event.isTrusted,outside:!pane.contains(event.target),pointerId:event.pointerId,buttons:event.buttons,targetInput:event.target===input,targetSurface:event.target===surface,targetRoot:event.target===pane,relatedInside:pane.contains(event.relatedTarget),captured:pane.hasPointerCapture(pointerId)});
 },{capture:true,signal:abort.signal});
 window.nativeSelectionGestureProbe={state:()=>({pointerId,events,captured:pointerId!==undefined&&pane.hasPointerCapture(pointerId),inputActive:document.activeElement===input,sourceActive:pane.contains(document.activeElement),connected:pane.isConnected,inputConnected:input.isConnected,activeTag:document.activeElement?.tagName,activeRole:document.activeElement?.getAttribute('role')?.slice(0,32),activeClasses:typeof document.activeElement?.className==='string'?document.activeElement.className.slice(0,128):undefined,overflow}),finish:()=>{observing=false;},restore:()=>{abort.abort();delete window.nativeSelectionGestureProbe;}};return true;
})()`
}
const observe = (win: BrowserWindow) =>
  win.webContents.executeJavaScript(
    'window.nativeSelectionGestureProbe.state()',
  ) as Promise<GestureObservation>
const finish = (win: BrowserWindow) =>
  win.webContents.executeJavaScript('window.nativeSelectionGestureProbe.finish();true')
const restore = (win: BrowserWindow) =>
  win.webContents.executeJavaScript('window.nativeSelectionGestureProbe?.restore();true')

/** Hold only delivery of a real completed press, never native input or the parser. */
export async function verifyNativePendingPointer(
  win: BrowserWindow,
  native: NativeTerminalApplication,
  managed: ManagedPty,
  browser: Browser,
  copy: Copy,
) {
  const previousInput = Object.getOwnPropertyDescriptor(native, 'input')
  const original = native.input.bind(native),
    viewId = (await browser.layout()).bounds.viewId
  let release!: () => void
  const acknowledgement = new Promise<void>((resolve) => {
    release = resolve
  })
  let pressed = false,
    released = false
  const nativeEvents: { kind: string; originalView: boolean }[] = []
  let nativeOverflow = false
  const record = (event: (typeof nativeEvents)[number]) => {
    if (nativeEvents.length === 16) nativeOverflow = true
    else nativeEvents.push(event)
  }
  native.input = async (...args) => {
    const result = await original.apply(native, args),
      input = args[2]
    if (input.kind === 'pointer') {
      if (!pressed && args[0] === viewId && input.button === 1 && input.action === 1) {
        pressed = true
        record({ kind: 'press', originalView: true })
        await acknowledgement
      } else if (pressed) {
        record({
          kind: input.action === 0 ? 'release' : input.action === 1 ? 'press' : 'move',
          originalView: args[0] === viewId,
        })
      }
    }
    return result
  }
  let outside: { x: number; y: number } | undefined
  try {
    await browser.clear()
    await win.webContents.executeJavaScript(nativeSelectionGestureObserver(managed.id))
    const start = await browser.point(4.9, 4.5),
      layout = await browser.layout()
    outside = { x: layout.bounds.x - 12, y: start.y }
    browser.mouse('mouseMove', start.x, start.y)
    browser.mouse('mouseDown', start.x, start.y)
    await browser.wait(() => pressed, 'pending-real-press-completion')
    browser.mouse('mouseMove', outside.x, outside.y, 'left', 1, ['leftbuttondown'])
    browser.mouse('mouseUp', outside.x, outside.y)
    let before!: GestureObservation
    await browser.wait(async () => {
      before = await observe(win)
      return before.events.some((event) => event.type === 'pointerup' && event.outside)
    }, 'pending-trusted-outside-up')
    const heldMove = before.events.find(
      (event) => event.type === 'pointermove' && event.outside && event.trusted,
    )
    const trustedOutsideMove = !!heldMove,
      trustedOutsideUp = before.events.some(
        (event) => event.type === 'pointerup' && event.outside && event.trusted,
      ),
      ackHeldUntilOutsideUp = pressed && !released && nativeEvents.length === 1,
      captureReleasedBeforeAck = !before.captured
    if (
      !trustedOutsideMove ||
      heldMove?.buttons !== 1 ||
      !trustedOutsideUp ||
      !ackHeldUntilOutsideUp ||
      !captureReleasedBeforeAck ||
      before.pointerId === undefined ||
      before.overflow ||
      nativeOverflow ||
      !before.connected
    )
      throw new Error('native-selection-pending-outside-observation')
    released = true
    release()
    await browser.wait(
      () => nativeEvents.some((event) => event.kind === 'release'),
      'pending-native-release',
    )
    const after = await observe(win),
      kinds = nativeEvents.map((event) => event.kind),
      nativeOriginalViewOrder =
        kinds[0] === 'press' &&
        kinds.indexOf('move') > 0 &&
        kinds.indexOf('release') > kinds.indexOf('move') &&
        nativeEvents.every((event) => event.originalView)
    if (!nativeOriginalViewOrder || nativeOverflow || after.captured || !after.connected)
      throw new Error('native-selection-pending-route-or-capture')
    await finish(win)
    const selected = await copy()
    return {
      pointerId: before.pointerId,
      trustedOutsideMove,
      heldMoveButtons: heldMove.buttons,
      trustedOutsideUp,
      ackHeldUntilOutsideUp,
      nativeOriginalViewOrder,
      captureReleasedBeforeAck,
      captureReleasedAfterAck: !after.captured,
      exactSelectedBytes: selected.bytes,
      exactSelectedSha256: selected.sha256,
    }
  } catch (error) {
    console.log(
      'HVIR_NATIVE_SELECTION_GESTURE_FAILURE ' +
        JSON.stringify({
          phase: 'pending-press-ack',
          pressed,
          released,
          nativeEvents,
          nativeOverflow,
          observation: await observe(win).catch(() => undefined),
        }),
    )
    throw error
  } finally {
    release()
    if (previousInput) Object.defineProperty(native, 'input', previousInput)
    else Reflect.deleteProperty(native, 'input')
    if (outside) browser.mouse('mouseUp', outside.x, outside.y)
    await restore(win).catch(() => undefined)
  }
}

/** Retained native selection survives a real readonly Tab blur with no physical PTY. */
export async function verifyNativeReadonlyPointerBlur(
  win: BrowserWindow,
  ptys: PtySupervisor,
  native: NativeTerminalApplication,
  managed: ManagedPty,
  browser: Browser,
  lastColumn: number,
  copy: Copy,
) {
  const previousInput = Object.getOwnPropertyDescriptor(native, 'input')
  const original = native.input.bind(native),
    write = ptys.writeConfirmed.bind(ptys),
    viewId = (await browser.layout()).bounds.viewId
  let pressed = false,
    moved = false,
    nativeFocusCleanup = false,
    ptyWrites = 0
  const completions: object[] = []
  let completionOverflow = false
  native.input = async (...args) => {
    const result = await original.apply(native, args),
      input = args[2]
    if (completions.length === 16) completionOverflow = true
    else
      completions.push({
        kind: input.kind,
        action: input.kind === 'pointer' ? input.action : undefined,
        originalView: args[0] === viewId,
        captured: 'captured' in result ? result.captured : undefined,
        selectionResult: 'selectionResult' in result ? result.selectionResult : undefined,
        refused: 'refused' in result ? result.refused : undefined,
        requestedMutation: result.requestedMutation,
      })
    if (args[0] === viewId) {
      if (input.kind === 'pointer' && input.button === 1 && input.action === 1)
        pressed = true
      if (pressed && input.kind === 'pointer' && input.action === undefined) moved = true
      if (moved && input.kind === 'focus' && !input.focused) nativeFocusCleanup = true
    }
    return result
  }
  const previousWrite = Object.getOwnPropertyDescriptor(ptys, 'writeConfirmed')
  ptys.writeConfirmed = (...args) => {
    ptyWrites++
    return write.apply(ptys, args)
  }
  let outside: { x: number; y: number } | undefined
  let intendedEnd: { x: number; y: number } | undefined
  const hitCensuses: unknown[] = []
  const census = async (point: { x: number; y: number }) => {
    const observation: unknown = await win.webContents.executeJavaScript(
      nativeSelectionHitCensusScript(managed.id, point.x, point.y),
    )
    if (hitCensuses.length < 3) hitCensuses.push(observation)
  }
  try {
    if (ptys.list().length !== 0) throw new Error('native-selection-readonly-pty')
    await browser.clear()
    await win.webContents.executeJavaScript(nativeSelectionGestureObserver(managed.id))
    const start = await browser.point(0.25, 0.5),
      end = await browser.point(lastColumn, 0.5),
      layout = await browser.layout()
    outside = { x: layout.bounds.x - 12, y: start.y }
    intendedEnd = end
    await census(start)
    await census(end)
    browser.mouse('mouseMove', start.x, start.y)
    browser.mouse('mouseDown', start.x, start.y)
    browser.mouse('mouseMove', end.x, end.y, 'left', 1, ['leftbuttondown'])
    let owned!: GestureObservation
    await browser.wait(async () => {
      owned = await observe(win)
      return pressed && moved && owned.captured && owned.sourceActive
    }, 'readonly-owned-drag')
    const heldMove = owned.events.find(
      (event) => event.type === 'pointermove' && event.trusted,
    )
    if (heldMove?.buttons !== 1) throw new Error('native-selection-readonly-held-buttons')
    browser.key('Tab')
    let blurred!: GestureObservation
    await browser.wait(async () => {
      blurred = await observe(win)
      return nativeFocusCleanup && !blurred.sourceActive && !blurred.captured
    }, 'readonly-tab-native-cleanup')
    if (
      owned.pointerId === undefined ||
      owned.overflow ||
      blurred.overflow ||
      !blurred.connected ||
      completionOverflow
    )
      throw new Error('native-selection-readonly-blur-observation')
    browser.mouse('mouseMove', outside.x, outside.y)
    browser.mouse('mouseUp', outside.x, outside.y)
    await finish(win)
    const selected = await copy()
    if (ptyWrites !== 0 || ptys.list().length !== 0)
      throw new Error('native-selection-readonly-wrote')
    return {
      copied: selected,
      gestureBlur: {
        pointerId: owned.pointerId,
        acknowledgedDrag: pressed && moved,
        heldMoveButtons: heldMove.buttons,
        tabChangedFocus: !blurred.sourceActive,
        nativeFocusCleanup,
        captureReleased: !blurred.captured,
        ptyWrites: 0,
        ptyCount: 0,
        selectedRangePreserved: true,
      },
    }
  } catch (error) {
    if (intendedEnd) await census(intendedEnd).catch(() => undefined)
    console.log(
      'HVIR_NATIVE_SELECTION_GESTURE_FAILURE ' +
        JSON.stringify({
          phase: 'readonly-gesture-blur',
          completions,
          completionOverflow,
          hitCensuses,
          pressed,
          moved,
          nativeFocusCleanup,
          ptyWrites,
          observation: await observe(win).catch(() => undefined),
        }),
    )
    throw error
  } finally {
    if (previousInput) Object.defineProperty(native, 'input', previousInput)
    else Reflect.deleteProperty(native, 'input')
    if (previousWrite) Object.defineProperty(ptys, 'writeConfirmed', previousWrite)
    else Reflect.deleteProperty(ptys, 'writeConfirmed')
    if (outside) browser.mouse('mouseUp', outside.x, outside.y)
    await restore(win).catch(() => undefined)
  }
}
