import { describe, expect, it } from 'vitest'
import { NATIVE_TERMINAL_LIMITS } from '../src/shared/native-terminal'
import {
  NativeTerminalJobs,
  type NativeTerminalJobLimits,
} from '../src/workers/native-terminal-jobs'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('native terminal job admission and physical execution', () => {
  it('holds all shared slot/byte credit through physical completion and executes one job', async () => {
    const jobs = new NativeTerminalJobs()
    const gate = deferred<number>()
    const pending: Promise<number>[] = []
    let physical = 0
    let maximum = 0
    for (let state = 0; state < 8; state++)
      for (let job = 0; job < 8; job++)
        pending.push(
          jobs.enqueue(`state-${state}`, 16 * 1024, 'feed', () => {
            physical++
            maximum = Math.max(maximum, physical)
            return gate.promise.finally(() => physical--)
          }),
        )
    expect(jobs.pendingCount).toBe(NATIVE_TERMINAL_LIMITS.commands)
    expect(jobs.queuedBytes).toBe(NATIVE_TERMINAL_LIMITS.queuedBytes)
    expect(physical).toBe(1)
    let rejectedExecuted = false
    await expect(
      jobs.enqueue('extra', 0, 'control', () => {
        rejectedExecuted = true
        return Promise.resolve()
      }),
    ).rejects.toThrow('capacity')
    expect(jobs.pendingCount).toBe(64)
    expect(jobs.queuedBytes).toBe(1024 * 1024)
    gate.resolve(17)
    expect(await Promise.all(pending)).toEqual(Array<number>(64).fill(17))
    expect(maximum).toBe(1)
    expect(physical).toBe(0)
    expect(rejectedExecuted).toBe(false)
    expect(jobs.pendingCount).toBe(0)
    expect(jobs.queuedBytes).toBe(0)
  })

  it.each<{
    name: string
    limits: Partial<NativeTerminalJobLimits>
    admitted: [string, number][]
    refused: [string, number]
  }>([
    {
      name: 'global commands',
      limits: { commands: 2 },
      admitted: [
        ['a', 0],
        ['b', 0],
      ],
      refused: ['c', 0],
    },
    {
      name: 'per-state commands',
      limits: { commandsPerState: 2 },
      admitted: [
        ['a', 0],
        ['a', 0],
        ['b', 0],
      ],
      refused: ['a', 0],
    },
    {
      name: 'global bytes',
      limits: { queuedBytes: 6 },
      admitted: [
        ['a', 4],
        ['b', 2],
        ['c', 0],
      ],
      refused: ['d', 1],
    },
    {
      name: 'per-state bytes',
      limits: { queuedBytesPerState: 6 },
      admitted: [
        ['a', 4],
        ['a', 2],
        ['b', 4],
      ],
      refused: ['a', 1],
    },
  ])('rejects before admission at $name', async ({ limits, admitted, refused }) => {
    const jobs = new NativeTerminalJobs(limits)
    const gate = deferred<number>()
    const pending = admitted.map(([state, bytes]) =>
      jobs.enqueue(state, bytes, 'feed', () => gate.promise),
    )
    const before = { count: jobs.pendingCount, bytes: jobs.queuedBytes }
    let ran = false
    await expect(
      jobs.enqueue(...refused, 'control', () => {
        ran = true
        return Promise.resolve()
      }),
    ).rejects.toThrow('capacity')
    expect({ count: jobs.pendingCount, bytes: jobs.queuedBytes }).toEqual(before)
    gate.resolve(1)
    await Promise.all(pending)
    expect(ran).toBe(false)
    expect(jobs.pendingCount).toBe(0)
    expect(jobs.queuedBytes).toBe(0)
  })

  it('rejects invalid byte counts without scheduling or accounting', async () => {
    const jobs = new NativeTerminalJobs()
    let ran = false
    for (const bytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      await expect(
        jobs.enqueue('a', bytes, 'feed', () => {
          ran = true
          return Promise.resolve()
        }),
      ).rejects.toThrow('Invalid')
    expect(ran).toBe(false)
    expect(jobs.pendingCount).toBe(0)
    expect(jobs.queuedBytes).toBe(0)
    await expect(
      jobs.enqueue('a', 0, 'control', () => Promise.resolve('zero')),
    ).resolves.toBe('zero')
  })

  it('permits only positive reductions of the shared hard limits', () => {
    for (const limits of [
      { commands: 65 },
      { commandsPerState: 9 },
      { queuedBytes: 1024 * 1024 + 1 },
      { queuedBytesPerState: 128 * 1024 + 1 },
      { commands: 0 },
      { queuedBytes: NaN },
    ])
      expect(() => new NativeTerminalJobs(limits)).toThrow(RangeError)
  })
})

describe('native terminal job fairness', () => {
  it('gives controls priority but feeds run after at most four controls', async () => {
    const jobs = new NativeTerminalJobs()
    const gate = deferred<void>()
    const order: string[] = []
    const pending = [
      jobs.enqueue('initial', 1, 'feed', () => {
        order.push('initial')
        return gate.promise
      }),
    ]
    for (const state of ['a', 'b'])
      for (let i = 1; i <= 5; i++)
        pending.push(
          jobs.enqueue(state, 0, 'control', () => {
            order.push(`${state}${i}`)
            return Promise.resolve()
          }),
        )
    for (const state of ['f1', 'f2'])
      pending.push(
        jobs.enqueue(state, 1, 'feed', () => {
          order.push(state)
          return Promise.resolve()
        }),
      )
    gate.resolve()
    await Promise.all(pending)
    expect(order).toEqual([
      'initial',
      'a1',
      'b1',
      'a2',
      'b2',
      'f1',
      'a3',
      'b3',
      'a4',
      'b4',
      'f2',
      'a5',
      'b5',
    ])
  })

  it('round-robins feed states while preserving their individual FIFO order', async () => {
    const jobs = new NativeTerminalJobs()
    const gate = deferred<void>()
    const order: string[] = []
    const pending = [
      jobs.enqueue('a', 1, 'feed', () => {
        order.push('a0')
        return gate.promise
      }),
    ]
    for (const state of ['a', 'b'])
      for (let i = 1; i <= 2; i++)
        pending.push(
          jobs.enqueue(state, 1, 'feed', () => {
            order.push(`${state}${i}`)
            return Promise.resolve()
          }),
        )
    gate.resolve()
    await Promise.all(pending)
    expect(order).toEqual(['a0', 'b1', 'a1', 'b2', 'a2'])
  })
})

describe('native terminal job retirement', () => {
  it('rejects delivery on close but holds active accounting through its real completion', async () => {
    const jobs = new NativeTerminalJobs()
    const gate = deferred<string>()
    let resourceRetired = 0
    const physical = gate.promise.then((value) => {
      resourceRetired++
      return value
    })
    const active = jobs.enqueue('a', 4, 'feed', () => physical)
    let queuedRan = false
    const queued = jobs.enqueue('b', 3, 'control', () => {
      queuedRan = true
      return Promise.resolve()
    })
    let successfulDeliveries = 0
    let rejectedDeliveries = 0
    const observed = [active, queued].map((promise) =>
      promise.then(
        () => {
          successfulDeliveries++
        },
        () => {
          rejectedDeliveries++
        },
      ),
    )
    const closed = new Error('native host lost')
    jobs.close(closed)
    jobs.close(new Error('different close'))
    await Promise.all(observed)
    expect(jobs.pendingCount).toBe(1)
    expect(jobs.queuedBytes).toBe(4)
    expect(queuedRan).toBe(false)
    await expect(jobs.enqueue('c', 0, 'control', () => Promise.resolve(0))).rejects.toBe(
      closed,
    )
    gate.resolve('late owned resource')
    await physical
    expect(resourceRetired).toBe(1)
    expect(successfulDeliveries).toBe(0)
    expect(rejectedDeliveries).toBe(2)
    expect(jobs.pendingCount).toBe(0)
    expect(jobs.queuedBytes).toBe(0)
  })

  it('releases rejected work and starts the next operation', async () => {
    const jobs = new NativeTerminalJobs()
    const gate = deferred<string>()
    const failed = jobs.enqueue('a', 10, 'feed', () => gate.promise)
    const next = jobs.enqueue('b', 3, 'control', () => Promise.resolve('next'))
    const error = new Error('native operation failed')
    const observed = expect(failed).rejects.toBe(error)
    gate.reject(error)
    await observed
    await expect(next).resolves.toBe('next')
    expect(jobs.pendingCount).toBe(0)
    expect(jobs.queuedBytes).toBe(0)
    await expect(
      jobs.enqueue('a', 1, 'control', (): Promise<void> => {
        throw error
      }),
    ).rejects.toBe(error)
    await expect(
      jobs.enqueue('a', 0, 'feed', () => Promise.resolve('reused')),
    ).resolves.toBe('reused')
    expect(jobs.pendingCount).toBe(0)
  })
})
