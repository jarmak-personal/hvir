import { connectorOutputFixture } from './fixtures/connector-output'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'

interface ManagementIo {
  run(
    args: string[],
    operation?: object,
    retryReadFrequency?: boolean,
    validateCompletion?: (value: unknown, code: number, diagnostic: string) => void,
    captureOutput?: (value: unknown, receipt: string) => unknown,
  ): Promise<unknown>
  verified(): void
  readonly pending?: object
}
interface BridgeClient {
  dispose(): void
  forAction(invocation: { id: string }): BridgeClient
}
function realGuestFixture() {
  const bundle = buildSync({
    stdin: {
      contents:
        "export {guestClient} from './packages/skillager-extension/src/bridge.mjs'; export {managementCli} from './packages/skillager-extension/src/management-cli.mjs'",
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { AbortController, TextEncoder, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const module = sandbox.Module as {
    guestClient(bridge: unknown, clock: unknown): BridgeClient
    managementCli(client: BridgeClient): ManagementIo
  }
  const sent: Array<Record<string, unknown>> = []
  let receive!: (message: unknown) => void
  const client = module.guestClient(
    {
      onMessage(callback: typeof receive) {
        receive = callback
        return () => undefined
      },
      send(message: Record<string, unknown>) {
        sent.push(message)
      },
    },
    { performance, setTimeout, clearTimeout },
  )
  return { client, module, sent, receive: (message: unknown) => receive(message) }
}
afterEach(() => vi.useRealTimers())

it.each(['hidden', 'revoked'])(
  'aborts the actual ordinary bridge observation deferral on %s without another native request',
  async (kind) => {
    vi.useFakeTimers()
    const f = realGuestFixture()
    try {
      f.receive({ kind: 'context', context: { visible: true } })
      const read = f.module.managementCli(f.client).run(['library', 'status', '--json'])
      const rejected = expect(read).rejects.toThrow(/hidden|closed/)
      await vi.advanceTimersByTimeAsync(0)
      f.receive({
        kind: 'result',
        id: f.sent[0]!.id,
        ok: true,
        value: { outcome: 'not-started', reason: 'frequency', retryAfterMs: 250 },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      f.receive(
        kind === 'hidden'
          ? { kind: 'context', context: { visible: false } }
          : { kind: 'revoked' },
      )
      await rejected
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(2000)
      expect(f.sent).toHaveLength(1)
    } finally {
      f.client.dispose()
    }
  },
)

it('does not defer an action-scoped observation through the ordinary guest delay', async () => {
  vi.useFakeTimers()
  const f = realGuestFixture()
  try {
    f.receive({ kind: 'action', invocation: { id: 'main-issued' } })
    const action = f.client.forAction({ id: 'main-issued' })
    const read = f.module.managementCli(action).run(['library', 'status', '--json'])
    const rejected = expect(read).rejects.toThrow(/did not start/)
    await vi.advanceTimersByTimeAsync(0)
    f.receive({
      kind: 'result',
      id: f.sent[0]!.id,
      ok: true,
      value: { outcome: 'not-started', reason: 'frequency', retryAfterMs: 250 },
    })
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]).toMatchObject({
      capability: 'connector.execute',
      actionId: 'main-issued',
    })
    action.dispose()
  } finally {
    f.client.dispose()
  }
})
function fixture() {
  const bundled = buildSync({
    entryPoints: ['packages/skillager-extension/src/management-cli.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const context = { TextEncoder, Module: undefined as unknown }
  runInNewContext(bundled.outputFiles[0]!.text, context)
  const module = context.Module as {
    managementCli(client: unknown, context?: unknown): ManagementIo
  }
  let execution: unknown = {
    outcome: 'completed',
    code: 0,
    receipt: 'owned-receipt',
    truncated: false,
  }
  let stdout = '{"schema":"fixture"}',
    stderr = ''
  const native = connectorOutputFixture()
  const calls: Array<{ capability: string; input: Record<string, unknown> }> = []
  const client = {
    alive: true,
    visible: true,
    delay: undefined as undefined | ((milliseconds: number) => Promise<void>),
    request(capability: string, input: Record<string, unknown>): Promise<unknown> {
      calls.push({ capability, input })
      if (capability === 'connector.execute')
        return Promise.resolve(native.complete(execution as object, stdout, stderr))
      return Promise.resolve(native.read(input))
    },
  }
  const io = module.managementCli(client)
  return {
    io,
    calls,
    client,
    independent: () => module.managementCli(client),
    execution: (value: unknown) => {
      execution = value
    },
    stdout: (value: string) => {
      stdout = value
    },
    stderr: (value: string) => {
      stderr = value
    },
  }
}
it.each([undefined, 0, -1, 1.5, 1001, Infinity, NaN, '250'])(
  'refuses a missing or invalid observation delay %s without a fallback',
  async (retryAfterMs) => {
    const f = fixture()
    f.execution({
      outcome: 'not-started',
      reason: 'frequency',
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    })
    f.client.delay = vi.fn(() => Promise.resolve())
    await expect(f.io.run(['library', 'status', '--json'])).rejects.toThrow(
      /did not start/,
    )
    expect(f.calls).toHaveLength(1)
    expect(f.client.delay).not.toHaveBeenCalled()
  },
)
it.each([1, 250, 1000])(
  'defers a never-started human observation by %i ms once without replaying a mutation',
  async (retryAfterMs) => {
    const f = fixture(),
      waits: number[] = []
    f.execution({ outcome: 'not-started', reason: 'frequency', retryAfterMs })
    f.client.delay = (milliseconds) => {
      waits.push(milliseconds)
      f.execution({ outcome: 'completed', code: 0, receipt: 'fresh', truncated: false })
      f.stdout('{"schema":"fresh-observation"}')
      return Promise.resolve()
    }
    await expect(
      f.io.run(['library', 'accept', 'lib/exact', '--review-manifest', '--json']),
    ).resolves.toEqual({ schema: 'fresh-observation' })
    expect(waits).toEqual([retryAfterMs])
    expect(
      f.calls.filter((call) => call.capability === 'connector.execute'),
    ).toHaveLength(2)
    expect(f.io.pending).toBeUndefined()
    f.execution({ outcome: 'not-started', reason: 'frequency', retryAfterMs })
    await expect(
      f.io.run(['library', 'init'], { action: 'initialize-library' }),
    ).rejects.toThrow(/did not start/)
    expect(waits).toEqual([retryAfterMs])
    expect(f.io.pending).toBeUndefined()
  },
)

it('keeps public completion interpretation and receipt capture after an admitted observation deferral', async () => {
  const f = fixture(),
    validate = vi.fn(),
    capture = vi.fn((value: unknown, receipt: string) => ({ value, receipt }))
  f.execution({ outcome: 'not-started', reason: 'frequency', retryAfterMs: 250 })
  f.client.delay = () => {
    f.execution({ outcome: 'completed', code: 2, receipt: 'fresh', truncated: false })
    f.stdout('{"status":"unavailable"}')
    f.stderr('Current observation unavailable.')
    return Promise.resolve()
  }
  await expect(
    f.io.run(
      ['expose', '--observe-native', '/owned/SKILL.md'],
      undefined,
      true,
      validate,
      capture,
    ),
  ).resolves.toEqual({ value: { status: 'unavailable' }, receipt: 'fresh' })
  expect(validate).toHaveBeenCalledExactlyOnceWith(
    { status: 'unavailable' },
    2,
    'Current observation unavailable.',
  )
  expect(capture).toHaveBeenCalledExactlyOnceWith({ status: 'unavailable' }, 'fresh')
  expect(f.calls.at(-1)).toEqual({
    capability: 'connector.output',
    input: { receipt: 'fresh', release: true },
  })
})
it('does not loop on a second observation refusal or dispatch after the deferred observation loses its lifetime', async () => {
  const refused = fixture(),
    waits: number[] = []
  refused.execution({ outcome: 'not-started', reason: 'frequency', retryAfterMs: 250 })
  refused.client.delay = (milliseconds) => {
    waits.push(milliseconds)
    return Promise.resolve()
  }
  await expect(refused.io.run(['library', 'status', '--json'])).rejects.toThrow(
    /did not start/,
  )
  expect(waits).toEqual([250])
  expect(refused.calls).toHaveLength(2)
  const revoked = fixture()
  revoked.execution({ outcome: 'not-started', reason: 'frequency', retryAfterMs: 250 })
  revoked.client.delay = () => {
    revoked.client.alive = false
    return Promise.resolve()
  }
  await expect(revoked.io.run(['library', 'status', '--json'])).rejects.toThrow(
    /no longer admitted/,
  )
  expect(revoked.calls).toHaveLength(1)
  const hidden = fixture()
  hidden.execution({ outcome: 'not-started', reason: 'frequency', retryAfterMs: 250 })
  hidden.client.delay = () => {
    hidden.client.visible = false
    return Promise.resolve()
  }
  await expect(hidden.io.run(['library', 'status', '--json'])).rejects.toThrow(/hidden/)
  expect(hidden.calls).toHaveLength(1)
})
it('does not retry frequency refusal; confirmed not-started permits only an explicit new attempt', async () => {
  const f = fixture()
  f.execution({ outcome: 'not-started', reason: 'frequency', retryAfterMs: 250 })
  await expect(
    f.io.run(['library', 'init'], { action: 'initialize-library' }),
  ).rejects.toThrow(/did not start/)
  expect(f.io.pending).toBeUndefined()
  expect(f.calls.filter((call) => call.capability === 'connector.execute')).toHaveLength(
    1,
  )
  f.execution({ outcome: 'completed', code: 0, receipt: 'new', truncated: false })
  await expect(
    f.io.run(['library', 'init'], { action: 'initialize-library' }),
  ).resolves.toMatchObject({ schema: 'fixture' })
  expect(f.io.pending).toMatchObject({ action: 'initialize-library', state: 'uncertain' })
  f.io.verified()
  expect(f.io.pending).toBeUndefined()
})
it.each([
  { outcome: 'interrupted', reason: 'cancelled', receipt: 'partial' },
  { outcome: 'completed', code: 0, receipt: 'partial', truncated: true },
  { outcome: 'completed', code: 2, receipt: 'refused', truncated: false },
])(
  'retains exact submitted uncertainty for $outcome and permits independent read/operation without clearing it',
  async (execution) => {
    const f = fixture()
    f.execution(execution)
    await expect(
      f.io.run(['expose', '--remove', 'copy'], {
        action: 'remove-copy',
        target: { hostId: 'local', path: '/project/copy' },
      }),
    ).rejects.toThrow()
    const original = f.io.pending
    expect(original).toMatchObject({
      action: 'remove-copy',
      target: { hostId: 'local', path: '/project/copy' },
    })
    await expect(f.io.run(['expose'], { action: 'remove-copy' })).rejects.toThrow(
      /Reconcile/,
    )
    f.execution({ outcome: 'not-started', reason: 'frequency', retryAfterMs: 250 })
    await expect(f.io.run(['expose', '--list'])).rejects.toThrow(/did not start/)
    expect(f.io.pending).toBe(original)
    f.execution({ outcome: 'completed', code: 0, receipt: 'observed', truncated: false })
    await expect(f.io.run(['expose', '--list'])).resolves.toMatchObject({
      schema: 'fixture',
    })
    expect(f.io.pending).toBe(original)
    const other = f.independent()
    await expect(
      other.run(['library', 'sync'], { action: 'sync-library' }),
    ).resolves.toMatchObject({ schema: 'fixture' })
    other.verified()
    expect(f.io.pending).toBe(original)
    expect(f.calls.filter((call) => call.input['release'])).toHaveLength(3)
  },
)
it.each(['oversized', 'stdout failure', 'stderr failure'])(
  'guides submitted operation reconciliation on %s, retaining its descriptor and releasing once',
  async (failure) => {
    const f = fixture()
    if (failure === 'oversized') f.stdout('é'.repeat(140000))
    else {
      const request = f.client.request.bind(f.client)
      f.client.request = (capability, input) => {
        if (input['stream'] === failure.split(' ')[0]) {
          f.calls.push({ capability, input })
          return Promise.reject(new Error('Receipt no longer available'))
        }
        return request(capability, input)
      }
    }
    await expect(
      f.io.run(['library', 'init'], { action: 'initialize-library' }),
    ).rejects.toThrow('use the public Skillager CLI and reconcile explicitly')
    expect(f.io.pending).toMatchObject({
      action: 'initialize-library',
      state: 'uncertain',
    })
    expect(
      f.calls.filter((call) => call.capability === 'connector.execute'),
    ).toHaveLength(1)
    expect(f.calls.filter((call) => call.input['release'])).toHaveLength(1)
  },
)
it('keeps a read-only bound refusal truthful without creating a submitted operation', async () => {
  const f = fixture()
  f.stdout('é'.repeat(140000))
  await expect(f.io.run(['library', 'status', '--json'])).rejects.toThrow(
    'Complete connector output exceeds the supported bound',
  )
  expect(f.io.pending).toBeUndefined()
  expect(f.calls.filter((call) => call.input['release'])).toHaveLength(1)
})
it('retains descriptor when completed native output is malformed or admission is revoked', async () => {
  const malformed = fixture()
  malformed.stdout('{')
  await expect(
    malformed.io.run(['library', 'init'], { action: 'initialize-library' }),
  ).rejects.toThrow()
  expect(malformed.io.pending).toMatchObject({ action: 'initialize-library' })
  expect(malformed.calls.filter((call) => call.input['release'])).toHaveLength(1)
  const f = fixture()
  const request = f.client.request.bind(f.client)
  f.client.request = (capability, input) => {
    if (capability === 'connector.output' && input['stream'] === 'stderr')
      f.client.alive = false
    return request(capability, input)
  }
  await expect(
    f.io.run(['library', 'init'], { action: 'initialize-library' }),
  ).rejects.toThrow(/no longer/)
  expect(f.io.pending).toMatchObject({ action: 'initialize-library' })
})

it('reports changed-program refusal as actionable without retrying or retaining a submitted mutation', async () => {
  const f = fixture()
  f.execution({ outcome: 'not-started', reason: 'executable-changed' })
  await expect(
    f.io.run(['library', 'init'], { action: 'initialize-library' }),
  ).rejects.toMatchObject({
    setupState: 'program-updated',
    message: 'Skillager was updated. Review its program access before running it again.',
  })
  expect(f.io.pending).toBeUndefined()
  expect(f.calls).toHaveLength(1)
})
