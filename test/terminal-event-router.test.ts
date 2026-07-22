import { describe, expect, it, vi, type Mock } from 'vitest'

import {
  TerminalEventRouter,
  type TerminalEventHandlers,
  type TerminalEventScheduler,
} from '../src/renderer/src/terminal/terminal-event-router'
import type {
  HvirApi,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  IpcSendChannel,
  IpcSendPayload,
} from '../src/shared'

describe('TerminalEventRouter', () => {
  it('keeps one native subscription per event family and routes only by session id', () => {
    const api = new FakeHvirApi()
    const scheduler = new ManualScheduler()
    const router = new TerminalEventRouter(api, { scheduler })
    const routes = Array.from({ length: 12 }, (_, index) => {
      const handlers = handlersFixture()
      const route = router.register(`terminal-${index}`, 'visible', handlers)
      return { handlers, route }
    })

    expect(api.subscriptionCounts()).toEqual({
      'pty:data': 1,
      'pty:exit': 1,
      'pty:telemetry': 1,
      'pty:identity': 1,
    })
    expect(router.snapshot()).toMatchObject({
      nativeSubscriptions: 4,
      registeredSessions: 12,
    })

    api.emit('pty:data', { id: 'terminal-7', data: 'left-' })
    api.emit('pty:data', { id: 'terminal-7', data: 'right' })
    expect(routes.every(({ handlers }) => handlers.onData.mock.calls.length === 0)).toBe(
      true,
    )
    scheduler.flushFrames()

    expect(routes[7]!.handlers.onData).toHaveBeenCalledExactlyOnceWith('left-right')
    expect(
      routes.filter(({ handlers }) => handlers.onData.mock.calls.length > 0),
    ).toHaveLength(1)
    expect(routes[7]!.route.snapshot()).toMatchObject({
      nativeDataEvents: 2,
      deliveryCallbacks: 1,
      bufferedBytes: 0,
      pending: false,
    })

    routes[7]!.route.dispose()
    api.emit('pty:data', { id: 'terminal-7', data: 'late' })
    api.emit('pty:data', { id: 'terminal-8', data: 'live' })
    scheduler.flushFrames()
    expect(routes[7]!.handlers.onData).toHaveBeenCalledTimes(1)
    expect(routes[8]!.handlers.onData).toHaveBeenCalledExactlyOnceWith('live')
    expect(router.snapshot()).toMatchObject({
      registeredSessions: 11,
      nativeDataEvents: 4,
      unroutedEvents: 1,
    })

    router.dispose()
    expect(api.activeSubscriptionCount()).toBe(0)
  })

  it('preserves split Unicode, ANSI, and synchronized-output bytes exactly', () => {
    const api = new FakeHvirApi()
    const scheduler = new ManualScheduler()
    const handlers = handlersFixture()
    const router = new TerminalEventRouter(api, { scheduler })
    router.register('terminal-1', 'visible', handlers)
    const chunks = [
      '\ud83d',
      '\ude80',
      '\u001b[',
      '31mred\u001b[0',
      'm\u001b[?20',
      '26hsync-frame\u001b[?2026',
      'l',
    ]

    for (const data of chunks) api.emit('pty:data', { id: 'terminal-1', data })
    scheduler.flushFrames()

    expect(handlers.onData).toHaveBeenCalledExactlyOnceWith(chunks.join(''))
    router.dispose()
  })

  it('flushes output before exit and rejects every later event for that session', () => {
    const api = new FakeHvirApi()
    const scheduler = new ManualScheduler()
    const order: string[] = []
    const handlers = handlersFixture({
      onData: (data) => order.push(`data:${data}`),
      onExit: (exitCode, signal) => order.push(`exit:${exitCode}:${signal}`),
    })
    const router = new TerminalEventRouter(api, { scheduler })
    router.register('terminal-1', 'visible', handlers)

    api.emit('pty:data', { id: 'terminal-1', data: 'final-output' })
    api.emit('pty:exit', { id: 'terminal-1', exitCode: 7, signal: 15 })
    api.emit('pty:data', { id: 'terminal-1', data: 'late-output' })
    api.emit('pty:telemetry', { id: 'terminal-1', telemetry: undefined })
    api.emit('pty:identity', {
      id: 'terminal-1',
      harnessSessionId: 'late-identity',
      identityStatus: 'identified',
    })

    expect(order).toEqual(['data:final-output', 'exit:7:15'])
    expect(handlers.onTelemetry).not.toHaveBeenCalled()
    expect(handlers.onIdentity).not.toHaveBeenCalled()
    expect(router.snapshot()).toMatchObject({
      registeredSessions: 0,
      unroutedEvents: 3,
    })
    scheduler.flushFrames()
    expect(order).toHaveLength(2)
    router.dispose()
  })

  it('flushes hidden output by 40 ms and reschedules across visibility changes', () => {
    const api = new FakeHvirApi()
    const scheduler = new ManualScheduler()
    const handlers = handlersFixture()
    const router = new TerminalEventRouter(api, { scheduler, hiddenFlushMs: 40 })
    const route = router.register('terminal-1', 'hidden', handlers)

    api.emit('pty:data', { id: 'terminal-1', data: 'hidden-' })
    api.emit('pty:data', { id: 'terminal-1', data: 'batch' })
    scheduler.advance(39)
    expect(handlers.onData).not.toHaveBeenCalled()
    scheduler.advance(1)
    expect(handlers.onData).toHaveBeenCalledExactlyOnceWith('hidden-batch')

    api.emit('pty:data', { id: 'terminal-1', data: 'reveal' })
    route.setPresentation('visible')
    scheduler.advance(40)
    expect(handlers.onData).toHaveBeenCalledTimes(1)
    scheduler.flushFrames()
    expect(handlers.onData).toHaveBeenLastCalledWith('reveal')

    api.emit('pty:data', { id: 'terminal-1', data: 'hide-again' })
    route.setPresentation('hidden')
    scheduler.flushFrames()
    expect(handlers.onData).toHaveBeenCalledTimes(2)
    scheduler.advance(40)
    expect(handlers.onData).toHaveBeenLastCalledWith('hide-again')
    expect(route.snapshot()).toMatchObject({
      deliveryCallbacks: 3,
      presentation: 'hidden',
      pending: false,
    })
    router.dispose()
  })

  it('bounds buffered bytes, early-flushes large bursts, and drops pending disposal', () => {
    const api = new FakeHvirApi()
    const scheduler = new ManualScheduler()
    const first = handlersFixture()
    const second = handlersFixture()
    const router = new TerminalEventRouter(api, {
      scheduler,
      maxBufferedBytes: 8,
      byteLength: (data) => data.length,
    })
    const firstRoute = router.register('terminal-1', 'hidden', first)
    router.register('terminal-2', 'hidden', second)

    api.emit('pty:data', { id: 'terminal-1', data: '1234' })
    api.emit('pty:data', { id: 'terminal-1', data: '5678' })
    api.emit('pty:data', { id: 'terminal-1', data: 'abcdefghijkl' })
    expect(first.onData.mock.calls.map(([data]) => data)).toEqual([
      '12345678',
      'abcdefghijkl',
    ])
    expect(firstRoute.snapshot()).toMatchObject({
      peakBufferedBytes: 8,
      bufferedBytes: 0,
      receivedBytes: 20,
      deliveredBytes: 20,
      deliveryCallbacks: 2,
    })

    api.emit('pty:data', { id: 'terminal-1', data: 'drop-me' })
    api.emit('pty:data', { id: 'terminal-2', data: 'keep-me' })
    firstRoute.dispose()
    scheduler.advance(40)
    expect(first.onData).toHaveBeenCalledTimes(2)
    expect(second.onData).toHaveBeenCalledExactlyOnceWith('keep-me')
    router.dispose()
  })

  it('rejects delivery policies that exceed the issue bounds', () => {
    const api = new FakeHvirApi()
    const scheduler = new ManualScheduler()

    expect(() => new TerminalEventRouter(api, { scheduler, hiddenFlushMs: 51 })).toThrow(
      'must not exceed 50 ms',
    )
    expect(
      () => new TerminalEventRouter(api, { scheduler, maxBufferedBytes: 0 }),
    ).toThrow('must be positive')
  })
})

