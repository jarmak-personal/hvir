import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.useRealTimers())
it.each(['packages/extension-reference', 'test/fixtures/extensions/0.3.0/reference'])(
  'refreshes by visible demand without publication feedback: %s',
  async (directory) => {
    vi.useFakeTimers()
    const listeners = new Set<(message: unknown) => void>()
    const messages: { capability?: string; input?: unknown }[] = []
    const emit = (message: unknown) => {
      for (const listener of listeners) listener(message)
    }
    const bridge = {
      onMessage: (listener: (message: unknown) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      send: (message: {
        kind: string
        id?: string
        capability?: string
        input?: unknown
      }) => {
        messages.push(message)
        if (message.kind !== 'request') return
        const value =
          message.capability === 'connector.status'
            ? [{ connector: 'installed-tool', availability: 'supported' }]
            : message.capability === 'connector.execute'
              ? { outcome: 'completed', code: 0, receipt: 'output' }
              : null
        void Promise.resolve().then(() =>
          emit({ kind: 'result', id: message.id, ok: true, value }),
        )
        if (message.capability === 'contributions.publish')
          void Promise.resolve().then(() =>
            emit({ kind: 'context', context: { visible: true, sessions: [] } }),
          )
      },
    }
    runInNewContext(readFileSync(`${directory}/updater.js`, 'utf8'), {
      window: { hvirExtension: bridge, setInterval },
      Date,
    })
    emit({ kind: 'context', context: { visible: true, sessions: [] } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(
      messages.filter((message) => message.capability === 'connector.execute'),
    ).toHaveLength(1)
    for (let index = 0; index < 100; index++)
      emit({ kind: 'context', context: { visible: true, sessions: [] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(
      messages.filter((message) => message.capability === 'connector.execute'),
    ).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(
      messages.filter((message) => message.capability === 'connector.execute'),
    ).toHaveLength(2)
    emit({ kind: 'context', context: { visible: false, sessions: [] } })
    await vi.advanceTimersByTimeAsync(4000)
    expect(
      messages.filter((message) => message.capability === 'connector.execute'),
    ).toHaveLength(2)
    emit({ kind: 'context', context: { visible: true, sessions: [] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(
      messages.filter((message) => message.capability === 'connector.execute'),
    ).toHaveLength(3)
  },
)
