import { describe, expect, it, vi } from 'vitest'
import {
  NativeTerminalInput,
  type NativeTerminalInputContext,
} from '../src/main/terminal/native-terminal-input'
import { PtyWriteConfirmedRevokedError } from '../src/main/project-host/project-host'
import { NativeTerminalAdmissionError } from '../src/shared/native-terminal'
import {
  NATIVE_INPUT_RESULTS,
  NativeTerminalInputResourceRefused,
  NativeTerminalInputPhysicalFailure,
  type NativeTerminalInputOperation,
  type NativeTerminalInputResult,
  type NativeTerminalKeyEncodingFallback,
} from '../src/shared/native-terminal-input'
import { nativeTerminalStatus } from './fixtures/native-terminal-host'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const key = (modifiers = 0, code = 58): NativeTerminalInputOperation => ({
  kind: 'key',
  key: code,
  modifiers,
  consumedModifiers: 0,
  action: 1,
  text: '',
  unshiftedCodepoint: 0,
  composing: false,
  optionAsAlt: false,
})
const wheel: NativeTerminalInputOperation = {
  kind: 'wheel',
  x: 1,
  y: 2,
  deltaX: 0,
  deltaY: -10,
  precision: true,
  modifiers: 0,
}
function fixture(cleanupBytes = new Uint8Array()) {
  const host = {
    input: vi.fn(
      async (
        _handle: string,
        _instance: string,
        operation: NativeTerminalInputOperation,
        eligible?: (signal: AbortSignal) => Promise<void>,
        readOnly = false,
        _fallback?: NativeTerminalKeyEncodingFallback,
      ): Promise<NativeTerminalInputResult> => {
        await eligible?.(new AbortController().signal)
        const bytes =
          operation.kind === 'key'
            ? new Uint8Array([0, 128, 255])
            : operation.kind === 'focus' && !operation.focused
              ? cleanupBytes
              : new Uint8Array()
        return {
          bytes,
          capacity: bytes.length,
          source: operation.kind === 'focus' ? 'terminal-response' : 'user',
          requestedMutation: 1,
          ...(operation.kind === 'caret'
            ? { caret: { x: 4, y: 5, width: 2, height: 10, geometrySerial: 1 } }
            : {}),
          ...(readOnly ? { captured: false } : {}),
        }
      },
    ),
    inspectProducer: vi.fn(() =>
      Promise.resolve({
        ...nativeTerminalStatus(),
        ioAppliedMutation: 1,
      }),
    ),
  }
  const owner = new NativeTerminalInput(host)
  const context = (id = 'first') => {
    const current = { value: true }
    const port = {
      handle: id,
      instanceId: `instance-${id}`,
      geometrySerial: 1,
      state: { revoked: false },
      readOnly: false,
      inputSettled: () => undefined,
      retainInput: (_pending: Promise<unknown>) => undefined,
      assertCurrent: () => {
        if (!current.value) throw new Error('stale-view')
      },
      prefix: () => ({
        parsed: () => Promise.resolve(),
        replies: () => Promise.resolve(),
      }),
      writeUser: vi.fn((_bytes: Uint8Array) => Promise.resolve()),
      writeControl: vi.fn((_bytes: Uint8Array) => Promise.resolve()),
      blockInput: vi.fn<() => void>(),
    } satisfies NativeTerminalInputContext
    return { port, current }
  }
  return { owner, host, context }
}

