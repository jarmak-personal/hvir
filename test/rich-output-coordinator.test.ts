import { describe, expect, it, vi } from 'vitest'

import { RichOutputCoordinator } from '../src/renderer/src/terminal/rich-output-coordinator'
import {
  LOCAL_HOST_ID,
  asHarnessProviderId,
  type AssistantOutputEvent,
} from '../src/shared'

const capabilities = {
  sessionIdentity: 'discovered',
  exactResume: true,
  contextPresentation: 'pressure',
  assistantOutput: 'structured',
} as const

function event(
  kind: 'start' | 'delta' | 'end' | 'abort',
  order: number,
  extra: Record<string, unknown> = {},
): AssistantOutputEvent {
  return {
    kind,
    hostId: LOCAL_HOST_ID,
    providerId: asHarnessProviderId('codex'),
    generation: 3,
    sessionId: 'thread-1',
    turnId: 'turn-1',
    messageId: 'message-1',
    order,
    ...(kind === 'delta' ? { text: '' } : {}),
    ...(kind === 'abort' ? { reason: 'source-lost' } : {}),
    ...extra,
  } as AssistantOutputEvent
}

function fixture() {
  const setMode = vi.fn<(enabled: boolean) => Promise<boolean>>(() =>
    Promise.resolve(true),
  )
  const snapshots: ReturnType<RichOutputCoordinator['snapshot']>[] = []
  const coordinator = new RichOutputCoordinator({
    setMode,
    resolveFileLink: (target) =>
      target.startsWith('file:')
        ? { kind: 'file', target: target.slice('file:'.length) }
        : undefined,
    onChange: (snapshot) => snapshots.push(snapshot),
  })
  return { coordinator, setMode, snapshots }
}

function makeAvailable(coordinator: RichOutputCoordinator): void {
  coordinator.accept({
    kind: 'availability',
    state: 'available',
    hostId: LOCAL_HOST_ID,
    providerId: asHarnessProviderId('codex'),
    generation: 3,
  })
  coordinator.configure(capabilities, 'thread-1', 'identified')
}

