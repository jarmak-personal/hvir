import { NativeTerminalAdmissionError } from '../src/shared/native-terminal'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  validNativeTerminalAppearance,
  nativeTerminalTypographyChanged,
  nativeTerminalAppearanceEquals,
  type NativeTerminalAppearance,
} from '../src/shared/native-terminal-appearance'
import {
  fontFamilyStack,
  normalizeFontPreference,
} from '../src/renderer/src/settings/typography-settings'
import { nativeTerminalHostFixture as fixture } from './fixtures/native-terminal-host'

const appearance: NativeTerminalAppearance = {
  fontFamily: '"Fira Code", monospace',
  fontSize: 13,
  ligatures: true,
  cursorShape: 'hollow-block',
  cursorBlink: 'terminal',
  appearance: 'dark',
  colors: Array.from({ length: 22 }, (_, i) => i * 0x010101),
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(() => vi.useRealTimers())

describe('native terminal appearance admission', () => {
  it('accepts the existing full cursor vocabulary and a bounded font fallback stack', () => {
    for (const cursorShape of ['block', 'hollow-block', 'bar', 'underline'])
      for (const cursorBlink of ['terminal', 'blinking', 'steady'])
        expect(
          validNativeTerminalAppearance({ ...appearance, cursorShape, cursorBlink }),
        ).toBe(true)
  })
  it('admits every maximum-length Settings family after CSS quoting and fallback composition', () => {
    for (const family of ['字'.repeat(100), '\\'.repeat(100), '"'.repeat(100)]) {
      const fontFamily = fontFamilyStack(
        normalizeFontPreference({ mode: 'custom', family }),
        'monospace',
      )
      expect(validNativeTerminalAppearance({ ...appearance, fontFamily })).toBe(true)
    }
  })
  it('distinguishes palette/cursor updates from typography invalidation', () => {
    expect(nativeTerminalTypographyChanged(undefined, appearance)).toBe(true)
    const recolored = {
      ...appearance,
      colors: Array(22).fill(0x765432),
      cursorShape: 'bar' as const,
    }
    expect(nativeTerminalTypographyChanged(appearance, recolored)).toBe(false)
    expect(nativeTerminalAppearanceEquals(appearance, recolored)).toBe(false)
    expect(
      nativeTerminalAppearanceEquals(appearance, {
        ...appearance,
        colors: [...appearance.colors],
      }),
    ).toBe(true)
    for (const next of [
      { ...appearance, fontSize: 14 },
      { ...appearance, fontFamily: 'monospace' },
      { ...appearance, ligatures: false },
    ])
      expect(nativeTerminalTypographyChanged(appearance, next)).toBe(true)
  })
  it.each([
    { ...appearance, command: 'arbitrary-command' },
    { ...appearance, fontFamily: 'font\ncommand=foo' },
    { ...appearance, fontFamily: '字'.repeat(342) },
    { ...appearance, fontSize: 13.5 },
    { ...appearance, fontSize: 25 },
    { ...appearance, colors: Array(21).fill(0) },
    { ...appearance, colors: Array(22) },
    { ...appearance, colors: Array(22).fill(0x1000000) },
    { ...appearance, colors: Array(22).fill(-1) },
    { ...appearance, cursorBlink: true },
  ])(
    'rejects configuration authority and malformed bounded presentation data',
    (value) => {
      expect(validNativeTerminalAppearance(value)).toBe(false)
    },
  )
})

describe('native terminal appearance authority and acknowledgement', () => {
  it('rejects an incompatible native status without appearance acknowledgement fields', async () => {
    const f = fixture(),
      session = f.session()
    const {
      appliedAppearanceSerial: _applied,
      appearanceFailureSerial: _failure,
      ...legacy
    } = f.live.status
    f.request.mockResolvedValueOnce({ state: '1', status: legacy })
    await expect(f.host.prepare(session, 32, 32)).rejects.toThrow(
      'native-prepare-invalid',
    )
    expect(f.process.dispose).toHaveBeenCalledOnce()
  })

  it('waits for the exact appearance fence without waiting for current feed or resizing', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const ordinary = f.request.getMockImplementation()!
    f.live.status = { ...f.live.status, appliedSequence: 99, ioAppliedSequence: 40 }
    const captured = { ...appearance, colors: [...appearance.colors] }
    let completed = false
    const applying = f.host
      .appearance(handle, 1, 1, attachment, captured)
      .then((value) => {
        completed = true
        return value
      })
    captured.colors[0] = 0xffffff
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toBe(false)
    expect(
      f.request.mock.calls.find(([command]) => command.kind === 'appearance')?.[0],
    ).toMatchObject({
      kind: 'appearance',
      state: '1',
      serial: 1,
      appearance: { colors: appearance.colors },
    })
    f.live.status = { ...f.live.status, appliedAppearanceSerial: 1 }
    await vi.advanceTimersByTimeAsync(1)
    expect(await applying).toMatchObject({
      appliedAppearanceSerial: 1,
      geometry: { serial: 1 },
    })
    expect(f.request.mock.calls.some(([command]) => command.kind === 'resize')).toBe(
      false,
    )
    f.request.mockImplementation(ordinary)
  })

  it('retries only an unsent appearance admission without changing its native serial', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const ordinary = f.request.getMockImplementation()!
    let attempts = 0
    f.request.mockImplementation((command, signal) => {
      if (command.kind !== 'appearance') return ordinary(command, signal)
      attempts++
      if (attempts === 1) return Promise.reject(new NativeTerminalAdmissionError())
      f.live.status = { ...f.live.status, appliedAppearanceSerial: command.serial }
      return Promise.resolve({ result: 0 })
    })
    const result = f.host
      .appearance(handle, 1, 1, attachment, appearance)
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(16)
    expect(await result).toMatchObject({ appliedAppearanceSerial: 1 })
    expect(attempts).toBe(2)
    const commands = f.request.mock.calls
      .map(([command]) => command)
      .filter((command) => command.kind === 'appearance')
    expect(commands.map((command) => command.serial)).toEqual([1, 1])
  })
  it('does not submit an admission retry after its attachment is replaced', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const ordinary = f.request.getMockImplementation()!
    let attempts = 0
    f.request.mockImplementation((command, signal) => {
      if (command.kind !== 'appearance') return ordinary(command, signal)
      attempts++
      return Promise.reject(new NativeTerminalAdmissionError())
    })
    const result = f.host
      .appearance(handle, 1, 1, attachment, appearance)
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    f.host.attach(handle, session)
    await vi.advanceTimersByTimeAsync(16)
    expect(await result).toMatchObject({ message: 'native-attachment-stale' })
    expect(attempts).toBe(1)
  })
  it('retries an unsent status read without repeating an admitted appearance mutation', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const ordinary = f.request.getMockImplementation()!
    let mutations = 0,
      inspections = 0
    f.request.mockImplementation((command, signal) => {
      if (command.kind === 'appearance') {
        mutations++
        f.live.status = {
          ...f.live.status,
          appliedAppearanceSerial: command.serial,
          ioAppliedMutation: 11,
        }
        return Promise.resolve({ result: 0 })
      }
      if (command.kind === 'inspect' && ++inspections === 1)
        return Promise.reject(new NativeTerminalAdmissionError())
      return ordinary(command, signal)
    })
    const applying = f.host.appearance(handle, 1, 1, attachment, appearance)
    await vi.advanceTimersByTimeAsync(16)
    expect(await applying).toMatchObject({
      appliedAppearanceSerial: 1,
      ioAppliedMutation: 11,
    })
    expect(mutations).toBe(1)
    expect(inspections).toBe(2)
  })
  it('cancels an unsent admission wait when its native state closes', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const ordinary = f.request.getMockImplementation()!
    let attempts = 0
    f.request.mockImplementation((command, signal) => {
      if (command.kind !== 'appearance') return ordinary(command, signal)
      attempts++
      return Promise.reject(new NativeTerminalAdmissionError())
    })
    const result = f.host
      .appearance(handle, 1, 1, attachment, appearance)
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    await f.host.end(handle, session.instanceId)
    await vi.advanceTimersByTimeAsync(16)
    expect(await result).toBeInstanceOf(Error)
    expect(attempts).toBe(1)
  })
  it('does not retry settings superseded before their first native admission', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const ordinary = f.request.getMockImplementation()!
    const attempts: number[] = []
    f.request.mockImplementation((command, signal) => {
      if (command.kind !== 'appearance') return ordinary(command, signal)
      attempts.push(command.serial)
      if (command.serial === 1) return Promise.reject(new NativeTerminalAdmissionError())
      f.live.status = { ...f.live.status, appliedAppearanceSerial: command.serial }
      return Promise.resolve({ result: 0 })
    })
    const older = f.host
      .appearance(handle, 1, 1, attachment, appearance)
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(
      await f.host.appearance(handle, 1, 1, attachment, { ...appearance, fontSize: 14 }),
    ).toMatchObject({ appliedAppearanceSerial: 2 })
    await vi.advanceTimersByTimeAsync(16)
    expect(await older).toMatchObject({ message: 'native-appearance-superseded' })
    expect(attempts).toEqual([1, 2])
  })
  it('bounds an unsent admission wait and leaves no idle timer after refusal', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const ordinary = f.request.getMockImplementation()!
    f.request.mockImplementation((command, signal) =>
      command.kind === 'appearance'
        ? Promise.reject(new NativeTerminalAdmissionError())
        : ordinary(command, signal),
    )
    const result = f.host
      .appearance(handle, 1, 1, attachment, appearance)
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10000)
    expect(await result).toBeInstanceOf(NativeTerminalAdmissionError)
    expect(vi.getTimerCount()).toBe(0)
    const attempts = f.request.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.request.mock.calls).toHaveLength(attempts)
  })
  it('does not replay a command whose native failure may follow mutation', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const ordinary = f.request.getMockImplementation()!
    let attempts = 0
    f.request.mockImplementation((command, signal) => {
      if (command.kind !== 'appearance') return ordinary(command, signal)
      attempts++
      return Promise.reject(new Error('native-operation-failed'))
    })
    await expect(f.host.appearance(handle, 1, 1, attachment, appearance)).rejects.toThrow(
      'native-operation-failed',
    )
    await vi.advanceTimersByTimeAsync(32)
    expect(attempts).toBe(1)
  })
  it('rejects completion after a newer settings request, while the newest fence completes', async () => {
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const first = deferred<unknown>()
    const ordinary = f.request.getMockImplementation()!
    f.request.mockImplementation((command, signal) =>
      command.kind === 'appearance' && command.serial === 1
        ? first.promise
        : ordinary(command, signal),
    )
    const older = f.host.appearance(handle, 1, 1, attachment, appearance)
    const rejected = expect(older).rejects.toThrow('native-appearance-superseded')
    f.live.status = { ...f.live.status, appliedAppearanceSerial: 2 }
    await expect(
      f.host.appearance(handle, 1, 1, attachment, { ...appearance, fontSize: 14 }),
    ).resolves.toMatchObject({ appliedAppearanceSerial: 2 })
    first.resolve({ result: 0 })
    await rejected
  })

  it('rejects a replaced attachment after admitted native work settles', async () => {
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const pending = deferred<unknown>()
    f.request.mockResolvedValueOnce(pending.promise)
    const applying = f.host.appearance(handle, 1, 1, attachment, appearance)
    const rejected = expect(applying).rejects.toThrow('native-attachment-stale')
    f.host.detach(handle, 1, 1, attachment)
    f.host.attach(handle, session)
    pending.resolve({ result: 0 })
    await rejected
  })

  it('reports native application failure instead of completing with prior derived settings', async () => {
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    f.live.status = { ...f.live.status, appearanceFailureSerial: 1 }
    await expect(f.host.appearance(handle, 1, 1, attachment, appearance)).rejects.toThrow(
      'native-appearance-failed',
    )
  })

  it('rejects invalid and detached settings before dispatching any native mutation', async () => {
    const f = fixture(),
      session = f.session()
    const handle = await f.host.prepare(session, 32, 32)
    const attachment = f.host.attach(handle, session)
    const before = f.request.mock.calls.length
    await expect(
      f.host.appearance(handle, 1, 1, attachment, { ...appearance, colors: [] }),
    ).rejects.toThrow('native-appearance-invalid')
    f.host.detach(handle, 1, 1, attachment)
    await expect(f.host.appearance(handle, 1, 1, attachment, appearance)).rejects.toThrow(
      'native-attachment-stale',
    )
    expect(f.request.mock.calls).toHaveLength(before)
  })
})
