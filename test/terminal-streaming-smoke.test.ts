import { runInNewContext } from 'node:vm'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { PtySupervisor } from '../src/main/pty/pty-supervisor'
import { verifyStreamingTerminalSearch } from '../src/main/smoke/terminal-search-streaming'
import { TerminalSearchController } from '../src/renderer/src/terminal/terminal-search-controller'
import type {
  TerminalPane,
  TerminalRetainedBufferRange,
} from '../src/renderer/src/terminal/terminal-pane'

vi.mock('electron', () => ({
  clipboard: { readText: () => 'hvir-streaming-search-match' },
}))
vi.mock('../src/main/smoke/window-focus', () => ({
  focusSmokeWindow: vi.fn(() => Promise.resolve()),
}))

function fixture(
  failing = false,
  cleanup?: 'renderer' | 'pty',
  renderer?: (script: string) => unknown,
) {
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
    .mockImplementationOnce((script: string) => (renderer ? renderer(script) : prepared))
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

/** Execute the real preparation program against its immediate renderer/engine ports.
 * Pixel data is an adapter fake; native Electron owns actual canvas evidence. */
function preparationPort() {
  let now = 0
  let update: (() => void) | undefined
  const matches: TerminalRetainedBufferRange[] = []
  const query = vi.fn()
  const navigate = vi.fn()
  const result = {
    matches,
    pending: false,
    invalidated: false,
    onUpdate: (listener: () => void) => {
      update = listener
      return () => {
        update = undefined
      }
    },
    reveal: (match: TerminalRetainedBufferRange) => matches.includes(match),
    clearReveal: () => {},
    resolve: (match: TerminalRetainedBufferRange) =>
      matches.includes(match) ? match : undefined,
    extract: () => 'hvir-streaming-search-match',
    dispose: () => {},
  }
  const controller = new TerminalSearchController(
    () => {},
    () => Promise.resolve(''),
  )
  controller.bind({
    searchRetainedBuffer: () => Promise.resolve(result),
    cancelRetainedBufferSearch: () => {},
  } as unknown as TerminalPane)
  class Canvas {
    width = 27
    height = 1
    getBoundingClientRect() {
      return { left: 0, top: 0 }
    }
    getContext() {
      const data = new Uint8ClampedArray(this.width * 4)
      for (let x = 0; x < this.width; x++) data[x * 4 + 3] = 255
      return { getImageData: () => ({ data }) }
    }
  }
  const source = new Canvas(),
    highlights = [new Canvas(), new Canvas(), new Canvas()]
  class Input {
    private text = ''
    set value(value: string) {
      this.text = value
    }
    dispatchEvent() {
      query(this.text)
      controller.setQuery(this.text)
    }
  }
  const input = new Input()
  const next = {
    click: () => {
      navigate()
      controller.navigate('next')
    },
  }
  const search = {
    querySelector: (selector: string) => {
      if (selector.includes('Find in terminal')) return input
      if (selector.includes('Next terminal match')) return next
      const snapshot = controller.snapshot()
      return {
        textContent:
          snapshot.matchIndex === undefined
            ? `${snapshot.matchCount} matches`
            : `${snapshot.matchIndex + 1} of ${snapshot.matchCount}`,
      }
    },
  }
  const engine = {
    __hvirTerminalPerformance: { cols: 27, rows: 1 },
    dispatchEvent: () => controller.open(),
    querySelector: (selector: string) =>
      selector === 'canvas' ? source : highlights[controller.snapshot().matchIndex ?? -1],
  }
  const surface = {
    querySelector: (selector: string) =>
      selector === '.terminal-engine-host' ? engine : search,
  }
  return {
    controller,
    query,
    navigate,
    observed: () => update !== undefined,
    populate: (count: number) => {
      for (let i = 0; i < count; i++)
        matches.push({ id: i, start: { row: i, column: 0 }, end: { row: i, column: 27 } })
      update?.()
    },
    run: (script: string) =>
      runInNewContext(script, {
        document: { hasFocus: () => true, querySelector: () => surface },
        navigator: { platform: 'Mac' },
        KeyboardEvent: class {},
        Event: class {},
        HTMLInputElement: Input,
        HTMLCanvasElement: Canvas,
        getComputedStyle: () => ({ visibility: 'visible' }),
        performance: { now: () => now },
        setTimeout: (callback: () => void, delay: number) => {
          now += delay
          return setTimeout(callback, 0)
        },
      }) as Promise<unknown>,
  }
}

describe('native streaming-search fixture sequencing', () => {
  it('navigates newly populated unselected results before submitting the producer', async () => {
    const renderer = preparationPort()
    const data = fixture(false, undefined, renderer.run)
    const submissions: Array<{ count: number; selection?: number; navigations: number }> =
      []
    const write = data.write.getMockImplementation()!
    data.write.mockImplementation(() => {
      if (data.write.mock.calls.length === 2) {
        const state = renderer.controller.snapshot()
        submissions.push({
          count: state.matchCount,
          selection: state.matchIndex,
          navigations: renderer.navigate.mock.calls.length,
        })
      }
      write()
    })
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = verifyStreamingTerminalSearch(
        data.win,
        data.supervisor,
        'terminal-1',
      )
      await vi.waitFor(() => expect(renderer.observed()).toBe(true))
      expect(data.write).toHaveBeenCalledTimes(1)
      renderer.populate(3)
      expect(renderer.controller.snapshot()).toMatchObject({
        matchCount: 3,
        matchIndex: undefined,
      })
      await expect(result).resolves.toContain('qualified pre-stream')
      expect(renderer.query).toHaveBeenCalledOnce()
      expect(submissions).toEqual([{ count: 3, selection: 1, navigations: 2 }])
      expect(data.write).toHaveBeenCalledTimes(2)
      expect(data.detach).toHaveBeenCalledOnce()
      expect(diagnostic).not.toHaveBeenCalled()
    } finally {
      diagnostic.mockRestore()
    }
  })

  it('refuses a different result count without navigation or producer submission', async () => {
    const renderer = preparationPort()
    const data = fixture(true, undefined, renderer.run)
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = verifyStreamingTerminalSearch(
        data.win,
        data.supervisor,
        'terminal-1',
      )
      const rejected = expect(result).rejects.toThrow(
        'initial streaming search did not complete with three matches',
      )
      await vi.waitFor(() => expect(renderer.observed()).toBe(true))
      renderer.populate(4)
      await rejected
      expect(renderer.query).toHaveBeenCalledOnce()
      expect(renderer.navigate).not.toHaveBeenCalled()
      expect(data.write).toHaveBeenCalledTimes(1)
      expect(data.detach).toHaveBeenCalledOnce()
    } finally {
      diagnostic.mockRestore()
    }
  })
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
