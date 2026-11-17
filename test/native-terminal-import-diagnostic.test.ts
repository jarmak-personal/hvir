import { EventEmitter } from 'node:events'
import type { BrowserWindow, WebFrameMain } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nativeReceiverDiagnosticLine,
  nativeImportFrameFacts,
  nativeTargetDiagnostic,
  observeNativeReceiverDiagnostic,
} from '../src/main/smoke/native-terminal-import-diagnostic'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'

const prefix = 'HVIR_NATIVE_RECEIVER_STAGE '
const event = {
  schema: 1,
  event: 1,
  clock: 'renderer performance.now',
  atMs: 5,
  timeOrigin: 100,
  stage: 'receiver-entry',
  resource: 1,
  truncated: false,
  timelineDisabled: false,
  grant: {
    viewId: '00000000-0000-4000-8000-000000000001',
    nativeEpoch: '00000000-0000-4000-8000-000000000002',
    attachment: 1,
    geometrySerial: 1,
    width: 800,
    height: 600,
    backingScale: 2,
  },
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function frameFixture() {
  return {
    isDestroyed: () => false,
    detached: false,
    processId: 11,
    osProcessId: 1011,
    routingId: 12,
    frameTreeNodeId: 13,
    frameToken: 'a'.repeat(32),
    url: 'private://never-log',
  }
}
function navigationFixture() {
  const frame = frameFixture()
  class Contents extends EventEmitter {
    id = 17
    mainFrame = frame as unknown as WebFrameMain
    isLoadingMainFrame() {
      return false
    }
    reload() {
      return undefined
    }
  }
  const contents = new Contents(),
    resources = new RendererResourceScopes()
  resources.activateOwner(contents.id)
  const win = { webContents: contents } as unknown as BrowserWindow
  return { contents, resources, win, frame }
}
function emitted(
  log: { mock: { calls: readonly (readonly unknown[])[] } },
  prefix: string,
) {
  return log.mock.calls.flatMap(([line]) =>
    typeof line === 'string' && line.startsWith(prefix)
      ? [JSON.parse(line.slice(prefix.length)) as Record<string, unknown>]
      : [],
  )
}

describe('selected native receiver diagnostic collection', () => {
  it('projects only bounded stage/clock/grant facts from console evidence', () => {
    const line = nativeReceiverDiagnosticLine(
      prefix +
        JSON.stringify({
          ...event,
          transcript: 'private-terminal-body',
          grant: { ...event.grant, privatePath: '/private/credential' },
        }),
    )
    expect(line).toBe(prefix + JSON.stringify(event))
    expect(line).not.toContain('private')
  })

  it.each([
    { ...event, stage: 'private-terminal-body' },
    { ...event, timeOrigin: null },
    { ...event, resource: 0 },
    { ...event, clock: 'arbitrary' },
    { ...event, grant: { ...event.grant, viewId: 'unqualified' } },
  ])('refuses invalid stage identity and clocks', (value) => {
    expect(nativeReceiverDiagnosticLine(prefix + JSON.stringify(value))).toBeUndefined()
  })

  it('ignores unrelated, oversized and malformed console text', () => {
    for (const message of [
      'private-terminal-body',
      prefix + '{',
      prefix + 'x'.repeat(2048),
    ])
      expect(nativeReceiverDiagnosticLine(message)).toBeUndefined()
  })
})

describe('closed native frame and actual target decision evidence', () => {
  it('captures immutable scalars while a live WebFrameMain wrapper changes', () => {
    vi.stubEnv('HVIR_NATIVE_IMPORT_DIAGNOSTIC_WINDOW', '1')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const f = navigationFixture()
    const diagnostic = nativeTargetDiagnostic(
      f.win,
      f.resources,
      f.contents.mainFrame,
      1,
      () => true,
    )
    f.frame.routingId = 21
    f.frame.frameToken = 'b'.repeat(32)
    diagnostic.correlate(event.grant.viewId)
    const record = emitted(log, 'HVIR_NATIVE_TARGET_STAGE ').at(-1)!
    expect(record.bound).toMatchObject({
      frame: {
        processId: 11,
        osProcessId: 1011,
        routingId: 12,
        frameToken: 'a'.repeat(32),
      },
    })
    expect(record.liveBoundFrame).toMatchObject({
      routingId: 21,
      frameToken: 'b'.repeat(32),
    })
    expect(record.frameCurrent).toBe(true)
    expect(JSON.stringify(record)).not.toContain('private')
  })

  it('does not read destroyed getters or invent missing IDs', () => {
    const getter = vi.fn(() => {
      throw new Error('private')
    })
    const frame = Object.defineProperty({ isDestroyed: () => true }, 'processId', {
      get: getter,
    })
    expect(nativeImportFrameFacts(frame as WebFrameMain)).toMatchObject({
      isDestroyed: true,
      processId: null,
      detached: null,
      readUnavailable: true,
    })
    expect(getter).not.toHaveBeenCalled()
    expect(nativeImportFrameFacts()).toMatchObject({
      isDestroyed: null,
      frameToken: null,
      readUnavailable: true,
    })
  })

  it('invokes original predicates once with the original receiver, arguments, result and error', () => {
    vi.stubEnv('HVIR_NATIVE_IMPORT_DIAGNOSTIC_WINDOW', '1')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const f = navigationFixture(),
      receiver = { result: false }
    let active = true
    const diagnostic = nativeTargetDiagnostic(
      f.win,
      f.resources,
      f.contents.mainFrame,
      1,
      () => active,
    )
    const original = vi.fn(function (this: typeof receiver) {
      return this.result
    })
    expect(diagnostic.predicate('ready', original).call(receiver, 'argument')).toBe(false)
    expect(original).toHaveBeenCalledExactlyOnceWith('argument')
    expect(original.mock.contexts[0]).toBe(receiver)
    const failure = new TypeError('private terminal body')
    const failing = vi.fn(() => {
      throw failure
    })
    let caught: unknown
    try {
      diagnostic.predicate('target-current', failing)()
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
    expect(failing).toHaveBeenCalledOnce()
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
    const before = log.mock.calls.length
    active = false
    diagnostic.predicate('ready', original).call(receiver)
    expect(log.mock.calls.length).toBe(before)
    expect(original).toHaveBeenCalledTimes(2)
  })
})

describe('selected native navigation and canonical owner observation', () => {
  it('preserves original method results/errors and inherited descriptor shape on cleanup', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const f = navigationFixture()
    const rollover = Reflect.get(f.resources, 'rolloverOwner'),
      resume = Reflect.get(f.resources, 'resumeOwnerIpc'),
      reload = Reflect.get(f.contents, 'reload')
    const stop = observeNativeReceiverDiagnostic(f.win, f.resources)
    const transition = f.resources.rolloverOwner(f.contents.id)
    expect(transition.owner.generation).toBe(2)
    f.resources.resumeOwnerIpc(transition.owner)
    expect(() => f.resources.resumeOwnerIpc({ id: 17, generation: 1 })).toThrow('revoked')
    f.contents.reload()
    f.contents.emit(
      'did-start-navigation',
      { isMainFrame: true, isSameDocument: false },
      'private://never-log',
      false,
      true,
      11,
      12,
    )
    expect(emitted(log, 'HVIR_NATIVE_NAVIGATION_STAGE ').map((row) => row.stage)).toEqual(
      [
        'rollover-before',
        'rollover-returned',
        'resume-before',
        'resume-returned',
        'resume-before',
        'resume-threw',
        'reload-request',
        'did-start-navigation',
      ],
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
    stop()
    expect(Reflect.get(f.resources, 'rolloverOwner')).toBe(rollover)
    expect(Reflect.get(f.resources, 'resumeOwnerIpc')).toBe(resume)
    expect(Reflect.get(f.contents, 'reload')).toBe(reload)
    for (const key of ['rolloverOwner', 'resumeOwnerIpc'])
      expect(Object.hasOwn(f.resources, key)).toBe(false)
    expect(Object.hasOwn(f.contents, 'reload')).toBe(false)
    expect(f.contents.eventNames()).toEqual([])
  })

  it('bounds navigation records and restores exact own method descriptors', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const f = navigationFixture()
    const original = vi.fn<RendererResourceScopes['rolloverOwner']>(
      Reflect.get(f.resources, 'rolloverOwner'),
    )
    Object.defineProperty(f.resources, 'rolloverOwner', {
      value: original,
      configurable: true,
      writable: true,
      enumerable: false,
    })
    const descriptor = Object.getOwnPropertyDescriptor(f.resources, 'rolloverOwner')
    const stop = observeNativeReceiverDiagnostic(f.win, f.resources)
    const result = f.resources.rolloverOwner(f.contents.id)
    expect(original).toHaveBeenCalledExactlyOnceWith(f.contents.id)
    expect(original.mock.contexts[0]).toBe(f.resources)
    expect(result).toBe(original.mock.results[0]!.value)
    for (let index = 0; index < 2050; index++)
      f.contents.emit('did-frame-finish-load', {}, true, 11, 12)
    expect(emitted(log, 'HVIR_NATIVE_NAVIGATION_STAGE ')).toHaveLength(2048)
    expect(emitted(log, 'HVIR_NATIVE_NAVIGATION_COLLECTION ')).toEqual([
      { records: 2048, truncated: true },
    ])
    stop()
    expect(Object.getOwnPropertyDescriptor(f.resources, 'rolloverOwner')).toEqual(
      descriptor,
    )
    expect(f.contents.eventNames()).toEqual([])
  })

  it('restores partially installed navigation listeners and owner methods', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const f = navigationFixture(),
      on: typeof f.contents.on = Reflect.get(f.contents, 'on')
    vi.spyOn(f.contents, 'on').mockImplementation(function (
      this: typeof f.contents,
      name,
      listener,
    ) {
      if (name === 'did-frame-navigate') throw new Error('private setup error')
      return on.call(this, name, listener)
    })
    const stop = observeNativeReceiverDiagnostic(f.win, f.resources)
    expect(Object.hasOwn(f.resources, 'rolloverOwner')).toBe(false)
    expect(Object.hasOwn(f.resources, 'resumeOwnerIpc')).toBe(false)
    expect(Object.hasOwn(f.contents, 'reload')).toBe(false)
    expect(emitted(log, 'HVIR_NATIVE_NAVIGATION_STAGE ').at(-1)?.stage).toBe(
      'observer-unavailable',
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
    stop()
    expect(f.contents.eventNames()).toEqual([])
  })
})
