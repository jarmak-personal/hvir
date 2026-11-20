import type { BrowserWindow, SharedTextureImported, WebFrameMain } from 'electron'
import type { RendererResourceScopes, RendererOwner } from '../renderer-resource-scopes'
import { NativeTerminalFrameImports } from '../terminal/native-terminal-import'
import { validNativeTerminalViewGrant } from '../../shared/native-terminal-presentation'

export interface NativeImportFrameFacts {
  isDestroyed: boolean | null
  detached: boolean | null
  processId: number | null
  osProcessId: number | null
  routingId: number | null
  frameTreeNodeId: number | null
  frameToken: string | null
  readUnavailable: boolean
}

/** Closed scalar snapshot; Chromium IDs and LocalFrameToken are not document authority. */
export function nativeImportFrameFacts(frame?: WebFrameMain): NativeImportFrameFacts {
  const facts: NativeImportFrameFacts = {
    isDestroyed: null,
    detached: null,
    processId: null,
    osProcessId: null,
    routingId: null,
    frameTreeNodeId: null,
    frameToken: null,
    readUnavailable: true,
  }
  if (!frame) return facts
  try {
    const value = frame.isDestroyed()
    if (typeof value !== 'boolean') return facts
    facts.isDestroyed = value
    if (value) return facts
  } catch {
    return facts
  }
  for (const key of [
    'processId',
    'osProcessId',
    'routingId',
    'frameTreeNodeId',
  ] as const) {
    try {
      const value = frame[key]
      if (Number.isSafeInteger(value) && value >= (key === 'osProcessId' ? 1 : 0))
        facts[key] = value
    } catch {
      /* Unknown. */
    }
  }
  try {
    const value = frame.detached
    if (typeof value === 'boolean') facts.detached = value
  } catch {
    /* Unknown. */
  }
  try {
    const token = frame.frameToken
    if (typeof token === 'string' && /^[a-fA-F0-9-]{1,128}$/.test(token))
      facts.frameToken = token
  } catch {
    /* Unknown. */
  }
  facts.readUnavailable = Object.entries(facts).some(
    ([key, value]) => key !== 'readUnavailable' && value === null,
  )
  return facts
}

type ImportStage =
  | 'acquire-enter'
  | 'receive-enter'
  | 'receive-resolved'
  | 'receive-rejected'
  | 'transfer-enter'
  | 'transfer-resolved'
  | 'transfer-rejected'
  | 'import-enter'
  | 'import-return'
  | 'import-rejected'
  | 'send-enter'
  | 'send-resolved'
  | 'send-rejected'
  | 'main-release-enter'
  | 'main-release-return'
  | 'main-release-rejected'
  | 'references-released'
  | 'receipt-release-enter'
  | 'receipt-release-return'
  | 'receipt-release-rejected'
  | 'producer-release-enter'
  | 'producer-release-return'
  | 'producer-release-rejected'
type ImportFact = { stage: ImportStage; atMs: number | null; error?: string }
type ImportTrace = { resource: number; emit(fact: ImportFact): void }
type PendingReceive = { trace?: ImportTrace; facts: ImportFact[]; receipt?: object }

/** Smoke decoration at the injected resource/texture/source edges. No inferred
 * importer state, credit accounting or physical callback classification. */
