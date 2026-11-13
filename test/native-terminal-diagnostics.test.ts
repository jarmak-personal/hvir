import { describe, expect, it, vi } from 'vitest'
import type { App } from 'electron'
import { nativeTerminalDiagnostics } from '../src/main/terminal/native-terminal-diagnostics'

vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => 'linux',
}))

function application(info: unknown) {
  return {
    getGPUInfo: vi.fn().mockResolvedValue(info),
    getGPUFeatureStatus: () => ({ gpu_compositing: 'enabled' }),
    commandLine: { getSwitchValue: () => 'wayland' },
  } as unknown as Pick<App, 'getGPUInfo' | 'getGPUFeatureStatus' | 'commandLine'>
}
describe('native terminal qualification diagnostics', () => {
  it('bounds observed device facts and never infers the actual backend from ambient display hints', async () => {
    const facts = await nativeTerminalDiagnostics(
      application({
        driverVersion: 'x'.repeat(1024),
        arbitrary: 'excluded',
        gpuDevice: Array.from({ length: 100 }, () => ({
          vendorId: 4318,
          active: true,
          deviceString: 'y'.repeat(1024),
          private: 'excluded',
        })),
      }),
      { XDG_SESSION_TYPE: 'wayland', DISPLAY: ':0', SECRET: 'excluded' },
    )
    expect(facts.devices).toHaveLength(16)
    expect(facts.devices[0]).toEqual({
      vendorId: 4318,
      active: true,
      deviceString: 'y'.repeat(256),
    })
    expect(facts.electronGpu).toEqual({ driverVersion: 'x'.repeat(256) })
    expect(facts.session['SECRET']).toBeUndefined()
    expect(facts.session['DISPLAY']).toBe(':0')
    expect(facts.actualOzoneBackend).toBe('unknown')
    expect(facts.requestedOzonePlatform).toBe('wayland')
  })
  it('reports missing GPU process information without manufacturing hardware facts', async () => {
    const app = application(undefined)
    vi.mocked(app.getGPUInfo).mockRejectedValueOnce(new Error('GPU unavailable'))
    const facts = await nativeTerminalDiagnostics(app, {})
    expect(facts.gpuInfoAvailable).toBe(false)
    expect(facts.devices).toEqual([])
    expect(facts.electronGpu).toEqual({})
    expect(Object.values(facts.session).every((value) => value === null)).toBe(true)
  })
  it('bounds a nonresponsive GPU-process observer without waiting on the terminal path', async () => {
    vi.useFakeTimers()
    try {
      const app = application(undefined)
      vi.mocked(app.getGPUInfo).mockReturnValueOnce(new Promise(() => undefined))
      const pending = nativeTerminalDiagnostics(app, {})
      await vi.advanceTimersByTimeAsync(1000)
      expect((await pending).gpuInfoAvailable).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('labels a matching explicit successful startup as inference, never a direct backend observation', async () => {
    const inferred = await nativeTerminalDiagnostics(application({}), {
      HVIR_NATIVE_TERMINAL_OZONE: 'wayland',
    })
    expect(inferred.successfulExplicitSelection).toEqual({
      backend: 'wayland',
      basis: 'explicit-switch-and-successful-window-startup',
    })
    expect(inferred.actualOzoneBackend).toBe('unknown')
    const mismatch = await nativeTerminalDiagnostics(application({}), {
      HVIR_NATIVE_TERMINAL_OZONE: 'x11',
    })
    expect(mismatch.successfulExplicitSelection).toBeNull()
  })
})
