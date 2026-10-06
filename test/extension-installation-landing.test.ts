import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import type { ExtensionView } from '../src/shared/extensions/workbench'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { ExtensionPackageAdditionOwner } from '../src/main/extensions/package-addition'
import type { ExtensionGuestOwner } from '../src/main/extensions/guest-owner'
import { prepareInstallationLanding } from '../src/main/extensions/installation-landing'
import { extensionInstallationFixture } from './fixtures/extension-installation'
import { exampleManifest } from './fixtures/extension-package'
import { extensionZip } from './fixtures/extension-archive'

async function fixture(kind: 'directory' | 'zip', landing: unknown = 'detail') {
  const data = await extensionInstallationFixture()
  const activations = data.make()
  const scopes = new RendererResourceScopes()
  const owner = scopes.activateOwner(12)
  const manifest = exampleManifest({ ...(landing === 'absent' ? {} : { landing }) })
  const files = new Map([
    ['hvir-extension.json', Buffer.from(JSON.stringify(manifest))],
    ['index.html', Buffer.from('index')],
    ['detail.html', Buffer.from('detail')],
  ])
  const source = join(data.root, kind === 'zip' ? 'authored.zip' : 'authored')
  if (kind === 'zip') await fs.writeFile(source, await extensionZip(files))
  else {
    await fs.mkdir(source)
    for (const [name, bytes] of files) await fs.writeFile(join(source, name), bytes)
  }
  await activations.start(data.lock)
  const close = vi.fn(() => Promise.resolve())
  let reused = false
  const open = vi.fn<ExtensionGuestOwner['open']>(
    (_owner, installationId, contributionId, admit = () => {}, options = {}) => {
      admit()
      const view = {
        id: 'prepared',
        installationId,
        contributionId,
        extensionName: 'Reference',
        title: 'Detail',
        partition: 'owned-partition',
        url: 'hvir-extension://prepared/detail.html',
        context: { ...options.context, visible: false },
        role: 'view',
      } as ExtensionView
      if (!reused) options.onCreated?.(view)
      return Promise.resolve(view)
    },
  )
  let foreground = true
  const connected = vi.fn<
    NonNullable<ConstructorParameters<typeof ExtensionPackageAdditionOwner>[3]>
  >(() =>
    Promise.resolve({
      connections: [{ connector: 'tool', outcome: 'unavailable' as const }],
    }),
  )
  const addition = new ExtensionPackageAdditionOwner(
    scopes,
    activations,
    { pick: () => Promise.resolve(localPath(source)) },
    connected,
    (activation, source, caller, current, signal) =>
      prepareInstallationLanding(
        activations,
        { open, close },
        activation,
        source,
        caller,
        current,
        signal,
      ),
    () => foreground,
  )
  return {
    ...data,
    activations,
    scopes,
    owner,
    addition,
    connected,
    open,
    close,
    reuse: () => {
      reused = true
    },
    background: () => {
      foreground = false
    },
    dispose: async () => {
      await scopes.dispose()
      await activations.dispose()
      await data.dispose()
    },
  }
}

