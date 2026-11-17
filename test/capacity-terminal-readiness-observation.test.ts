import { describe, expect, it, vi } from 'vitest'
import type { PtySupervisor } from '../src/main/pty/pty-supervisor'
import type {
  ManagedPty,
  PtyPreparedTerminal,
  PtySpawnRequest,
} from '../src/main/pty/pty-contract'
import { observeCapacityReadinessSpawn } from '../src/main/smoke/capacity-terminal-readiness'
vi.mock('electron', () => ({ app: {}, clipboard: {} }))

type Owner = Pick<PtySupervisor, 'spawn'>
const terminal = {
  id: 'new',
  instanceId: 'instance',
  ownerId: 7,
  ownerGeneration: 2,
  startedAt: 123,
}
const request = () =>
  ({ sessionId: 'new', ownerId: 7, ownerGeneration: 2 }) as PtySpawnRequest
const pendingSpawn = () => new Promise<ManagedPty>(() => undefined)
const pendingPreparation = () => new Promise<PtyPreparedTerminal>(() => undefined)

describe('readiness launch observation at the actual supervisor adapter', () => {
  it('preserves both promises and original receivers without observing their settlement', () => {
    const spawnResult = pendingSpawn(),
      prepareResult = pendingPreparation()
    const spawnThen = vi.spyOn(spawnResult, 'then'),
      prepareThen = vi.spyOn(prepareResult, 'then')
    let observed: PtySpawnRequest | undefined
    const spawn: Owner['spawn'] = function (this: Owner, value) {
      expect(this).toBe(owner)
      observed = value
      return spawnResult
    }
    const owner: Owner = { spawn },
      original = request()
    let preparationArguments:
      Parameters<NonNullable<PtySpawnRequest['prepareTerminal']>> | undefined
    const prepare: NonNullable<PtySpawnRequest['prepareTerminal']> = function (
      this: PtySpawnRequest,
      ...args
    ) {
      expect(this).toBe(original)
      preparationArguments = args
      return prepareResult
    }
    Object.defineProperty(original, 'prepareTerminal', {
      value: prepare,
      configurable: true,
    })
    const observation = observeCapacityReadinessSpawn(owner)
    expect(owner.spawn(original)).toBe(spawnResult)
    const reservation = {
      sessionId: 'new',
      instanceId: 'instance',
      ownerId: 7,
      ownerGeneration: 2,
      workspaceRoot: { hostId: 'local', path: '/fixture' },
    } as Parameters<NonNullable<PtySpawnRequest['prepareTerminal']>>[0]
    const signal = new AbortController().signal
    expect(observed!.prepareTerminal!(reservation, signal)).toBe(prepareResult)
    expect(preparationArguments).toEqual([reservation, signal])
    expect(spawnThen).not.toHaveBeenCalled()
    expect(prepareThen).not.toHaveBeenCalled()
    expect(observation.read(terminal)).toMatchObject({
      join: 'matched',
      preparation: 'entered',
      launchedAtMs: 123,
    })
    expect(typeof observation.read(terminal).spawnEnteredAtMs).toBe('number')
    expect(typeof observation.read(terminal).preparationEnteredAtMs).toBe('number')
    observation.dispose()
    expect(owner.spawn).toBe(spawn)
  })

  it('preserves actual plain request data and arrow callback references', () => {
    const beforeDispatch = () => undefined,
      onDispatch = () => undefined
    const signal = new AbortController().signal
    const prepared = pendingPreparation()
    const prepare = () => prepared
    const original: PtySpawnRequest = {
      ...request(),
      beforeDispatch,
      onDispatch,
      signal,
      prepareTerminal: prepare,
    }
    let observed: PtySpawnRequest | undefined
    const owner: Owner = {
      spawn: (value) => {
        observed = value
        return pendingSpawn()
      },
    }
    const observation = observeCapacityReadinessSpawn(owner)
    void owner.spawn(original)
    expect(observed).not.toBe(original)
    expect(observed).toMatchObject({
      sessionId: original.sessionId,
      ownerId: original.ownerId,
      ownerGeneration: original.ownerGeneration,
    })
    expect(observed!.signal).toBe(signal)
    expect(observed!.beforeDispatch).toBe(beforeDispatch)
    expect(observed!.onDispatch).toBe(onDispatch)
    expect(original.prepareTerminal).toBe(prepare)
    observation.dispose()
  })

  it('preserves a synchronous preparation failure without invoking it early', () => {
    const failure = new Error('prepare-original'),
      original = request()
    const prepare = vi.fn(() => {
      throw failure
    })
    Object.defineProperty(original, 'prepareTerminal', {
      value: prepare,
      configurable: true,
    })
    let observed: PtySpawnRequest | undefined
    const owner: Owner = {
      spawn: (value) => {
        observed = value
        return pendingSpawn()
      },
    }
    const observation = observeCapacityReadinessSpawn(owner)
    void owner.spawn(original)
    expect(prepare).not.toHaveBeenCalled()
    let caught: unknown
    try {
      void observed!.prepareTerminal!(
        { ...terminal, sessionId: terminal.id } as unknown as Parameters<
          NonNullable<PtySpawnRequest['prepareTerminal']>
        >[0],
        new AbortController().signal,
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
    observation.dispose()
  })

  it('records missing and ambiguous joins without attributing another actor to this launch', () => {
    const owner: Owner = { spawn: () => pendingSpawn() },
      observation = observeCapacityReadinessSpawn(owner)
    void owner.spawn({ ...request(), ownerGeneration: 9 })
    expect(observation.read(terminal).join).toBe('missing')
    void owner.spawn(request())
    expect(observation.read(terminal)).toMatchObject({
      join: 'matched',
      preparation: 'not-entered',
    })
    void owner.spawn(request())
    expect(observation.read(terminal).join).toBe('ambiguous')
    observation.dispose()
  })

  it('preserves synchronous failure identity and exact descriptor restoration', () => {
    const failure = new Error('original'),
      original = vi.fn<Owner['spawn']>(() => {
        throw failure
      })
    const owner = {} as Owner
    Object.defineProperty(owner, 'spawn', {
      value: original,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'spawn')
    const observation = observeCapacityReadinessSpawn(owner)
    let caught: unknown
    try {
      void owner.spawn(request())
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(failure)
    observation.dispose()
    observation.dispose()
    expect(Object.getOwnPropertyDescriptor(owner, 'spawn')).toEqual(descriptor)
  })

  it('removes its prototype shadow and leaves a later replacement untouched', () => {
    const original: Owner['spawn'] = () => pendingSpawn()
    const prototype = { spawn: original },
      owner: Owner = Object.create(prototype) as Owner
    const first = observeCapacityReadinessSpawn(owner)
    first.dispose()
    expect(Object.hasOwn(owner, 'spawn')).toBe(false)
    const second = observeCapacityReadinessSpawn(owner),
      replacement: Owner['spawn'] = () => pendingSpawn()
    owner.spawn = replacement
    second.dispose()
    expect(owner.spawn).toBe(replacement)
    expect(prototype.spawn).toBe(original)
  })
})
