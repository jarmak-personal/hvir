import { describe, expect, it, vi } from 'vitest'

import { WorkbenchRuntime } from '../src/main/workbench-runtime'

function components() {
  return {
    start: vi.fn(() => Promise.resolve()),
    suspend: vi.fn(() => Promise.resolve()),
    reopen: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(() => Promise.resolve()),
  }
}

describe('WorkbenchRuntime', () => {
  it('makes repeated lifecycle calls idempotent', async () => {
    const owned = components()
    const runtime = new WorkbenchRuntime(owned)

    await Promise.all([runtime.start(), runtime.start()])
    await Promise.all([runtime.suspend(), runtime.suspend()])
    await Promise.all([runtime.reopen(), runtime.reopen()])
    await Promise.all([runtime.shutdown(), runtime.shutdown()])

    expect(owned.start).toHaveBeenCalledOnce()
    expect(owned.suspend).toHaveBeenCalledOnce()
    expect(owned.reopen).toHaveBeenCalledOnce()
    expect(owned.shutdown).toHaveBeenCalledOnce()
    expect(runtime.state).toBe('stopped')
  })

  it('rolls back a partial startup failure', async () => {
    const owned = components()
    owned.start.mockRejectedValueOnce(new Error('startup failed'))
    const runtime = new WorkbenchRuntime(owned)

    await expect(runtime.start()).rejects.toThrow('startup failed')

    expect(owned.shutdown).toHaveBeenCalledOnce()
    expect(runtime.state).toBe('stopped')
  })

  it('waits for suspension before reopening', async () => {
    let finishSuspend: (() => void) | undefined
    const owned = components()
    owned.suspend.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSuspend = resolve
        }),
    )
    const runtime = new WorkbenchRuntime(owned)
    await runtime.start()

    const suspending = runtime.suspend()
    const reopening = runtime.reopen()
    expect(owned.reopen).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(finishSuspend).toBeTypeOf('function'))
    finishSuspend?.()
    await Promise.all([suspending, reopening])

    expect(owned.reopen).toHaveBeenCalledOnce()
    expect(runtime.state).toBe('running')
  })

  it('disposes owned resources in reverse order after operations stop', async () => {
    const calls: string[] = []
    const owned = components()
    owned.shutdown.mockImplementationOnce(() => {
      calls.push('operations')
      return Promise.resolve()
    })
    const runtime = new WorkbenchRuntime(owned)
    runtime.own('first', 'first', (value) => {
      calls.push(value)
    })
    runtime.own('second', 'second', (value) => {
      calls.push(value)
    })

    await runtime.start()
    await runtime.shutdown()

    expect(calls).toEqual(['operations', 'second', 'first'])
  })

  it('rolls back only the resources acquired before startup fails', async () => {
    const calls: string[] = []
    const owned = components()
    const runtime = new WorkbenchRuntime(owned)
    owned.start.mockImplementationOnce(() => {
      runtime.own('acquired', 'acquired', (value) => {
        calls.push(value)
      })
      return Promise.reject(new Error('startup failed'))
    })

    await expect(runtime.start()).rejects.toThrow('startup failed')

    expect(calls).toEqual(['acquired'])
    expect(owned.shutdown).toHaveBeenCalledOnce()
  })
})