describe('exact explicit installation landing preparation', () => {
  it.each(['none', 'declined'] as const)(
    'prepares ordinary landing after %s program connection',
    async (outcome) => {
      const data = await fixture('directory')
      data.connected.mockResolvedValue({
        connections:
          outcome === 'none' ? [] : [{ connector: 'tool', outcome: 'declined' }],
      })
      try {
        expect(
          (await data.addition.add(data.owner)).installed?.landing?.contributionId,
        ).toBe('detail')
        expect(await data.activations.readConnectorApprovals()).toEqual([])
      } finally {
        await data.dispose()
      }
    },
  )
  it.each(['directory', 'zip'] as const)(
    'returns the exact %s receipt and declared view after unavailable connection, without selecting',
    async (kind) => {
      const data = await fixture(kind)
      try {
        const result = await data.addition.add(data.owner, 'request')
        const installed = [...data.activations.active.values()][0]!
        expect(result.installed).toEqual({
          installationId: installed.installationId,
          landing: expect.objectContaining({
            contributionId: 'detail',
            installationId: installed.installationId,
          }) as unknown,
        })
        expect(result.connection?.connections[0]?.outcome).toBe('unavailable')
        expect(data.connected.mock.invocationCallOrder[0]).toBeLessThan(
          data.open.mock.invocationCallOrder[0]!,
        )
        expect(data.open).toHaveBeenCalledWith(
          data.owner,
          installed.installationId,
          'detail',
          expect.any(Function),
          {
            context: { surface: 'viewer' },
            select: false,
            focus: false,
            onCreated: expect.any(Function) as unknown,
          },
        )
        expect(result.installed).not.toHaveProperty('generation')
        expect(result.installed).not.toHaveProperty('revision')
        expect(data.activations.agentAccess()).toEqual([])
        expect(await data.activations.readSourceGrants()).toEqual([])
        expect(await data.activations.readConnectorApprovals()).toEqual([])
      } finally {
        await data.dispose()
      }
    },
  )
  it('uses the existing top placement only for its declared top view', async () => {
    const data = await fixture('directory', 'reference')
    try {
      const source = join(data.root, 'authored', 'hvir-extension.json')
      const manifest = JSON.parse(await fs.readFile(source, 'utf8')) as {
        views: { navigation?: string }[]
      }
      manifest.views[0]!.navigation = 'top'
      await fs.writeFile(source, JSON.stringify(manifest))
      expect(
        (await data.addition.add(data.owner)).installed?.landing?.context?.surface,
      ).toBe('top')
    } finally {
      await data.dispose()
    }
  })
  it('does not guess a landing from available views when no declaration exists', async () => {
    const data = await fixture('zip', 'absent')
    try {
      expect((await data.addition.add(data.owner)).installed).toEqual({
        installationId: expect.any(String) as unknown,
      })
      expect(data.open).not.toHaveBeenCalled()
    } finally {
      await data.dispose()
    }
  })
  it.each(['missing', '../detail.html', 42])(
    'rejects %j before installation or preparation',
    async (landing) => {
      const data = await fixture('directory', landing)
      try {
        await expect(data.addition.add(data.owner)).rejects.toThrow()
        expect(data.activations.active.size).toBe(0)
        expect(data.open).not.toHaveBeenCalled()
        expect(await fs.readdir(data.directory)).toEqual([])
      } finally {
        await data.dispose()
      }
    },
  )
  it.each([
    'reuse-cancel',
    'cancel',
    'disable',
    'revision',
    'renderer',
    'writer',
    'background',
    'source-bytes',
    'source-identity',
  ] as const)(
    'rejects late preparation after %s and drains its ordinary view',
    async (ending) => {
      const data = await fixture('directory')
      if (ending === 'reuse-cancel') data.reuse()
      let entered!: () => void, finish!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const pending = new Promise<void>((resolve) => {
        finish = resolve
      })
      const original = data.open.getMockImplementation()!
      data.open.mockImplementation(async (...args) => {
        const view = await original(...args)
        entered()
        await pending
        return view
      })
      try {
        const result = data.addition.add(data.owner, 'request')
        await started
        const installed = [...data.activations.active.values()][0]!
        const row = data.activations
          .snapshot()
          .installations.find(
            (entry) => entry.installationId === installed.installationId,
          )!
        const source = join(data.directory, row.source)
        if (ending === 'cancel' || ending === 'reuse-cancel')
          data.addition.cancelSetup(data.owner, 'request')
        if (ending === 'disable') await data.activations.disable(installed.installationId)
        if (ending === 'revision')
          data.activations.active.set(installed.installationId, {
            ...installed,
            generation: 'replacement',
          })
        if (ending === 'renderer') await data.scopes.revokeOwner(data.owner.id)
        if (ending === 'writer') await data.activations.dispose()
        if (ending === 'background') data.background()
        if (ending === 'source-bytes')
          await fs.writeFile(join(source, 'detail.html'), 'changed')
        if (ending === 'source-identity') {
          await fs.rename(source, source + '-retired')
          await fs.cp(source + '-retired', source, { recursive: true })
        }
        finish()
        expect((await result).installed).toEqual({
          installationId: installed.installationId,
        })
        if (ending === 'reuse-cancel') expect(data.close).not.toHaveBeenCalled()
        else expect(data.close).toHaveBeenCalledExactlyOnceWith(data.owner, 'prepared')
      } finally {
        finish()
        await data.dispose()
      }
    },
  )
})
