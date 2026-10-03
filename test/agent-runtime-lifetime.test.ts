import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { AgentApplicationRuntime } from '../src/main/agent/agent-application'
import { ExtensionApplicationRuntime } from '../src/main/extensions/extension-application'
import { LocalHost } from '../src/main/project-host/local-host'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { RendererEventPublisher } from '../src/main/renderer-event-publisher'
import type { PtySupervisor, PtyAgentTarget } from '../src/main/pty/pty-supervisor'
import { localPath } from '../src/shared/host-path'
import { contextFixture } from './fixtures/extension-context'

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] }, shell: {} }))

it('installs startup defaults before storage resolves, keeps inspection independent of package failure and releases/rebinds its stable socket on Off/Enable', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'hvir-agent-lifetime-')),
    host = new LocalHost(),
    context = contextFixture(),
    scopes = new RendererResourceScopes()
  scopes.activateOwner(1)
  const events = new RendererEventPublisher(scopes),
    extensions = new ExtensionApplicationRuntime(scopes, events, localPath(directory)),
    agents = new AgentApplicationRuntime(scopes, events, localPath(directory), extensions)
  let environment:
      | ((target: PtyAgentTarget) => Readonly<Record<string, string>> | undefined)
      | undefined,
    releaseRead: (() => void) | undefined
  const ptys = {
    agentEnvironment: (provider: typeof environment) => {
      environment = provider
      return () => {
        environment = undefined
      }
    },
  } as unknown as PtySupervisor
  const read = host.readTextFilePrefix.bind(host)
  vi.spyOn(host, 'readTextFilePrefix').mockImplementation(async (...args) => {
    if (args[0].path.endsWith('agent-access.json'))
      await new Promise<void>((resolve) => {
        releaseRead = resolve
      })
    return read(...args)
  })
  vi.spyOn(host, 'createDirectoryExclusive').mockRejectedValue(
    new Error('Package storage unavailable'),
  )
  const hosts = {
    local: host,
    hostById: () => host,
    listHosts: () => [],
    materializeHost: () => Promise.resolve(host),
    onHostStateChange: host.onConnectionState.bind(host),
  }
  try {
    const packages = extensions.start(host, context.sources, hosts)
    const startup = agents.start(host, context.sources, hosts, ptys)
    const target = context.sources.ptys.observationSnapshot()[0]!.info
    const defaults = environment!(target)!
    expect(defaults.HVIR_AGENT_WORKSPACE).toBe('workspace')
    expect(defaults.HVIR_AGENT_SESSION).toBe(context.id(1))
    context.change('disconnect')
    expect(environment!(target)).toEqual(defaults)
    const endpoint = defaults.HVIR_AGENT_ENDPOINT!
    await expect(fs.lstat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(agents.access.snapshot().ready).toBe(false)
    releaseRead!()
    await Promise.all([packages, startup])
    expect(extensions.snapshot().writable).toBe(false)
    expect(agents.access.snapshot().ready).toBe(true)
    await agents.configure({ enabled: true, confirmDestructive: false })
    expect((await fs.lstat(endpoint)).isSocket()).toBe(true)
    expect(() =>
      agents.access.admit(new AbortController().signal).current(),
    ).not.toThrow()
    await agents.configure({ enabled: false, confirmDestructive: false })
    await expect(fs.lstat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' })
    await agents.configure({ enabled: true, confirmDestructive: false })
    expect(agents.access.snapshot().endpoint).toBe(endpoint)
    expect((await fs.lstat(endpoint)).isSocket()).toBe(true)
    await agents.dispose()
    await expect(fs.lstat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    releaseRead?.()
    await agents.dispose()
    await extensions.dispose()
    vi.restoreAllMocks()
    await fs.rm(directory, { recursive: true })
    await host.dispose()
  }
})
