import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { verifyStreamingTerminalSearch } from '../src/main/smoke/terminal-search-streaming'

vi.mock('electron', () => ({
  clipboard: { readText: () => 'hvir-streaming-search-match' },
}))
vi.mock('../src/main/smoke/window-focus', () => ({
  focusSmokeWindow: vi.fn(() => Promise.resolve()),
}))

function fixture(failing = false, cleanup?: 'renderer' | 'pty') {
  let prepare!: () => void
  let failPrepare!: (error: Error) => void
  const prepared = new Promise<void>((resolve, reject) => {
    prepare = resolve
    failPrepare = reject
  })
  let onData!: (data: string) => void
  const detach = vi.fn(() =>
    cleanup === 'pty'
      ? Promise.reject(new Error('PTY observation release failed'))
      : Promise.resolve(),
  )
  const attach = vi.fn(
    (_id: string, _owner: number, listener: { onData: (data: string) => void }) => {
      onData = listener.onData
      return detach
    },
  )
  const write = vi.fn(() => {
    onData(
      write.mock.calls.length === 1 ? '__HVIR_STREAM_SETUP__' : '__HVIR_STREAM_READY__',
    )
  })
  const executeJavaScript = vi
    .fn()
    .mockImplementationOnce(() => prepared)
    .mockImplementationOnce(() => {
      if (failing) return Promise.resolve({ state: 'absent', count: 0, selection: null })
      setTimeout(() => onData('__HVIR_STREAM_DONE__'), 0)
      return Promise.resolve({ elapsedMs: 1000 })
    })
    .mockImplementationOnce(() =>
      cleanup === 'renderer'
        ? Promise.reject(new Error('renderer cleanup failed'))
        : Promise.resolve(),
    )
    .mockResolvedValue({ state: 'absent', count: 0, selection: null })
  return {
    executeJavaScript,
    prepare,
    failPrepare,
    write,
    detach,
    win: { webContents: { id: 7, executeJavaScript } } as unknown as BrowserWindow,
    supervisor: { attach, write } as unknown as PtySupervisor,
  }
}

describe('native streaming-search fixture sequencing', () => {
  it('submits the finite producer only after successful query and second-occurrence preparation', async () => {
    const data = fixture()
    const result = verifyStreamingTerminalSearch(data.win, data.supervisor, 'terminal-1')
    await vi.waitFor(() => expect(data.write).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(data.write).toHaveBeenCalledTimes(1)
    data.prepare()
    await expect(result).resolves.toContain(
      'qualified pre-stream; uninterrupted streaming nominal 50 Hz × 150',
    )
    expect(data.write).toHaveBeenCalledTimes(2)
    expect(data.detach).toHaveBeenCalledOnce()
  })

  it.each(['renderer', 'pty'] as const)(
    'attempts both owned cleanups when %s cleanup fails and retains the original preparation failure',
    async (cleanup) => {
      const data = fixture(true, cleanup)
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const result = verifyStreamingTerminalSearch(
          data.win,
          data.supervisor,
          'terminal-1',
        )
        const rejected = expect(result).rejects.toThrow('query preparation failed')
        await vi.waitFor(() => expect(data.write).toHaveBeenCalledTimes(1))
        data.failPrepare(new Error('query preparation failed'))
        await rejected
        expect(data.write).toHaveBeenCalledTimes(1)
        expect(data.detach).toHaveBeenCalledOnce()
        expect(data.executeJavaScript).toHaveBeenCalledTimes(3)
        expect(diagnostic).toHaveBeenCalledWith(
          '[smoke:terminal-streaming-search-cleanup-failure]',
        )
      } finally {
        diagnostic.mockRestore()
      }
    },
  )

  it('does not submit a producer when real preparation fails and releases its PTY observation', async () => {
    const data = fixture(true)
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = verifyStreamingTerminalSearch(
        data.win,
        data.supervisor,
        'terminal-1',
      )
      const rejected = expect(result).rejects.toThrow('query preparation failed')
      await vi.waitFor(() => expect(data.write).toHaveBeenCalledTimes(1))
      data.failPrepare(new Error('query preparation failed'))
      await rejected
      expect(data.write).toHaveBeenCalledTimes(1)
      expect(data.detach).toHaveBeenCalledOnce()
      expect(diagnostic).toHaveBeenCalledWith(
        '[smoke:terminal-streaming-search-failure]',
        expect.stringContaining('"producerSubmitted":false'),
      )
    } finally {
      diagnostic.mockRestore()
    }
  })
})
