import type { BrowserWindow, WebFrameMain } from 'electron'
import type { RendererResourceScopes, RendererOwner } from '../renderer-resource-scopes'
import { nativeImportFrameFacts } from '../terminal/native-terminal-import'
import { validNativeTerminalViewGrant } from '../../shared/native-terminal-presentation'

const PREFIX = 'HVIR_NATIVE_RECEIVER_STAGE '
const STAGES = new Set([
  'receiver-entry',
  'receiver-ineligible',
  'video-frame-acquired',
  'canvas-submitted',
  'frame-close-enter',
  'frame-close-return',
  'frame-close-rejected',
  'texture-release-enter',
  'texture-release-return',
  'texture-release-rejected',
])

/** Accept only the preload's closed diagnostic facts, never arbitrary console
 * text. The WebContents listener survives reload and preserves old-realm clocks. */
export function nativeReceiverDiagnosticLine(message: string): string | undefined {
  if (!message.startsWith(PREFIX) || message.length > 2048) return
  try {
    const parsed: unknown = JSON.parse(message.slice(PREFIX.length))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const value = parsed as Record<string, unknown>
    if (
      !value ||
      value.schema !== 1 ||
      typeof value.stage !== 'string' ||
      !STAGES.has(value.stage) ||
      value.clock !== 'renderer performance.now' ||
      ![value.event, value.resource].every(
        (n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0,
      ) ||
      ![value.atMs, value.timeOrigin].every(
        (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0,
      ) ||
      typeof value.truncated !== 'boolean' ||
      typeof value.timelineDisabled !== 'boolean' ||
      !validNativeTerminalViewGrant(value.grant)
    )
      return
    const g = value.grant
    return (
      PREFIX +
      JSON.stringify({
        schema: 1,
        event: value.event,
        clock: value.clock,
        atMs: value.atMs,
        timeOrigin: value.timeOrigin,
        stage: value.stage,
        resource: value.resource,
        truncated: value.truncated,
        timelineDisabled: value.timelineDisabled,
        grant: {
          viewId: g.viewId,
          nativeEpoch: g.nativeEpoch,
          attachment: g.attachment,
          geometrySerial: g.geometrySerial,
          width: g.width,
          height: g.height,
          backingScale: g.backingScale,
        },
      })
    )
  } catch {
    return
  }
}

export function observeNativeReceiverDiagnostic(
  win: BrowserWindow,
  resources: RendererResourceScopes,
): () => void {
  let count = 0
  const listener = (
    event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>,
  ) => {
    if (count >= 8192) return
    const line = nativeReceiverDiagnosticLine(event.message)
    if (line) {
      count++
      console.log(line)
      if (count === 8192)
        console.log(
          'HVIR_NATIVE_RECEIVER_COLLECTION ' +
            JSON.stringify({ truncated: true, records: count }),
        )
    }
  }
  win.webContents.on('console-message', listener)
  const stopNavigation = observeNativeNavigationDiagnostic(win, resources)
  return () => {
    try {
      win.webContents.removeListener('console-message', listener)
    } finally {
      stopNavigation()
    }
  }
}

function ownerFacts(resources: RendererResourceScopes, id: number): RendererOwner | null {
  try {
    const value = resources.currentOwner(id)
    return { id: value.id, generation: value.generation }
  } catch {
    return null
  }
}
function errorCategory(error: unknown): string {
  try {
    return error instanceof TypeError
      ? 'TypeError'
      : error instanceof RangeError
        ? 'RangeError'
        : error instanceof Error
          ? 'Error'
          : 'non-error'
  } catch {
    return 'unknown'
  }
}
function windowFacts(win: BrowserWindow, resources: RendererResourceScopes) {
  let frame: WebFrameMain | undefined,
    loading: boolean | null = null
  try {
    frame = win.webContents.mainFrame
  } catch {
    /* Unknown. */
  }
  try {
    const value = win.webContents.isLoadingMainFrame()
    if (typeof value === 'boolean') loading = value
  } catch {
    /* Unknown. */
  }
  return {
    currentFrame: nativeImportFrameFacts(frame),
    owner: ownerFacts(resources, win.webContents.id),
    loading,
  }
}

/** Selected main chronology only; raw navigation is not an accepted owner transition. */
function observeNativeNavigationDiagnostic(
  win: BrowserWindow,
  resources: RendererResourceScopes,
): () => void {
  const contents = win.webContents
  let count = 0,
    active = true
  const emit = (stage: string, fields: Record<string, unknown> = {}) => {
    if (!active) return
    try {
      const event = ++count
      if (event > 2048) return
      console.log(
        'HVIR_NATIVE_NAVIGATION_STAGE ' +
          JSON.stringify({
            schema: 1,
            stream: 'navigation',
            event,
            clock: 'main performance.now',
            timeOrigin: performance.timeOrigin,
            atMs: performance.now(),
            stage,
            ...windowFacts(win, resources),
            ...fields,
          }),
      )
      if (event === 2048)
        console.log(
          'HVIR_NATIVE_NAVIGATION_COLLECTION ' +
            JSON.stringify({ records: 2048, truncated: true }),
        )
    } catch {
      /* Observation never changes navigation or owner authority. */
    }
  }
  const numeric = (value: number) => (Number.isSafeInteger(value) ? value : null)
  const start = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    _url: string,
    _inPlace: boolean,
    _main: boolean,
    processId: number,
    routingId: number,
  ) => {
    if (details.isMainFrame)
      emit('did-start-navigation', {
        inPlace: details.isSameDocument,
        processId: numeric(processId),
        routingId: numeric(routingId),
      })
  }
  const navigate = (
    _event: Electron.Event,
    _url: string,
    _status: number,
    _text: string,
    main: boolean,
    processId: number,
    routingId: number,
  ) => {
    if (main)
      emit('did-frame-navigate', {
        processId: numeric(processId),
        routingId: numeric(routingId),
      })
  }
  const finish = (
    _event: Electron.Event,
    main: boolean,
    processId: number,
    routingId: number,
  ) => {
    if (main)
      emit('did-frame-finish-load', {
        processId: numeric(processId),
        routingId: numeric(routingId),
      })
  }
  const fail = (
    _event: Electron.Event,
    code: number,
    _text: string,
    _url: string,
    main: boolean,
    processId: number,
    routingId: number,
  ) => {
    if (main)
      emit('did-fail-load', {
        code: numeric(code),
        processId: numeric(processId),
        routingId: numeric(routingId),
      })
  }
  const gone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
    const reasons = [
      'clean-exit',
      'abnormal-exit',
      'killed',
      'crashed',
      'oom',
      'launch-failed',
      'integrity-failure',
    ]
    emit('render-process-gone', {
      reason: reasons.includes(details.reason) ? details.reason : 'unknown',
    })
  }
  const rolloverDescriptor = Object.getOwnPropertyDescriptor(resources, 'rolloverOwner'),
    rollover: RendererResourceScopes['rolloverOwner'] = Reflect.get(
      resources,
      'rolloverOwner',
    )
  const resumeDescriptor = Object.getOwnPropertyDescriptor(resources, 'resumeOwnerIpc'),
    resume: RendererResourceScopes['resumeOwnerIpc'] = Reflect.get(
      resources,
      'resumeOwnerIpc',
    )
  const reloadDescriptor = Object.getOwnPropertyDescriptor(contents, 'reload'),
    reload: typeof contents.reload = Reflect.get(contents, 'reload')
  const stop = () => {
    active = false
    try {
      contents.removeListener('did-start-navigation', start)
      contents.removeListener('did-frame-navigate', navigate)
      contents.removeListener('did-frame-finish-load', finish)
      contents.removeListener('did-fail-load', fail)
      contents.removeListener('render-process-gone', gone)
    } finally {
      try {
        if (rolloverDescriptor)
          Object.defineProperty(resources, 'rolloverOwner', rolloverDescriptor)
        else delete (resources as Partial<RendererResourceScopes>).rolloverOwner
      } finally {
        try {
          if (resumeDescriptor)
            Object.defineProperty(resources, 'resumeOwnerIpc', resumeDescriptor)
          else delete (resources as Partial<RendererResourceScopes>).resumeOwnerIpc
        } finally {
          if (reloadDescriptor)
            Object.defineProperty(contents, 'reload', reloadDescriptor)
          else delete (contents as Partial<typeof contents>).reload
        }
      }
    }
  }
  try {
    resources.rolloverOwner = function (...args) {
      if (args[0] !== contents.id) return rollover.apply(this, args)
      emit('rollover-before')
      try {
        const result = rollover.apply(this, args)
        emit('rollover-returned', {
          returnedOwner: { id: result.owner.id, generation: result.owner.generation },
        })
        return result
      } catch (error) {
        emit('rollover-threw', { error: errorCategory(error) })
        throw error
      }
    }
    resources.resumeOwnerIpc = function (...args) {
      if (args[0].id !== contents.id) return resume.apply(this, args)
      emit('resume-before', {
        requestedOwner: { id: args[0].id, generation: args[0].generation },
      })
      try {
        const result = resume.apply(this, args)
        emit('resume-returned')
        return result
      } catch (error) {
        emit('resume-threw', { error: errorCategory(error) })
        throw error
      }
    }
    contents.reload = function (...args) {
      emit('reload-request')
      return reload.apply(this, args)
    }
    contents.on('did-start-navigation', start)
    contents.on('did-frame-navigate', navigate)
    contents.on('did-frame-finish-load', finish)
    contents.on('did-fail-load', fail)
    contents.on('render-process-gone', gone)
  } catch (error) {
    emit('observer-unavailable', { error: errorCategory(error) })
    stop()
  }
  return stop
}

