import { vi } from 'vitest'
import { connectorFixture } from './extension-connector'
import { sourceFixture } from './extension-source'
import { RendererResourceScopes } from '../../src/main/renderer-resource-scopes'
import { ExtensionSetupOwner } from '../../src/main/extensions/extension-setup'
import { localPath, type HostPath } from '../../src/shared/host-path'
import type { ExtensionSetupReview } from '../../src/shared/extensions/setup-review'

export async function setupFixture(remote = false) {
  const program = connectorFixture(remote ? 'workspace' : 'application')
  const source = sourceFixture(
    remote ? 'workspace' : 'application',
    undefined,
    program.host.hostId,
    program.activation.revision.manifest,
  )
  Object.assign(program.activation.revision.manifest, {
    access: [source.declaration],
    connectors: [
      program.activation.revision.manifest.connectors![0]!,
      { ...program.activation.revision.manifest.connectors![0]!, id: 'second' },
    ],
  })
  source.active.set('installation', program.activation)
  await program.approvals.start()
  await source.approvals.start()
  const scopes = new RendererResourceScopes(),
    renderer = scopes.activateOwner(1)
  let visible = true,
    foreground = true,
    agentEnabled = false,
    agentIntent: object | undefined
  let data = {
    schema: 1,
    extension: 'example',
    connectors: ['tool', 'second'].map((connector) => ({
      connector,
      host: String(program.host.hostId),
      executable: '/installed/tool',
      configuration: { args: [], env: {} },
    })),
    sources: [
      {
        source: 'source',
        [remote ? 'workspace' : 'root']: { host: program.host.hostId, path: '/library' },
      },
    ],
  }
  const picker = {
    choose: vi.fn<() => Promise<HostPath | undefined>>(() =>
      Promise.resolve(localPath('/setup.json')),
    ),
    read: vi.fn(() =>
      Promise.resolve({ name: 'setup.json', text: JSON.stringify(data) }),
    ),
  }
  const captureAgentAccess = () => ({
    activation: program.activation,
    enabled: agentEnabled,
    effective: agentEnabled,
    intent: agentIntent,
  })
  const configureAgentAccess = vi.fn(
    (_id: string, enabled: boolean, _prior: unknown, current?: () => void) => {
      current?.()
      agentEnabled = enabled
      agentIntent = {}
      return Promise.resolve()
    },
  )
  const reviews: ExtensionSetupReview[] = []
  const owner = new ExtensionSetupOwner(
    scopes,
    program.authority,
    {
      programs: program.approvals,
      sources: source.approvals,
      activations: { captureAgentAccess, configureAgentAccess },
      hosts: program.hosts,
      contexts: { workspaces: () => source.workspaces },
    },
    picker,
    () => foreground,
    () => visible,
    (_owner, review) => reviews.push(review),
  )
  return {
    program,
    source,
    owner,
    scopes,
    renderer,
    picker,
    reviews,
    configureAgentAccess,
    data: () => data,
    setData: (next: typeof data & { requestAgentAccess?: boolean }) => {
      data = next
    },
    focus: (value: boolean) => {
      foreground = value
      owner.revalidate()
    },
    visible: (value: boolean) => {
      visible = value
      owner.revalidate()
    },
    import: () => owner.import(renderer, 'installation', 'request'),
    apply: () => owner.apply(renderer, 'request'),
    cancel: () => owner.cancel(renderer, 'request'),
    dispose: async () => {
      owner.dispose()
      program.dispose()
      source.dispose()
      await scopes.dispose()
    },
  }
}