describe('native input authority, completion and provider policy', () => {
  it('can encode after parsing but never appends user bytes ahead of the captured response prefix', async () => {
    const f = fixture(),
      { port } = f.context(),
      replies = deferred<void>()
    await f.owner.dispatch(port, { kind: 'focus', focused: true })
    const context = {
      ...port,
      prefix: () => ({ parsed: () => Promise.resolve(), replies: () => replies.promise }),
    }
    const input = f.owner.dispatch(context, key())
    await vi.waitFor(() => expect(f.host.input).toHaveBeenCalledTimes(2))
    expect(port.writeUser).not.toHaveBeenCalled()
    replies.resolve()
    await input
    expect(port.writeUser).toHaveBeenCalledOnce()
  })
  it('keeps composition clear focused and writes exact native bytes once per committed key', async () => {
    const f = fixture(),
      { port } = f.context()
    await f.owner.dispatch(port, { kind: 'focus', focused: true })
    await f.owner.dispatch(port, { kind: 'preedit', text: '候補' })
    await f.owner.dispatch(port, { kind: 'preedit', text: null })
    await f.owner.dispatch(port, key())
    await f.owner.dispatch(port, key())
    expect(port.writeUser).toHaveBeenCalledTimes(2)
    expect(port.writeUser).toHaveBeenNthCalledWith(1, new Uint8Array([0, 128, 255]))
    expect(port.writeControl).not.toHaveBeenCalled()
  })

  it.each([
    ['csi-u', 2, 'csi-u'],
    ['csi-u', 8, 'csi-u'],
    ['modify-other-keys', 2, 'modify-other-keys'],
    ['modify-other-keys', 8, 'modify-other-keys'],
  ] as const)(
    'preserves provider %s control-submit chord %s as one write',
    async (protocol, modifiers, expected) => {
      const f = fixture(),
        { port } = f.context()
      const context = {
        ...port,
        policy: {
          composerSubmitMode: 'ctrl-enter' as const,
          modifiedKeyProtocol: protocol,
          metaEnterAliasesControl: true,
        },
      }
      await f.owner.dispatch(context, { kind: 'focus', focused: true })
      await f.owner.dispatch(context, key(modifiers))
      expect(port.writeUser).toHaveBeenCalledExactlyOnceWith(
        new Uint8Array([0, 128, 255]),
      )
      const native = f.host.input.mock.calls.filter((call) => call[2].kind === 'key')
      expect(native).toHaveLength(1)
      expect(native[0]?.[5]).toBe(expected)
      expect(native[0]?.[2]).toMatchObject({ modifiers: 2 })
    },
  )

  it('leaves neutral-shell bytes and native navigation/release encoding authoritative', async () => {
    const f = fixture(),
      { port } = f.context()
    const context = {
      ...port,
      policy: {
        composerSubmitMode: 'enter' as const,
        modifiedKeyProtocol: 'none' as const,
        metaEnterAliasesControl: false,
      },
    }
    await f.owner.dispatch(context, { kind: 'focus', focused: true })
    await f.owner.dispatch(context, key(1, 78))
    expect(port.writeUser).toHaveBeenCalledExactlyOnceWith(new Uint8Array([0, 128, 255]))
  })

  it('allows current hovered captured wheel bytes without transferring keyboard focus', async () => {
    const f = fixture(),
      focused = f.context(),
      hovered = f.context('hovered')
    await f.owner.dispatch(focused.port, { kind: 'focus', focused: true })
    f.host.input.mockResolvedValueOnce({
      bytes: new Uint8Array([27, 91, 77]),
      capacity: 3,
      source: 'user',
      requestedMutation: 1,
    })
    await f.owner.dispatch(hovered.port, wheel)
    expect(hovered.port.writeUser).toHaveBeenCalledExactlyOnceWith(
      new Uint8Array([27, 91, 77]),
    )
    await f.owner.dispatch(focused.port, key())
    expect(focused.port.writeUser).toHaveBeenCalledOnce()
  })

  it('finishes captured old input and control cleanup before a replacement focus', async () => {
    const f = fixture(),
      old = f.context(),
      next = f.context()
    await f.owner.dispatch(old.port, { kind: 'focus', focused: true })
    const encoded = deferred<NativeTerminalInputResult>()
    f.host.input.mockImplementationOnce(() => encoded.promise)
    const typing = f.owner.dispatch(old.port, key()).catch((error: unknown) => error)
    old.current.value = false
    const focusing = f.owner.dispatch(next.port, { kind: 'focus', focused: true })
    expect(f.host.input).toHaveBeenCalledTimes(2)
    encoded.resolve({
      bytes: new Uint8Array([120]),
      capacity: 1,
      source: 'user',
      requestedMutation: 1,
    })
    expect(await typing).toEqual(expect.objectContaining({ message: 'stale-view' }))
    await focusing
    expect(old.port.writeUser).not.toHaveBeenCalled()
    expect(f.host.input.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ['first', { kind: 'focus', focused: true }],
      ['first', key()],
      ['first', { kind: 'preedit', text: null }],
      ['first', { kind: 'focus', focused: false }],
      ['first', { kind: 'focus', focused: true }],
    ])
  })

  it('omits stale caret metadata without turning an accepted key write into failure', async () => {
    const f = fixture(),
      { port } = f.context()
    await f.owner.dispatch(port, { kind: 'focus', focused: true })
    f.host.input.mockResolvedValueOnce({
      bytes: new Uint8Array([120]),
      capacity: 1,
      source: 'user',
      requestedMutation: 1,
      caret: { x: 0, y: 0, width: 1, height: 1, geometrySerial: 2 },
    })
    await expect(f.owner.dispatch(port, key())).resolves.toEqual({ requestedMutation: 1 })
    expect(port.writeUser).toHaveBeenCalledOnce()
  })

  it('retains result capacity through confirmed transport writes and preserves cleanup reserve', async () => {
    const f = fixture(),
      writes = deferred<void>()
    const contexts = [f.context('one'), f.context('two'), f.context('three')]
    f.host.input.mockResolvedValue({
      bytes: new Uint8Array([1]),
      capacity: NATIVE_INPUT_RESULTS.wheelBytes,
      source: 'user',
      requestedMutation: 1,
    })
    for (const item of contexts)
      vi.mocked(item.port.writeUser).mockReturnValue(writes.promise)
    const active = contexts.map((item) => f.owner.dispatch(item.port, wheel))
    await vi.waitFor(() => expect(contexts[2]!.port.writeUser).toHaveBeenCalledOnce())
    expect(() => f.owner.dispatch(f.context('four').port, wheel)).toThrow(
      NativeTerminalAdmissionError,
    )
    writes.resolve()
    await Promise.all(active)
    await expect(f.owner.dispatch(f.context('five').port, wheel)).resolves.toEqual({
      requestedMutation: 1,
    })
  })

  it('retains indeterminate write credit and revokes its input without retiring the parser', async () => {
    const f = fixture()
    f.host.input.mockResolvedValue({
      bytes: new Uint8Array([1]),
      capacity: NATIVE_INPUT_RESULTS.wheelBytes,
      source: 'user',
      requestedMutation: 1,
    })
    for (const name of ['one', 'two', 'three']) {
      const item = f.context(name)
      vi.mocked(item.port.writeUser).mockRejectedValue(new Error('indeterminate-write'))
      await expect(f.owner.dispatch(item.port, wheel)).rejects.toThrow(
        'indeterminate-write',
      )
      expect(item.port.state.revoked).toBe(true)
      expect(item.port.blockInput).toHaveBeenCalledOnce()
    }
    expect(() => f.owner.dispatch(f.context('four').port, wheel)).toThrow(
      'native-input-capacity',
    )
  })
  it('focuses an independent PTY before the old transport ACK and fences late old cleanup', async () => {
    const f = fixture(new Uint8Array([2])),
      old = f.context('old'),
      next = f.context('next')
    await f.owner.dispatch(old.port, { kind: 'focus', focused: true })
    const written = deferred<void>(),
      cleanup = deferred<void>()
    old.port.writeUser.mockReturnValueOnce(written.promise)
    old.port.writeControl.mockReturnValueOnce(cleanup.promise)
    const typing = f.owner.dispatch(old.port, key()).catch((error: unknown) => error)
    await vi.waitFor(() => expect(old.port.writeUser).toHaveBeenCalledOnce())
    await f.owner.dispatch(next.port, { kind: 'focus', focused: true })
    await f.owner.dispatch(next.port, key())
    expect(next.port.writeUser).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(old.port.writeControl).toHaveBeenCalledOnce())
    written.resolve()
    expect(await typing).toEqual(
      expect.objectContaining({ message: 'native-view-unfocused' }),
    )
    cleanup.resolve()
    await f.owner.blur(old.port)
    await f.owner.dispatch(next.port, key())
    expect(next.port.writeUser).toHaveBeenCalledTimes(2)
    expect(old.port.blockInput).not.toHaveBeenCalled()
    expect(next.port.blockInput).not.toHaveBeenCalled()
  })

  it('returns confirmed-revoked write credits without poisoning the immutable input instance', async () => {
    const f = fixture(),
      { port } = f.context()
    f.host.input.mockResolvedValue({
      bytes: new Uint8Array([1]),
      capacity: NATIVE_INPUT_RESULTS.wheelBytes,
      source: 'user',
      requestedMutation: 1,
    })
    for (let i = 0; i < 4; i++) {
      port.writeUser.mockRejectedValueOnce(
        new PtyWriteConfirmedRevokedError('confirmed-old-owner'),
      )
      await expect(f.owner.dispatch(port, wheel)).rejects.toBeInstanceOf(
        PtyWriteConfirmedRevokedError,
      )
    }
    expect(port.blockInput).not.toHaveBeenCalled()
    expect(port.state.revoked).toBe(false)
    await f.owner.dispatch(port, wheel)
    expect(port.writeUser).toHaveBeenCalledTimes(5)
  })

  it('waits for physical input and captured cleanup before focusing another view of the same instance', async () => {
    const f = fixture(new Uint8Array([2])),
      old = f.context(),
      next = f.context()
    await f.owner.dispatch(old.port, { kind: 'focus', focused: true })
    const written = deferred<void>(),
      cleanup = deferred<void>()
    old.port.writeUser.mockReturnValueOnce(written.promise)
    old.port.writeControl.mockReturnValueOnce(cleanup.promise)
    const typing = f.owner.dispatch(old.port, key()).catch((error: unknown) => error)
    await vi.waitFor(() => expect(old.port.writeUser).toHaveBeenCalledOnce())
    const focusing = f.owner.dispatch(next.port, { kind: 'focus', focused: true })
    expect(f.host.input).toHaveBeenCalledTimes(2)
    written.resolve()
    await vi.waitFor(() => expect(old.port.writeControl).toHaveBeenCalledOnce())
    expect(
      f.host.input.mock.calls.filter(
        (call) => call[2].kind === 'focus' && call[2].focused,
      ),
    ).toHaveLength(1)
    cleanup.resolve()
    await focusing
    expect(await typing).toEqual(
      expect.objectContaining({ message: 'native-view-unfocused' }),
    )
    await f.owner.dispatch(next.port, key())
    expect(next.port.writeUser).toHaveBeenCalledOnce()
    expect(old.port.blockInput).not.toHaveBeenCalled()
  })
  it('owns one uncapped33MiB paste through transport acknowledgement while independent keys and cleanup progress', async () => {
    const f = fixture(),
      a = f.context('a'),
      b = f.context('b')
    const source = 'p'.repeat(33 * 1024 * 1024),
      written = deferred<void>()
    const sizing = vi.spyOn(Buffer, 'byteLength'),
      encoding = vi.spyOn(TextEncoder.prototype, 'encode')
    f.host.input.mockImplementation(async (_handle, _instance, operation, eligible) => {
      await eligible?.(new AbortController().signal)
      const bytes =
        operation.kind === 'paste' || operation.kind === 'key'
          ? Uint8Array.of(1)
          : new Uint8Array()
      return {
        bytes,
        capacity:
          operation.kind === 'paste'
            ? 2 * Buffer.byteLength(operation.text) + 12
            : bytes.length,
        source: operation.kind === 'focus' ? 'terminal-response' : 'user',
        requestedMutation: 1,
      }
    })
    try {
      await f.owner.dispatch(a.port, { kind: 'focus', focused: true })
      a.port.writeUser.mockReturnValueOnce(written.promise)
      const pasting = f.owner
        .dispatch(a.port, { kind: 'paste', text: source })
        .catch((error: unknown) => error)
      await vi.waitFor(() => expect(a.port.writeUser).toHaveBeenCalledOnce())
      await f.owner.dispatch(b.port, { kind: 'focus', focused: true })
      await f.owner.dispatch(b.port, key())
      expect(() => f.owner.dispatch(b.port, { kind: 'paste', text: 'other' })).toThrow(
        NativeTerminalAdmissionError,
      )
      await f.owner.blur(b.port)
      await f.owner.dispatch(b.port, { kind: 'focus', focused: true })
      expect(b.port.writeUser).toHaveBeenCalledOnce()
      expect(sizing.mock.calls.some(([value]) => value === source)).toBe(true)
      expect(encoding.mock.calls.some(([value]) => value === source)).toBe(false)
      written.resolve()
      expect(await pasting).toEqual(
        expect.objectContaining({ message: 'native-view-unfocused' }),
      )
      await f.owner.dispatch(b.port, { kind: 'paste', text: 'fresh' })
      expect(b.port.writeUser).toHaveBeenCalledTimes(2)
      expect(a.port.blockInput).not.toHaveBeenCalled()
    } finally {
      written.resolve()
      sizing.mockRestore()
      encoding.mockRestore()
    }
  })

  it('keeps an oversized uncertain write owned while independent cleanup and keys remain usable', async () => {
    const f = fixture(),
      a = f.context('a'),
      b = f.context('b')
    const source = 'p'.repeat(33 * 1024 * 1024)
    f.host.input.mockImplementation(async (_handle, _instance, operation, eligible) => {
      await eligible?.(new AbortController().signal)
      return {
        bytes:
          operation.kind === 'paste' || operation.kind === 'key'
            ? Uint8Array.of(1)
            : new Uint8Array(),
        capacity:
          operation.kind === 'paste'
            ? 2 * Buffer.byteLength(operation.text) + 12
            : operation.kind === 'key'
              ? 1
              : 0,
        source: operation.kind === 'focus' ? 'terminal-response' : 'user',
        requestedMutation: 1,
      }
    })
    await f.owner.dispatch(a.port, { kind: 'focus', focused: true })
    a.port.writeUser.mockRejectedValueOnce(new Error('indeterminate-paste-write'))
    await expect(
      f.owner.dispatch(a.port, { kind: 'paste', text: source }),
    ).rejects.toThrow('indeterminate-paste-write')
    expect(a.port.blockInput).toHaveBeenCalledOnce()
    await f.owner.dispatch(b.port, { kind: 'focus', focused: true })
    await f.owner.dispatch(b.port, key())
    await f.owner.blur(b.port)
    await f.owner.dispatch(b.port, { kind: 'focus', focused: true })
    expect(() => f.owner.dispatch(b.port, { kind: 'paste', text: 'other' })).toThrow(
      NativeTerminalAdmissionError,
    )
    expect(b.port.blockInput).not.toHaveBeenCalled()
  })

  it('releases proven-unsent allocation refusal immediately without retry or poisoning the parser instance', async () => {
    const f = fixture(),
      { port } = f.context()
    await f.owner.dispatch(port, { kind: 'focus', focused: true })
    f.host.input.mockRejectedValueOnce(new NativeTerminalInputResourceRefused())
    await expect(
      f.owner.dispatch(port, { kind: 'paste', text: 'fixed' }),
    ).rejects.toBeInstanceOf(NativeTerminalInputResourceRefused)
    expect(f.host.input).toHaveBeenCalledTimes(2)
    expect(port.blockInput).not.toHaveBeenCalled()
    expect(port.state.revoked).toBe(false)
    await f.owner.dispatch(port, key())
    expect(port.writeUser).toHaveBeenCalledOnce()
  })

  it('retains an encoded-result credit when its native physical completion is unknown', async () => {
    const f = fixture(),
      { port } = f.context()
    await f.owner.dispatch(port, { kind: 'focus', focused: true })
    f.host.input.mockRejectedValueOnce(
      new NativeTerminalInputPhysicalFailure('native-result-lost'),
    )
    await expect(f.owner.dispatch(port, key())).rejects.toBeInstanceOf(
      NativeTerminalInputPhysicalFailure,
    )
    expect(port.blockInput).toHaveBeenCalledOnce()
    expect(port.state.revoked).toBe(true)
  })
})