export function createObservedNativeFrameImports(
  ...[edge, textures]: ConstructorParameters<typeof NativeTerminalFrameImports>
): Pick<NativeTerminalFrameImports, 'acquire'> {
  let resource = 0,
    event = 0,
    printed = 0,
    snapshots = 0
  const ring: object[] = []
  const pending = new Map<string, PendingReceive>()
  const receipts = new WeakMap<object, ImportTrace>()
  const imports = new WeakMap<
    SharedTextureImported,
    { trace: ImportTrace; original: SharedTextureImported }
  >()
  let handshake: ImportTrace | undefined
  const enabled = () =>
    typeof __HVIR_SMOKE_BUILD__ !== 'undefined' &&
    __HVIR_SMOKE_BUILD__ &&
    process.env['HVIR_NATIVE_IMPORT_DIAGNOSTICS'] === '1'
  const fact = (stage: ImportStage, error?: unknown): ImportFact => {
    let atMs: number | null = null
    try {
      atMs = performance.now()
    } catch {
      /* Unavailable, never invented zero. */
    }
    return {
      stage,
      atMs,
      ...(stage.endsWith('-rejected') ? { error: importErrorCategory(error) } : {}),
    }
  }
  const observe = <T>(
    value: Promise<T>,
    trace: ImportTrace,
    resolved: ImportStage,
    rejected: ImportStage,
  ): Promise<T> => {
    void value.then(
      () => trace.emit(fact(resolved)),
      (error: unknown) => trace.emit(fact(rejected, error)),
    )
    return value
  }
  const core = new NativeTerminalFrameImports(
    {
      receive(ticket) {
        // Receive starts each serialized handshake before its source.transfer call.
        handshake = undefined
        if (!enabled()) return edge.receive.call(edge, ticket)
        const entry: PendingReceive = { facts: [fact('receive-enter')] }
        if (pending.size < 2048) pending.set(ticket, entry)
        const emit = (value: ImportFact) => {
          if (entry.trace) entry.trace.emit(value)
          else if (entry.facts.length < 3) entry.facts.push(value)
        }
        try {
          const result = edge.receive.call(edge, ticket)
          void result.then(
            (receipt) => {
              entry.receipt = receipt
              if (entry.trace) receipts.set(receipt, entry.trace)
              emit(fact('receive-resolved'))
            },
            (error: unknown) => emit(fact('receive-rejected', error)),
          )
          return result
        } catch (error) {
          emit(fact('receive-rejected', error))
          pending.delete(ticket)
          throw error
        }
      },
      release(receipt) {
        const trace = receipts.get(receipt)
        if (!trace) return edge.release.call(edge, receipt)
        trace.emit(fact('receipt-release-enter'))
        try {
          const result = edge.release.call(edge, receipt)
          trace.emit(fact('receipt-release-return'))
          return result
        } catch (error) {
          trace.emit(fact('receipt-release-rejected', error))
          throw error
        }
      },
    },
    {
      importSharedTexture(options) {
        const trace = handshake
        if (!trace) return textures.importSharedTexture.call(textures, options)
        trace.emit(fact('import-enter'))
        const callback = options.allReferencesReleased
        try {
          const original = textures.importSharedTexture.call(textures, {
            ...options,
            allReferencesReleased: function (this: unknown, ...args: []) {
              trace.emit(fact('references-released'))
              return callback?.apply(this, args)
            },
          })
          const wrapped: SharedTextureImported = {
            getVideoFrame: () => original.getVideoFrame.call(original),
            get subtle() {
              return original.subtle
            },
            get textureId() {
              return original.textureId
            },
            release() {
              trace.emit(fact('main-release-enter'))
              try {
                const result = original.release.call(original)
                trace.emit(fact('main-release-return'))
                return result
              } catch (error) {
                trace.emit(fact('main-release-rejected', error))
                throw error
              }
            },
          }
          imports.set(wrapped, { trace, original })
          trace.emit(fact('import-return'))
          return wrapped
        } catch (error) {
          trace.emit(fact('import-rejected', error))
          throw error
        }
      },
      sendSharedTexture(options, ...metadata: unknown[]) {
        const imported = imports.get(options.importedSharedTexture)
        if (!imported)
          return textures.sendSharedTexture.call(textures, options, ...metadata)
        const { trace, original } = imported
        trace.emit(fact('send-enter'))
        try {
          const value = metadata[0]
          let decorated = value
          try {
            if (value && typeof value === 'object')
              decorated = { ...value, hvirImportObservation: trace.resource }
          } catch {
            /* Metadata observation failure leaves the original argument intact. */
          }
          return observe(
            textures.sendSharedTexture.call(
              textures,
              { ...options, importedSharedTexture: original },
              decorated,
              ...metadata.slice(1),
            ),
            trace,
            'send-resolved',
            'send-rejected',
          )
        } catch (error) {
          trace.emit(fact('send-rejected', error))
          throw error
        }
      },
    },
  )
  return {
    acquire(source, target, options) {
      if (!enabled()) return core.acquire(source, target, options)
      const ordinal = ++resource
      let hadError = false
      const trace: ImportTrace = {
        resource: ordinal,
        emit(value) {
          try {
            hadError ||= value.stage.endsWith('-rejected')
            const presentation = target.presentation?.nativeTerminal
            const grant = validNativeTerminalViewGrant(presentation)
              ? {
                  viewId: presentation.viewId,
                  nativeEpoch: presentation.nativeEpoch,
                  attachment: presentation.attachment,
                  geometrySerial: presentation.geometrySerial,
                  width: presentation.width,
                  height: presentation.height,
                  backingScale: presentation.backingScale,
                }
              : undefined
            const record = {
              schema: 1,
              clock: 'main performance.now',
              timeOrigin: performance.timeOrigin,
              event: ++event,
              resource: ordinal,
              ...value,
              grant,
              nominalRgbaBytes: source.metadata.width * source.metadata.height * 4,
              ...(value.stage === 'import-enter' || value.stage === 'send-enter'
                ? { targetFrame: nativeImportFrameFacts(target.frame) }
                : {}),
            }
            ring.push(record)
            if (ring.length > 2048) ring.shift()
            if (printed < 2048) {
              printed++
              console.log('HVIR_NATIVE_IMPORT_STAGE ' + JSON.stringify(record))
            }
            if (
              snapshots < 16 &&
              (value.stage.endsWith('-rejected') ||
                (hadError && value.stage === 'references-released'))
            ) {
              snapshots++
              console.log(
                'HVIR_NATIVE_IMPORT_TAIL ' +
                  JSON.stringify({
                    schema: 1,
                    clock: 'main performance.now',
                    truncated: event > 2048,
                    events: ring.slice(),
                  }),
              )
            }
          } catch {
            /* Diagnostic failure never replaces the original boundary result. */
          }
        },
      }
      trace.emit(fact('acquire-enter'))
      return core.acquire(
        {
          get metadata() {
            return source.metadata
          },
          assertCurrent: () => source.assertCurrent.call(source),
          copyPixels: () => source.copyPixels.call(source),
          ...(source.retireProducer
            ? { retireProducer: () => source.retireProducer!.call(source) }
            : {}),
          transfer(ticket) {
            handshake = trace
            const entry = pending.get(ticket)
            pending.delete(ticket)
            if (entry) {
              entry.trace = trace
              if (entry.receipt) receipts.set(entry.receipt, trace)
              for (const value of entry.facts) trace.emit(value)
              entry.facts.length = 0
            }
            trace.emit(fact('transfer-enter'))
            try {
              return observe(
                source.transfer.call(source, ticket),
                trace,
                'transfer-resolved',
                'transfer-rejected',
              )
            } catch (error) {
              trace.emit(fact('transfer-rejected', error))
              throw error
            }
          },
          release() {
            trace.emit(fact('producer-release-enter'))
            try {
              return observe(
                source.release.call(source),
                trace,
                'producer-release-return',
                'producer-release-rejected',
              )
            } catch (error) {
              trace.emit(fact('producer-release-rejected', error))
              throw error
            }
          },
        },
        target,
        options,
      )
    },
  }
}

function importErrorCategory(error: unknown): string {
  try {
    if (error instanceof Error) {
      if (
        error.message ===
        'transfer shared texture timed out after 1000ms, ensure you have registered receiver at renderer process.'
      )
        return 'send-timeout-1000ms'
      if (error.message === 'Failed to import shared texture: GPU is not available')
        return 'gpu-unavailable-before-import'
      if (error.message === 'native-import-target-stale') return 'target-stale'
    }
  } catch {
    /* Unknown. */
  }
  return 'unknown'
}

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