let targetEvents = 0
/** Observe actual target decisions, not a second evaluation of their policy. */
export function nativeTargetDiagnostic(
  win: BrowserWindow,
  resources: RendererResourceScopes,
  frame: WebFrameMain,
  ordinal: number,
  active: () => boolean,
) {
  const enabled = process.env['HVIR_NATIVE_IMPORT_DIAGNOSTIC_WINDOW'] === '1'
  const bound = enabled
    ? {
        frame: nativeImportFrameFacts(frame),
        owner: ownerFacts(resources, win.webContents.id),
      }
    : undefined
  let viewId: string | undefined
  const emit = (stage: string, fields: Record<string, unknown> = {}) => {
    try {
      if (!enabled || !active()) return
      const event = ++targetEvents
      if (event > 2048) return
      let frameCurrent: boolean | null = null
      try {
        frameCurrent = frame === win.webContents.mainFrame
      } catch {
        /* Unknown. */
      }
      console.log(
        'HVIR_NATIVE_TARGET_STAGE ' +
          JSON.stringify({
            schema: 1,
            stream: 'target',
            event,
            clock: 'main performance.now',
            timeOrigin: performance.timeOrigin,
            atMs: performance.now(),
            stage,
            target: ordinal,
            viewId,
            bound,
            liveBoundFrame: nativeImportFrameFacts(frame),
            frameCurrent,
            ...windowFacts(win, resources),
            ...fields,
          }),
      )
      if (event === 2048)
        console.log(
          'HVIR_NATIVE_TARGET_COLLECTION ' +
            JSON.stringify({ records: 2048, truncated: true }),
        )
    } catch {
      /* Observation cannot replace target decisions. */
    }
  }
  emit('bound')
  return {
    correlate(value: string | undefined) {
      viewId = value
      emit('view-correlated')
    },
    predicate(
      stage: 'owner-current' | 'ready' | 'ready-getter' | 'target-current',
      original: () => boolean,
    ) {
      if (!enabled) return original
      return function (this: unknown, ...args: unknown[]): boolean {
        try {
          const result = Reflect.apply(original, this, args) as boolean
          emit(stage, {
            state: 'returned',
            ...(typeof result === 'boolean' ? { result } : {}),
          })
          return result
        } catch (error) {
          emit(stage, { state: 'threw', error: errorCategory(error) })
          throw error
        }
      }
    },
  }
}
