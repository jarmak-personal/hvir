import type { NativeTerminalSession } from '../src/shared/native-terminal'
import type { NativeTerminalEffectObservation } from '../src/main/terminal/native-terminal-effect-policy'
import type { NativeTerminalProductEffect } from '../src/shared/native-terminal-effects'
import { nativeTerminalWorkingDirectory } from '../src/shared/native-terminal-effects'
import { describe, expect, it, vi } from 'vitest'
import { NativeTerminalEffectPolicy } from '../src/main/terminal/native-terminal-effect-policy'
import { hostPath, asHostId } from '../src/shared/host-path'
import type {
  NativeTerminalEffect,
  NativeTerminalEffectBatch,
} from '../src/shared/native-terminal-effects'
const session = (host: string) => ({
  sessionId: 's',
  instanceId: 'i',
  ownerId: 1,
  ownerGeneration: 2,
  workspaceRoot: hostPath(asHostId(host), '/project'),
})
const batch = (effects: NativeTerminalEffect[]): NativeTerminalEffectBatch => ({
  effects,
  droppedEffects: 0,
  semanticGeneration: 0,
})
const source = { sequence: 1, eventSerial: 1 }
describe('native effects execute at existing current-session policy', () => {
  it.each(['local', 'ssh:remote'])(
    'writes complete supported OSC52 once through independent main resource validation on %s',
    (host) => {
      const clipboard = { writeText: vi.fn() },
        publish =
          vi.fn<
            (session: NativeTerminalSession, effect: NativeTerminalProductEffect) => void
          >()
      const policy = new NativeTerminalEffectPolicy(clipboard, publish)
      const observe = vi.fn<(observation: NativeTerminalEffectObservation) => void>(),
        stop = policy.observe(observe)
      policy.consume(
        session(host),
        batch([
          {
            ...source,
            kind: 'clipboard',
            protocol: 'osc-52',
            selection: 'pc',
            data: Buffer.from('é🙂').toString('base64'),
          },
        ]),
        { current: () => true, live: () => true },
      )
      expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith('é🙂')
      expect(observe.mock.calls[0]![0].session.workspaceRoot.hostId).toBe(host)
      expect(publish).not.toHaveBeenCalled()
      stop()
    },
  )
  it('keeps remote CWD on its originating host without granting project or filesystem authority', () => {
    expect(
      nativeTerminalWorkingDirectory(
        asHostId('ssh:remote'),
        'file://remote-host/home/me%20there',
      ),
    ).toEqual(hostPath(asHostId('ssh:remote'), '/home/me there'))
    for (const uri of [
      'https://host/path',
      'file:///tmp/%00bad',
      'file:///tmp?query',
      'file:///tmp#fragment',
    ])
      expect(nativeTerminalWorkingDirectory(asHostId('ssh:remote'), uri)).toBeUndefined()
  })
  it('revalidates each deferred effect after preceding execution revokes authority', () => {
    let live = true
    const clipboard = {
        writeText: vi.fn(() => {
          live = false
        }),
      },
      publish =
        vi.fn<
          (session: NativeTerminalSession, effect: NativeTerminalProductEffect) => void
        >()
    const policy = new NativeTerminalEffectPolicy(clipboard, publish)
    policy.consume(
      session('local'),
      batch([
        { ...source, kind: 'clipboard', protocol: 'osc-52', selection: '', data: 'YQ==' },
        { ...source, eventSerial: 2, kind: 'bell' },
      ]),
      { current: () => live, live: () => live },
    )
    expect(clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalled()
    policy.consume(
      session('local'),
      batch([
        { ...source, kind: 'clipboard', protocol: 'osc-52', selection: '', data: 'YQ==' },
      ]),
      { current: () => false, live: () => false },
    )
    expect(clipboard.writeText).toHaveBeenCalledTimes(1)
  })
  it('preserves current trailing title metadata while refusing clipboard and quiet attention without writable authority', () => {
    const clipboard = { writeText: vi.fn() },
      publish =
        vi.fn<
          (session: NativeTerminalSession, effect: NativeTerminalProductEffect) => void
        >()
    const policy = new NativeTerminalEffectPolicy(clipboard, publish)
    policy.consume(
      session('local'),
      batch([
        { ...source, kind: 'title', title: 'finished title' },
        {
          ...source,
          eventSerial: 2,
          kind: 'clipboard',
          protocol: 'osc-52',
          selection: 'c',
          data: 'YQ==',
        },
        { ...source, eventSerial: 3, kind: 'bell' },
        {
          ...source,
          eventSerial: 4,
          kind: 'notification',
          source: 'osc-9',
          title: '',
          body: '',
        },
      ]),
      { current: () => true, live: () => false },
    )
    expect(publish).toHaveBeenCalledExactlyOnceWith(session('local'), {
      id: 's',
      instanceId: 'i',
      eventSerial: 1,
      effect: { kind: 'title', title: 'finished title' },
    })
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })
  it('keeps reads/malformed/oversized/unsupported-selection writes unavailable', () => {
    const clipboard = { writeText: vi.fn() },
      policy = new NativeTerminalEffectPolicy(clipboard, vi.fn())
    for (const [selection, data] of [
      ['', '?'],
      ['p', 'YQ=='],
      ['', '%%%'],
      ['', 'YQ=='.repeat(16385)],
      ['', '/w=='],
      ['', ''],
    ] as const)
      policy.consume(
        session('local'),
        batch([{ ...source, kind: 'clipboard', protocol: 'osc-52', selection, data }]),
        { current: () => true, live: () => true },
      )
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })
  it('isolates resource/publish/observation failures from subsequent parser effects', () => {
    const publish = vi.fn(() => {
      throw new Error('renderer gone')
    })
    const policy = new NativeTerminalEffectPolicy(
      {
        writeText: () => {
          throw new Error('clipboard unavailable')
        },
      },
      publish,
    )
    const observe = vi.fn<(observation: NativeTerminalEffectObservation) => void>()
    policy.observe(() => {
      throw new Error('observer unavailable')
    })
    policy.observe(observe)
    expect(() =>
      policy.consume(
        session('local'),
        batch([
          {
            ...source,
            kind: 'clipboard',
            protocol: 'osc-52',
            selection: '',
            data: 'YQ==',
          },
          { ...source, kind: 'bell' },
        ]),
        { current: () => true, live: () => true },
      ),
    ).not.toThrow()
    expect(publish).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ executionFailures: 2 }),
    )
  })
  it('uses only title/quiet BEL+OSC9 while OSC777/palette remain observational', () => {
    const publish =
        vi.fn<
          (session: NativeTerminalSession, effect: NativeTerminalProductEffect) => void
        >(),
      policy = new NativeTerminalEffectPolicy({ writeText: vi.fn() }, publish)
    policy.consume(
      session('local'),
      batch([
        { ...source, kind: 'title', title: 'good' },
        { ...source, kind: 'title', title: 'x'.repeat(600) },
        { ...source, kind: 'bell' },
        { ...source, kind: 'notification', source: 'osc-9', title: 't', body: 'b' },
        { ...source, kind: 'notification', source: 'osc-777', title: 't', body: 'b' },
        {
          ...source,
          kind: 'palette',
          action: 1,
          operation: 4,
          targetClass: 0,
          targetIndex: 1,
        },
      ]),
      { current: () => true, live: () => true },
    )
    expect(publish.mock.calls.map((call) => call[1].effect)).toEqual([
      { kind: 'title', title: 'good' },
      { kind: 'title', title: 'x'.repeat(600) },
      { kind: 'bell' },
      { kind: 'bell' },
    ])
  })
})