function handlersFixture(
  overrides: Partial<TerminalEventHandlers> = {},
): MockTerminalEventHandlers {
  return {
    onData: vi.fn(overrides.onData ?? (() => undefined)),
    onExit: vi.fn(overrides.onExit ?? (() => undefined)),
    onTelemetry: vi.fn(overrides.onTelemetry ?? (() => undefined)),
    onIdentity: vi.fn(overrides.onIdentity ?? (() => undefined)),
  }
}

interface MockTerminalEventHandlers extends TerminalEventHandlers {
  readonly onData: Mock<(data: string) => void>
  readonly onExit: Mock<(exitCode: number, signal?: number) => void>
  readonly onTelemetry: Mock<TerminalEventHandlers['onTelemetry']>
  readonly onIdentity: Mock<TerminalEventHandlers['onIdentity']>
}

class FakeHvirApi implements HvirApi {
  private readonly callbacks = new Map<IpcEventChannel, Set<(payload: unknown) => void>>()
  private readonly subscriptions = new Map<IpcEventChannel, number>()

  invoke<C extends IpcInvokeChannel>(
    _channel: C,
    _request: IpcRequest<C>,
  ): Promise<IpcResponse<C>> {
    return Promise.reject(new Error('invoke is not used by terminal event router tests'))
  }

