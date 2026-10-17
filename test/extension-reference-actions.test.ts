import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  ExtensionInvocation,
  ExtensionReply,
  ExtensionRequest,
} from '../src/shared/extensions/contract'

afterEach(() => vi.useRealTimers())

function reference() {
  const listeners = new Set<(message: ExtensionReply) => void>()
  const events = new Map<string, () => void>()
  const status = { textContent: '' }
  const send = vi.fn<(message: ExtensionRequest) => void>()
  const unbind = vi.fn()
  runInNewContext(readFileSync('packages/extension-reference/reference.js', 'utf8'), {
    window: {
      hvirExtension: {
        send,
        onMessage: (listener: (message: ExtensionReply) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
      hvirUI: { bindPresentation: () => unbind },
      setTimeout,
      clearTimeout,
      addEventListener: (name: string, listener: () => void) =>
        events.set(name, listener),
      removeEventListener: (name: string) => events.delete(name),
    },
    document: { getElementById: (id: string) => (id === 'status' ? status : null) },
  })
  const emit = (message: ExtensionReply) => {
    for (const listener of listeners) listener(message)
  }
  return {
    emit,
    invoke: (id: string, delayMs = 500, action = 'describe-session') => {
      const invocation: ExtensionInvocation = {
        id,
        action,
        input: { delayMs },
        context: { surface: 'viewer', visible: true },
        caller: 'agent',
        authorization: 'standing',
      }
      emit({ kind: 'action', invocation })
    },
    results: () =>
      send.mock.calls
        .map(([message]) => message)
        .filter((message) => message.kind === 'action-result'),
    close: () => events.get('pagehide')?.(),
    listeners,
    events,
    status,
    unbind,
  }
}

it('cancels only the named action and cannot overwrite a completed sibling with a late result', async () => {
  vi.useFakeTimers()
  const guest = reference()
  try {
    guest.invoke('cancelled', 5000)
    guest.invoke('sibling')
    guest.emit({ kind: 'action-cancelled', id: 'cancelled' })
    guest.emit({ kind: 'action-cancelled', id: 'unknown' })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(guest.results()).toEqual([
      { kind: 'action-result', id: 'sibling', value: { session: null, caller: 'agent' } },
    ])
    expect(guest.status.textContent).toBe('Action completed · sibling')
    guest.emit({ kind: 'action-cancelled', id: 'cancelled' })
    await vi.advanceTimersByTimeAsync(5000)
    expect(guest.results()).toHaveLength(1)
    expect(guest.status.textContent).toBe('Action completed · sibling')
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    guest.close()
  }
})

it.each(['describe-session', 'preview-replacement'])(
  'preserves successful %s completion through the public bridge',
  async (action) => {
    vi.useFakeTimers()
    const guest = reference()
    try {
      guest.invoke('successful', 500, action)
      await vi.advanceTimersByTimeAsync(500)
      expect(guest.results()).toEqual([
        {
          kind: 'action-result',
          id: 'successful',
          value: {
            session: null,
            caller: 'agent',
            ...(action === 'preview-replacement'
              ? { previewOnly: true, changedFiles: 0 }
              : {}),
          },
        },
      ])
      expect(guest.status.textContent).toBe('Action completed · successful')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      guest.close()
    }
  },
)

it.each(['revoked', 'pagehide'] as const)(
  'disposes all pending actions on %s without later completion or renewed work',
  async (event) => {
    vi.useFakeTimers()
    const guest = reference()
    try {
      guest.invoke('first')
      guest.invoke('second', 5000)
      const late = [...guest.listeners]
      if (event === 'revoked') guest.emit({ kind: 'revoked' })
      else guest.close()
      const stopped = guest.status.textContent
      guest.close()
      for (const callback of late) callback({ kind: 'action-cancelled', id: 'first' })
      guest.invoke('after-disposal')
      await vi.advanceTimersByTimeAsync(5000)
      expect(guest.results()).toEqual([])
      expect(guest.status.textContent).toBe(stopped)
      expect(vi.getTimerCount()).toBe(0)
      expect(guest.listeners.size).toBe(0)
      expect(guest.events.size).toBe(0)
      expect(guest.unbind).toHaveBeenCalledOnce()
    } finally {
      guest.close()
    }
  },
)