describe('RichOutputCoordinator', () => {
  it('defaults off and becomes available only after capability, source, and identity', async () => {
    const { coordinator, setMode } = fixture()
    coordinator.accept({
      kind: 'availability',
      state: 'available',
      hostId: LOCAL_HOST_ID,
      providerId: asHarnessProviderId('codex'),
      generation: 3,
    })
    expect(coordinator.snapshot().control).toBe('hidden')

    coordinator.configure(capabilities, undefined, 'discovering')
    expect(coordinator.snapshot()).toMatchObject({
      control: 'waiting',
      enabled: false,
    })
    coordinator.configure(capabilities, 'thread-1', 'identified')
    expect(coordinator.snapshot().control).toBe('available')

    await expect(coordinator.setEnabled(true)).resolves.toBe(true)
    expect(setMode).toHaveBeenCalledExactlyOnceWith(true)
    expect(coordinator.snapshot().enabled).toBe(true)
  })

  it('publishes stable Markdown rows before the response ends', async () => {
    const { coordinator } = fixture()
    makeAvailable(coordinator)
    await coordinator.setEnabled(true)

    coordinator.accept(event('start', 1))
    coordinator.accept(event('delta', 2, { text: '# Heading\npartial' }))

    expect(coordinator.snapshot().messages[0]).toMatchObject({
      state: 'streaming',
      rows: [
        expect.objectContaining({
          kind: 'heading',
          prefix: '▸ ',
        }),
      ],
    })
    coordinator.accept(event('end', 3))
    expect(coordinator.snapshot().messages[0]).toMatchObject({
      state: 'ended',
      rows: [
        expect.objectContaining({ kind: 'heading' }),
        expect.objectContaining({ kind: 'paragraph' }),
      ],
    })
  })

  it('accepts the acknowledged source boundary while enable IPC is in flight', async () => {
    let acceptMode: ((accepted: boolean) => void) | undefined
    const coordinator = new RichOutputCoordinator({
      setMode: () =>
        new Promise<boolean>((resolve) => {
          acceptMode = resolve
        }),
      resolveFileLink: () => undefined,
      onChange: () => undefined,
    })
    makeAvailable(coordinator)

    const enabling = coordinator.setEnabled(true)
    coordinator.accept(event('start', 1))
    coordinator.accept(event('delta', 2, { text: 'accepted boundary\n' }))
    acceptMode?.(true)

    await expect(enabling).resolves.toBe(true)
    expect(coordinator.snapshot()).toMatchObject({
      enabled: true,
      messages: [
        {
          state: 'streaming',
          rows: [expect.objectContaining({ kind: 'paragraph' })],
        },
      ],
    })
  })

  it('preserves an already rich-owned start while reasserting the opted-out mode', () => {
    const { coordinator, setMode } = fixture()
    makeAvailable(coordinator)

    coordinator.accept(event('start', 1))
    coordinator.accept(event('delta', 2, { text: 'latched rich item\n' }))
    coordinator.accept(event('end', 3))

    expect(coordinator.snapshot()).toMatchObject({
      control: 'available',
      enabled: false,
      messages: [
        {
          state: 'ended',
          rows: [expect.objectContaining({ kind: 'paragraph' })],
        },
      ],
    })
    expect(setMode).toHaveBeenCalledExactlyOnceWith(false)
  })

  it('adopts the first complete start order after renderer rollover', async () => {
    const { coordinator } = fixture()
    makeAvailable(coordinator)
    await coordinator.setEnabled(true)

    coordinator.accept(event('start', 41))
    coordinator.accept(event('delta', 42, { text: 'new renderer body\n' }))
    coordinator.accept(event('end', 43))

    expect(coordinator.snapshot()).toMatchObject({
      control: 'available',
      enabled: true,
      messages: [
        {
          state: 'ended',
          rows: [expect.objectContaining({ kind: 'paragraph' })],
        },
      ],
    })
  })

  it('continues in order after an interrupted rich message', async () => {
    const { coordinator } = fixture()
    makeAvailable(coordinator)
    await coordinator.setEnabled(true)
    coordinator.accept(event('start', 1))
    coordinator.accept(event('abort', 2, { reason: 'turn-interrupted' }))
    coordinator.accept(
      event('start', 3, {
        turnId: 'turn-2',
        messageId: 'message-2',
      }),
    )

    expect(coordinator.snapshot()).toMatchObject({
      control: 'available',
      messages: [{ state: 'aborted' }, { id: 'message-2', state: 'streaming' }],
    })
  })

  it('keeps an in-flight rich response when the desired mode turns off', async () => {
    const { coordinator, setMode } = fixture()
    makeAvailable(coordinator)
    await coordinator.setEnabled(true)
    coordinator.accept(event('start', 1))
    coordinator.accept(event('delta', 2, { text: 'first ' }))

    await expect(coordinator.setEnabled(false)).resolves.toBe(true)
    coordinator.accept(event('delta', 3, { text: 'response\n' }))
    coordinator.accept(event('end', 4))

    expect(setMode.mock.calls.map(([enabled]) => enabled)).toEqual([true, false])
    expect(coordinator.snapshot()).toMatchObject({
      enabled: false,
      messages: [
        {
          state: 'ended',
          rows: [expect.objectContaining({ kind: 'paragraph' })],
        },
      ],
    })
  })

  it('fails closed on a gap and rejects all later content', async () => {
    const { coordinator, setMode } = fixture()
    makeAvailable(coordinator)
    await coordinator.setEnabled(true)
    coordinator.accept(event('start', 1))
    coordinator.accept(event('delta', 3, { text: 'gap' }))
    coordinator.accept(event('end', 4))

    expect(coordinator.snapshot()).toMatchObject({
      control: 'unavailable',
      enabled: false,
      messages: [
        {
          state: 'aborted',
          rows: [expect.objectContaining({ kind: 'status' })],
        },
      ],
    })
    expect(setMode).toHaveBeenLastCalledWith(false)
  })

  it('resets retained bodies and desired mode for a new source generation', async () => {
    const { coordinator } = fixture()
    makeAvailable(coordinator)
    await coordinator.setEnabled(true)
    coordinator.accept(event('start', 1))
    coordinator.accept(event('delta', 2, { text: 'body\n' }))
    coordinator.accept(event('end', 3))

    coordinator.accept({
      kind: 'availability',
      state: 'available',
      hostId: LOCAL_HOST_ID,
      providerId: asHarnessProviderId('codex'),
      generation: 4,
    })

    expect(coordinator.snapshot()).toMatchObject({
      enabled: false,
      messages: [],
    })
  })

  it('does not revive a superseded mode request after a generation reset', async () => {
    let acceptMode: ((accepted: boolean) => void) | undefined
    const coordinator = new RichOutputCoordinator({
      setMode: () =>
        new Promise<boolean>((resolve) => {
          acceptMode = resolve
        }),
      resolveFileLink: () => undefined,
      onChange: () => undefined,
    })
    makeAvailable(coordinator)
    const enabling = coordinator.setEnabled(true)

    coordinator.accept({
      kind: 'availability',
      state: 'available',
      hostId: LOCAL_HOST_ID,
      providerId: asHarnessProviderId('codex'),
      generation: 4,
    })
    acceptMode?.(true)

    await expect(enabling).resolves.toBe(false)
    expect(coordinator.snapshot()).toMatchObject({
      enabled: false,
      changing: false,
      messages: [],
    })
  })

  it('retains at most 32 completed messages', async () => {
    const { coordinator } = fixture()
    makeAvailable(coordinator)
    await coordinator.setEnabled(true)
    let order = 0
    for (let index = 0; index < 33; index++) {
      coordinator.accept(
        event('start', ++order, {
          turnId: `turn-${index}`,
          messageId: `message-${index}`,
        }),
      )
      coordinator.accept(
        event('end', ++order, {
          turnId: `turn-${index}`,
          messageId: `message-${index}`,
        }),
      )
    }

    expect(coordinator.snapshot().messages).toHaveLength(32)
    expect(coordinator.snapshot().messages[0]?.id).toBe('message-1')
  })

  it('omits the control for unsupported sessions and drops provider content', () => {
    const { coordinator } = fixture()
    coordinator.configure(
      {
        sessionIdentity: 'none',
        exactResume: false,
        contextPresentation: 'none',
      },
      undefined,
      'none',
    )
    coordinator.accept(event('start', 1))

    expect(coordinator.snapshot()).toMatchObject({
      control: 'hidden',
      enabled: false,
      messages: [],
    })
  })
})