  send<C extends IpcSendChannel>(_channel: C, _payload: IpcSendPayload<C>): void {}

  on<E extends IpcEventChannel>(
    channel: E,
    callback: (payload: IpcEventPayload<E>) => void,
  ): () => void {
    const callbacks = this.callbacks.get(channel) ?? new Set()
    callbacks.add(callback as (payload: unknown) => void)
    this.callbacks.set(channel, callbacks)
    this.subscriptions.set(channel, (this.subscriptions.get(channel) ?? 0) + 1)
    return () => callbacks.delete(callback as (payload: unknown) => void)
  }

  emit<E extends IpcEventChannel>(channel: E, payload: IpcEventPayload<E>): void {
    for (const callback of this.callbacks.get(channel) ?? []) callback(payload)
  }

  subscriptionCounts(): Partial<Record<IpcEventChannel, number>> {
    return Object.fromEntries(this.subscriptions)
  }

  activeSubscriptionCount(): number {
    return [...this.callbacks.values()].reduce((total, value) => total + value.size, 0)
  }
}

class ManualScheduler implements TerminalEventScheduler {
  private nextHandle = 1
  private now = 0
  private readonly frames = new Map<number, (time: number) => void>()
  private readonly timers = new Map<
    number,
    { readonly deadline: number; readonly callback: () => void }
  >()

  requestFrame(callback: (time: number) => void): number {
    const handle = this.nextHandle++
    this.frames.set(handle, callback)
    return handle
  }

  cancelFrame(handle: number): void {
    this.frames.delete(handle)
  }

  setTimer(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++
    this.timers.set(handle, { deadline: this.now + delayMs, callback })
    return handle
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle)
  }

  flushFrames(): void {
    const frames = [...this.frames.entries()]
    this.frames.clear()
    for (const [, callback] of frames) callback(this.now)
  }

  advance(durationMs: number): void {
    this.now += durationMs
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.deadline <= this.now)
      .sort((left, right) => left[1].deadline - right[1].deadline)
    for (const [handle, timer] of due) {
      this.timers.delete(handle)
      timer.callback()
    }
  }
}
