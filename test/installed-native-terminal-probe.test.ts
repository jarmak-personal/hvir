import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInstalledNativeTerminalExercise } from '../scripts/installed-native-terminal-probe.mts'

function installedRenderer(readback = 'HVIR_INSTALLED_NATIVE_OK') {
  let closed = false
  const close = vi.fn(() => {
    closed = true
  })
  const stopStatus = vi.fn()
  const stopQuery = vi.fn()
  let status: (value: { viewId: string; mode: string }) => void = () => undefined
  let update: (value: unknown) => void = () => undefined
  const viewId = '11111111-1111-4111-8111-111111111111'
  const queryId = '22222222-2222-4222-8222-222222222222'
  const canvas = { width: 480, height: 320 }
  const surface = {
    id: `native-terminal-${viewId}`,
    querySelector: () => canvas,
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 480, height: 320 }),
  }
  const pane = { querySelector: () => surface }
  const shell = {
    click: () => status({ viewId, mode: 'native-pixels' }),
    querySelector: () => ({ textContent: 'Shell' }),
  }
  const invoke = vi.fn(
    async (channel: string, request: { kind?: string; input?: unknown }) => {
      // Public IPC completes asynchronously; query updates may precede its reply.
      await Promise.resolve()
      if (channel === 'native-terminal:input') return { requestedMutation: 1 }
      switch (request.kind) {
        case 'begin':
          update({ viewId, queryId, snapshot: { pending: false, matchCount: 1 } })
          return { kind: 'query', queryId, snapshot: { pending: true, matchCount: 0 } }
        case 'at':
          return {
            kind: 'occurrence',
            occurrenceId: '33333333-3333-4333-8333-333333333333',
          }
        case 'read':
          return { kind: 'text', text: readback }
        case 'close':
          return { kind: 'done' }
      }
      throw new Error('unexpected channel')
    },
  )
  const hvir = {
    diagnostics: { processSandboxed: true, contextIsolated: true },
    nativeTerminalPresentation: {
      onStatus: (listener: typeof status) => {
        status = listener
        return stopStatus
      },
    },
    on: (_name: string, listener: typeof update) => {
      update = listener
      return stopQuery
    },
    invoke,
  }
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
    callback()
    return 1
  })
  vi.stubGlobal('hvir', hvir)
  vi.stubGlobal('document', {
    querySelector: (selector: string) =>
      selector === '.native-terminal-pane'
        ? closed
          ? null
          : pane
        : selector.includes('Close terminal')
          ? { click: close }
          : { disabled: false, click: vi.fn() },
    querySelectorAll: () => [shell],
  })
  return { invoke, hvir, close, stopStatus, stopQuery }
}

afterEach(() => vi.unstubAllGlobals())

describe('installed native terminal production exercise', () => {
  it('proves authoritative shell output through public input/query and labels software evidence', async () => {
    const f = installedRenderer()
    expect(JSON.parse(await runInstalledNativeTerminalExercise())).toEqual({
      kind: 'installed-native-terminal',
      passed: true,
      mode: 'native-pixels',
      rendererSandboxed: true,
      contextIsolated: true,
      nativeCanvas: true,
      exactShellReadback: true,
      hardwareGpuQualified: false,
      controlledCapacityQualified: false,
    })
    const paste = f.invoke.mock.calls.find(
      ([, request]) => (request.input as { kind?: string } | undefined)?.kind === 'paste',
    )
    expect((paste?.[1].input as { text: string }).text).not.toContain(
      'HVIR_INSTALLED_NATIVE_OK',
    )
    expect(f.invoke).toHaveBeenCalledWith(
      'native-terminal:query',
      expect.objectContaining({ kind: 'close' }),
    )
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.stopQuery).toHaveBeenCalledOnce()
    expect(f.stopStatus).toHaveBeenCalledOnce()
  })
  it('rejects mismatched retained output while releasing query and subscriptions', async () => {
    const f = installedRenderer('different')
    await expect(runInstalledNativeTerminalExercise()).rejects.toThrow(
      'exact retained readback',
    )
    expect(f.invoke).toHaveBeenCalledWith(
      'native-terminal:query',
      expect.objectContaining({ kind: 'close' }),
    )
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.stopQuery).toHaveBeenCalledOnce()
    expect(f.stopStatus).toHaveBeenCalledOnce()
  })
  it('refuses an unsandboxed renderer before creating a terminal', async () => {
    const f = installedRenderer()
    f.hvir.diagnostics.processSandboxed = false
    await expect(runInstalledNativeTerminalExercise()).rejects.toThrow(
      'renderer isolation',
    )
    expect(f.invoke).not.toHaveBeenCalled()
    expect(f.close).not.toHaveBeenCalled()
  })
})
