import { afterEach, expect, it, vi } from 'vitest'
import { NativeTerminalAdmissionError } from '../src/shared/native-terminal'
import { nativeTerminalHostFixture as fixture } from './fixtures/native-terminal-host'

afterEach(() => vi.useRealTimers())

it('retains exact hide cleanup authority after renderer revocation while refusing show', async () => {
  const f = fixture(),
    session = f.session(),
    handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  f.live.renderer = false
  await expect(
    f.host.setVisible(handle, 1, 1, attachment, false),
  ).resolves.toBeUndefined()
  expect(f.request).toHaveBeenLastCalledWith({
    kind: 'visibility',
    state: '1',
    visible: false,
  })
  const before = f.request.mock.calls.length
  await expect(f.host.setVisible(handle, 1, 1, attachment, true)).rejects.toThrow(
    'native-state-foreign',
  )
  await expect(f.host.setVisible(handle, 2, 1, attachment, false)).rejects.toThrow(
    'native-attachment-stale',
  )
  expect(f.request).toHaveBeenCalledTimes(before)
  await f.host.feed(handle, session.instanceId, new Uint8Array([128]))
  expect(f.process.dispose).not.toHaveBeenCalled()
})
it('retries proven-unsent hide admission without renewed renderer authority or parser destruction', async () => {
  vi.useFakeTimers()
  const f = fixture(),
    session = f.session(),
    handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session)
  f.live.renderer = false
  f.request.mockRejectedValueOnce(new NativeTerminalAdmissionError())
  const hidden = f.host.setVisible(handle, 1, 1, attachment, false)
  await vi.advanceTimersByTimeAsync(16)
  await expect(hidden).resolves.toBeUndefined()
  expect(
    f.request.mock.calls.filter(([command]) => command.kind === 'visibility'),
  ).toHaveLength(2)
  expect(f.request.mock.calls.some(([command]) => command.kind === 'destroy')).toBe(false)
  expect(f.process.dispose).not.toHaveBeenCalled()
})
it('abandons an unsent old hide before retry when a newer attachment has shown', async () => {
  vi.useFakeTimers()
  const f = fixture(),
    session = f.session(),
    handle = await f.host.prepare(session, 32, 32)
  const old = f.host.attach(handle, session)
  f.request.mockRejectedValueOnce(new NativeTerminalAdmissionError())
  const hidden = f.host.setVisible(handle, 1, 1, old, false)
  const rejected = expect(hidden).rejects.toThrow('native-attachment-stale')
  await Promise.resolve()
  const current = f.host.attach(handle, session)
  await f.host.setVisible(handle, 1, 1, current, true)
  await vi.advanceTimersByTimeAsync(16)
  await rejected
  expect(
    f.request.mock.calls
      .filter(([command]) => command.kind === 'visibility')
      .map(([command]) => command),
  ).toEqual([
    { kind: 'visibility', state: '1', visible: false },
    { kind: 'visibility', state: '1', visible: true },
  ])
  expect(f.process.dispose).not.toHaveBeenCalled()
})
it('bounds unsent hide pressure without pretending cleanup or killing live parsers', async () => {
  vi.useFakeTimers()
  const f = fixture(),
    session = f.session(),
    handle = await f.host.prepare(session, 32, 32)
  const attachment = f.host.attach(handle, session),
    original = f.request.getMockImplementation()!
  f.request.mockImplementation((command, signal) =>
    command.kind === 'visibility'
      ? Promise.reject(new NativeTerminalAdmissionError())
      : original(command, signal),
  )
  f.live.renderer = false
  const hidden = f.host.setVisible(handle, 1, 1, attachment, false)
  const rejected = expect(hidden).rejects.toBeInstanceOf(NativeTerminalAdmissionError)
  await vi.advanceTimersByTimeAsync(15016)
  await rejected
  expect(f.process.dispose).not.toHaveBeenCalled()
  await f.host.feed(handle, session.instanceId, new Uint8Array([128]))
  expect(f.request.mock.calls.some(([command]) => command.kind === 'destroy')).toBe(false)
})
