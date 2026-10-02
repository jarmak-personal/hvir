import { describe, expect, it, vi } from 'vitest'
import { contextFixture } from './fixtures/extension-context'
import { localPath } from '../src/shared/host-path'
import type { ProjectHost } from '../src/main/project-host/project-host'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { RendererEventPublisher } from '../src/main/renderer-event-publisher'

vi.mock('electron', () => ({
  shell: {},
  app: { commandLine: { getSwitchValue: () => '', appendSwitch: vi.fn() } },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}))
import { ExtensionApplicationRuntime } from '../src/main/extensions/extension-application'

describe('extension application startup containment', () => {
  it('contains missing context sources before creating any runtime or touching storage', async () => {
    const scopes = new RendererResourceScopes(),
      events = new RendererEventPublisher(scopes)
    vi.spyOn(events, 'toWindows').mockImplementation(() => undefined)
    const runtime = new ExtensionApplicationRuntime(scopes, events, localPath('/data'))
    const create = vi.fn()
    await expect(
      runtime.start(
        { createDirectoryExclusive: create } as unknown as ProjectHost,
        undefined as unknown as ReturnType<typeof contextFixture>['sources'],
      ),
    ).resolves.toBeUndefined()
    expect(create).not.toHaveBeenCalled()
    expect(runtime.snapshot().writable).toBe(false)
    expect(runtime.guests).toBeUndefined()
    await runtime.dispose()
  })
  it.each(['creation', 'invalid folder'] as const)(
    'contains %s failure without rejecting ordinary application startup',
    async (condition) => {
      const scopes = new RendererResourceScopes()
      const events = new RendererEventPublisher(scopes)
      const published = vi.spyOn(events, 'toWindows').mockImplementation(() => undefined)
      const runtime = new ExtensionApplicationRuntime(scopes, events, localPath('/data'))
      const host = {
        createDirectoryExclusive: () =>
          condition === 'creation'
            ? Promise.reject(new Error('permission denied'))
            : Promise.resolve(),
        stat: () => Promise.resolve({ type: 'symlink' }),
      } as unknown as ProjectHost
      await expect(runtime.start(host, contextFixture().sources)).resolves.toBeUndefined()
      expect(runtime.snapshot()).toMatchObject({ writable: false, installations: [] })
      expect(runtime.snapshot().explanation).toContain(
        'Check the extensions and extension-state folders',
      )
      expect(published).toHaveBeenCalledWith(
        'extensions:state-changed',
        runtime.snapshot(),
      )
      expect(scopes.activateOwner(42)).toEqual({ id: 42, generation: 1 })
      await runtime.dispose()
      await runtime.dispose()
    },
  )
})
