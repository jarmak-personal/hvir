import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExtensionConnectorResult } from '../src/shared/extensions/connectors'
import { connectorFixture } from './fixtures/extension-connector'
import { guestClientFixture, type PackageClient } from './fixtures/extension-guest-client'

const bundle = buildSync({
  entryPoints: ['src/shared/extensions/connector-output.mjs'],
  bundle: true,
  format: 'iife',
  globalName: 'Reader',
  write: false,
})
const sandbox = { TextEncoder, Reader: undefined as unknown }
runInNewContext(bundle.outputFiles[0]!.text, sandbox)
const { readConnectorOutput: read } = sandbox.Reader as {
  readConnectorOutput(
    this: void,
    client: Pick<PackageClient, 'request'>,
    result: ExtensionConnectorResult,
    options?: { stream?: string; maxBytes?: number; signal?: AbortSignal },
  ): Promise<string>
}
afterEach(() => vi.useRealTimers())

it.each([false, true])(
  'drains four maximum worst-escaped split receipts through the shared fair scheduler with clamped timers %s',
  async (clamped) => {
    vi.useFakeTimers()
    const owner = connectorFixture(),
      controls: number[] = [],
      pages: string[] = []
    await owner.approve()
    const stdout = '\u0001'.repeat(2 * 1024 * 1024 - 1),
      stderr = '\u0002'.repeat(2 * 1024 * 1024 + 1)
    owner.host.exec.mockResolvedValue({ code: 0, signal: null, stdout, stderr })
    let held = 0,
      highWater = 0
    const f = guestClientFixture(clamped, (message) => {
      if (message.kind !== 'request') return
      held++
      highWater = Math.max(highWater, held)
      void Promise.resolve().then(async () => {
        const caller = {
          ...owner.caller,
          ...(typeof message.actionId === 'string' ? { action: message.actionId } : {}),
        }
        const value =
          message.capability === 'connector.execute'
            ? await owner.execution.execute(caller, {
                ...owner.input,
                args: [String(message.id)],
              })
            : message.capability === 'connector.output'
              ? owner.execution.output(caller, message.input)
              : null
        if (
          message.capability === 'connector.output' &&
          !(message.input as { release?: boolean }).release
        )
          pages.push(String((message.input as { receipt: string }).receipt))
        else controls.push(pages.length)
        held--
        f.receive({ kind: 'result', id: message.id, ok: true, value })
      })
    })
    f.receive({ kind: 'action', invocation: { id: 'main-action' } })
    const action = f.client.forAction({ id: 'main-action' })
    f.client.hello()
    const jobs = Array.from({ length: 4 }, async () => {
      const result = (await action.request(
        'connector.execute',
      )) as ExtensionConnectorResult
      try {
        expect(await read(action, result)).toBe(stdout)
        expect(await read(action, result, { stream: 'stderr' })).toBe(stderr)
      } finally {
        await action.request('connector.output', {
          receipt: result.receipt,
          release: true,
        })
      }
    })
    // An ordinary request competes continuously with the four drains.
    f.receive({ kind: 'context', context: { visible: true } })
    const ordinary = (async () => {
      for (let n = 0; n < 40; n++) await f.client.request('presentation.read')
    })()
    try {
      await vi.advanceTimersByTimeAsync(15_000)
      await Promise.all([...jobs, ordinary])
      expect(pages.length).toBeLessThanOrEqual(264)
      expect(new Set(pages.slice(0, 4)).size).toBe(4)
      expect(highWater).toBeLessThanOrEqual(8)
      expect(controls.some((count) => count > 0 && count < pages.length)).toBe(true)
      // Every admitted reader gets a FIFO turn before another reader's second page.
      for (let n = 0; n < 120; n += 4) expect(new Set(pages.slice(n, n + 4)).size).toBe(4)
      for (const time of f.times)
        expect(
          f.times.filter((value) => value >= time && value < time + 1000).length,
        ).toBeLessThanOrEqual(24)
      expect(Math.max(...f.times)).toBeLessThanOrEqual(15_000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.client.dispose()
      owner.dispose()
    }
  },
)

it('reads a real owner 650 KiB receipt, empty stderr and releases within one cooperative burst', async () => {
  vi.useFakeTimers()
  const owner = connectorFixture()
  await owner.approve()
  const stdout = 'x'.repeat(650 * 1024)
  owner.host.exec.mockResolvedValue({ code: 0, signal: null, stdout, stderr: '' })
  const f = guestClientFixture(false, (message) => {
    if (message.kind !== 'request') return
    void Promise.resolve().then(async () => {
      const value =
        message.capability === 'connector.execute'
          ? await owner.execution.execute(owner.caller, owner.input)
          : owner.execution.output(owner.caller, message.input)
      f.receive({ kind: 'result', id: message.id, ok: true, value })
    })
  })
  f.receive({ kind: 'context', context: { visible: true } })
  try {
    f.client.hello()
    const result = (await f.client.request(
      'connector.execute',
    )) as ExtensionConnectorResult
    expect(await read(f.client, result)).toBe(stdout)
    expect(await read(f.client, result, { stream: 'stderr' })).toBe('')
    await f.client.request('connector.output', { receipt: result.receipt, release: true })
    expect(f.sent).toHaveLength(10)
    expect(new Set(f.times).size).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    f.client.dispose()
    owner.dispose()
  }
})
const result: ExtensionConnectorResult = {
  receipt: 'owned',
  outcome: 'completed',
  host: 'local',
  code: 0,
  signal: null,
  truncated: false,
  stdoutBytes: 5,
  stderrBytes: 0,
}
it.each([
  { data: '😀x', nextOffset: 2, result },
  { data: '😀', nextOffset: null, result },
  { data: '', nextOffset: 0, result },
  { data: '😀x', nextOffset: NaN, result },
  { data: '😀xx', nextOffset: null, result },
  { data: '😀x', nextOffset: null, result: { ...result, receipt: 'sibling' } },
  { data: '😀x', nextOffset: null, result: { ...result, truncated: true } },
])('refuses malformed, incomplete and mismatched page metadata %#', async (page) => {
  await expect(read({ request: () => Promise.resolve(page) }, result)).rejects.toThrow()
})
it('validates exact byte offsets, smaller caller bounds and aborted late completion without release or replay', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({ data: '😀', nextOffset: 4, result })
    .mockResolvedValueOnce({ data: 'x', nextOffset: null, result })
  expect(await read({ request }, result, { maxBytes: 5 })).toBe('😀x')
  expect(request).toHaveBeenLastCalledWith(
    'connector.output',
    { receipt: 'owned', stream: 'stdout', offset: 4 },
    undefined,
  )
  await expect(read({ request }, result, { maxBytes: 4 })).rejects.toThrow(
    'supported bound',
  )
  expect(request).toHaveBeenCalledTimes(2)
  const controller = new AbortController()
  const late = vi.fn(() => {
    controller.abort()
    return Promise.resolve({ data: '😀x', nextOffset: null, result })
  })
  await expect(
    read({ request: late }, result, { signal: controller.signal }),
  ).rejects.toThrow()
  expect(late).toHaveBeenCalledOnce()
})
