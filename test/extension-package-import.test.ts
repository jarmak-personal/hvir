import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { localPath } from '../src/shared/host-path'
import { extensionInstallationFixture } from './fixtures/extension-installation'
import { extensionZip, alterZipCentral } from './fixtures/extension-archive'
import { exampleManifest } from './fixtures/extension-package'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import { ExtensionPackageAdditionOwner } from '../src/main/extensions/package-addition'

async function authored(
  root: string,
  kind: 'zip' | 'directory',
  name = 'authored',
  id = 'example.reference',
) {
  const files = new Map([
    ['hvir-extension.json', Buffer.from(JSON.stringify(exampleManifest({ id })))],
    ['index.html', Buffer.from('authored entry')],
    ['detail.html', Buffer.from('authored detail')],
    ['assets/nested.txt', Buffer.from('nested support')],
  ])
  const path = join(root, kind === 'zip' ? `${name}.zip` : name)
  if (kind === 'zip') await fs.writeFile(path, await extensionZip(files))
  else {
    await fs.mkdir(join(path, 'assets'), { recursive: true })
    for (const [name, bytes] of files) await fs.writeFile(join(path, name), bytes)
  }
  return { source: localPath(path), kind, files }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

describe('Add extension serialized import', () => {
  it.each(['zip', 'directory'] as const)(
    'copies and enables exact %s, preserves source, and reuses retained setup on explicit reinstall',
    async (kind) => {
      const data = await extensionInstallationFixture(),
        owner = data.make()
      try {
        const input = await authored(data.root, kind)
        const source = await fs.stat(input.source.path)
        await owner.start(data.lock)
        const add = () =>
          owner.add(
            () => Promise.resolve(input.source),
            () => undefined,
            new AbortController().signal,
          )
        const first = (await add()).installations[0]!
        expect(first.kind).toBe(kind)
        expect(first.enabled).toBe(true)
        expect(owner.active.size).toBe(1)
        expect(owner.agentAccess()).toEqual([])
        expect(owner.active.get(first.installationId!)?.revision.hash).toBe(
          first.revision,
        )
        expect(await fs.stat(input.source.path)).toMatchObject({
          ino: source.ino,
          size: source.size,
        })
        const imported = await owner.packages.captureSource(
          localPath(join(data.directory, first.source)),
        )
        expect(imported).not.toHaveProperty('archiveBytes')
        for (const [name, bytes] of input.files)
          expect(Buffer.from(imported.files.get(name)!)).toEqual(bytes)
        if (kind === 'zip')
          expect(await fs.readFile(join(data.directory, first.source))).toEqual(
            await fs.readFile(input.source.path),
          )
        const id = owner.snapshot().installations[0]!.installationId!
        await owner.configureAgentAccess(id, true)
        await owner.remove(
          first.source,
          owner.snapshot().installations[0]!.sourceIdentity,
          false,
        )
        const reinstalled = (await add()).installations[0]!
        expect(reinstalled.installationId).toBe(id)
        expect(reinstalled.enabled).toBe(true)
        expect(owner.active.has(id)).toBe(true)
        expect(owner.agentAccess()).toContain(id)
        expect(await fs.readdir(data.packages)).not.toContainEqual(
          expect.stringMatching(/^\.import-/),
        )
      } finally {
        await owner.dispose()
        await data.dispose()
      }
    },
  )
  it('enables only the explicitly imported revision while passive and disabled packages remain inactive', async () => {
    const data = await extensionInstallationFixture(),
      owner = data.make()
    try {
      await data.packageAt('disabled', { id: 'example.disabled' })
      await owner.start(data.lock)
      const disabled = owner.snapshot().installations[0]!
      await owner.enable(disabled.source, disabled.revision!)
      const id = owner.snapshot().installations[0]!.installationId!
      await owner.disable(id)
      await data.packageAt('passive', { id: 'example.passive' })
      const input = await authored(data.root, 'directory')
      const state = await owner.add(
        () => Promise.resolve(input.source),
        () => undefined,
        new AbortController().signal,
      )
      expect(
        state.installations
          .filter((entry) => entry.enabled)
          .map((entry) => entry.manifest?.id),
      ).toEqual(['example.reference'])
      expect(owner.active.size).toBe(1)
      await owner.discover()
      expect(owner.active.size).toBe(1)
      expect(owner.active.has(id)).toBe(false)
      expect(await owner.readConnectorApprovals()).toEqual([])
      expect(await owner.readSourceGrants()).toEqual([])
      expect(owner.agentAccess()).toEqual([])
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it.each(['bytes', 'identity'] as const)(
    'refuses changed imported %s rather than accepting the newly discovered package',
    async (change) => {
      const data = await extensionInstallationFixture(),
        owner = data.make()
      try {
        const input = await authored(data.root, 'directory')
        await owner.start(data.lock)
        const original = data.host.fileTransfer.renameNoReplace.bind(
          data.host.fileTransfer,
        )
        vi.spyOn(data.host.fileTransfer, 'renameNoReplace').mockImplementation(
          async (source, destination, options) => {
            await original(source, destination, options)
            if (change === 'bytes')
              await fs.writeFile(
                join(destination.path, 'index.html'),
                'externally replaced',
              )
            else {
              await fs.rename(destination.path, destination.path + '-retired')
              await fs.cp(destination.path + '-retired', destination.path, {
                recursive: true,
              })
            }
          },
        )
        await expect(
          owner.add(
            () => Promise.resolve(input.source),
            () => undefined,
            new AbortController().signal,
          ),
        ).rejects.toThrow(
          change === 'bytes' ? 'Discover this package again' : 'imported package changed',
        )
        expect(owner.active.size).toBe(0)
        expect((await owner.discover()).installations[0]!.enabled).toBe(false)
        expect(await fs.readFile(join(input.source.path, 'index.html'), 'utf8')).toBe(
          'authored entry',
        )
      } finally {
        vi.restoreAllMocks()
        await owner.dispose()
        await data.dispose()
      }
    },
  )
  it.each(['retain', 'save'] as const)(
    'rejects renderer revocation during acceptance %s without enabling the completed copy',
    async (boundary) => {
      const data = await extensionInstallationFixture(),
        owner = data.make(),
        lifetime = new AbortController()
      try {
        const input = await authored(data.root, 'directory')
        await owner.start(data.lock)
        if (boundary === 'retain') {
          const original = owner.packages.retain.bind(owner.packages)
          vi.spyOn(owner.packages, 'retain').mockImplementation(
            async (revision, signal) => {
              await original(revision, signal)
              lifetime.abort(new Error('Renderer acceptance revoked'))
            },
          )
        } else {
          const original = data.host.writeFile.bind(data.host)
          vi.spyOn(data.host, 'writeFile').mockImplementation(
            async (path, bytes, options) => {
              if (path.path === join(data.root, 'state.json'))
                lifetime.abort(new Error('Renderer acceptance revoked'))
              await original(path, bytes, options)
            },
          )
        }
        await expect(
          owner.add(
            () => Promise.resolve(input.source),
            () => undefined,
            lifetime.signal,
          ),
        ).rejects.toThrow('Renderer acceptance revoked')
        expect(owner.active.size).toBe(0)
        expect((await owner.discover()).installations[0]!.enabled).toBe(false)
        expect(
          await fs.readFile(join(data.directory, 'authored', 'index.html'), 'utf8'),
        ).toBe('authored entry')
        expect(
          await fs.readFile(join(data.root, 'state.json'), 'utf8').catch(() => undefined),
        ).toBeUndefined()
      } finally {
        vi.restoreAllMocks()
        await owner.dispose()
        await data.dispose()
      }
    },
  )
  it('reports committed acceptance when the renderer is revoked after a successful state write, with consistent restart state', async () => {
    const data = await extensionInstallationFixture(),
      owner = data.make(),
      restarted = data.make(),
      lifetime = new AbortController()
    try {
      const input = await authored(data.root, 'directory')
      await owner.start(data.lock)
      const original = data.host.writeFile.bind(data.host)
      vi.spyOn(data.host, 'writeFile').mockImplementation(
        async (path, bytes, options) => {
          await original(path, bytes, options)
          if (path.path === join(data.root, 'state.json'))
            lifetime.abort(new Error('Renderer revoked after committed write'))
        },
      )
      const result = await owner.add(
        () => Promise.resolve(input.source),
        () => undefined,
        lifetime.signal,
      )
      const installed = result.installations[0]!
      expect(lifetime.signal.aborted).toBe(true)
      expect(installed.enabled).toBe(true)
      expect(owner.snapshot()).toEqual(result)
      expect(owner.active.get(installed.installationId!)?.revision.hash).toBe(
        installed.revision,
      )
      expect(
        JSON.parse(await fs.readFile(join(data.root, 'state.json'), 'utf8')),
      ).toMatchObject({
        installations: [
          {
            installationId: installed.installationId,
            revision: installed.revision,
            enabled: true,
            agentAccess: false,
          },
        ],
      })
      expect(await owner.readConnectorApprovals()).toEqual([])
      expect(await owner.readSourceGrants()).toEqual([])
      expect(owner.agentAccess()).toEqual([])
      await owner.dispose()
      await restarted.start(data.lock)
      expect(restarted.snapshot().installations[0]).toMatchObject({
        installationId: installed.installationId,
        revision: installed.revision,
        enabled: true,
      })
      expect(restarted.active.get(installed.installationId!)?.revision.hash).toBe(
        installed.revision,
      )
      expect(restarted.agentAccess()).toEqual([])
    } finally {
      vi.restoreAllMocks()
      await restarted.dispose()
      await owner.dispose()
      await data.dispose()
    }
  })
  it('cancels without capture or installation effects and refuses a second writer before opening the picker', async () => {
    const data = await extensionInstallationFixture(),
      first = data.make(),
      second = data.make()
    try {
      await first.start(data.lock)
      await second.start(data.lock)
      const pick = vi.fn(() => Promise.resolve(undefined))
      expect(
        (await first.add(pick, () => undefined, new AbortController().signal))
          .installations,
      ).toEqual([])
      await expect(
        second.add(pick, () => undefined, new AbortController().signal),
      ).rejects.toThrow('Another hvir instance')
      expect(pick).toHaveBeenCalledTimes(1)
      expect(await fs.readdir(data.directory)).toEqual([])
    } finally {
      await second.dispose()
      await first.dispose()
      await data.dispose()
    }
  })
  it.each(['filename', 'identity'])(
    'refuses an existing %s without replacing or revoking the enabled package',
    async (collision) => {
      const data = await extensionInstallationFixture(),
        owner = data.make()
      try {
        await data.packageAt('existing')
        await owner.start(data.lock)
        const existing = owner.snapshot().installations[0]!
        await owner.enable(existing.source, existing.revision!)
        const active = [...owner.active.values()][0]
        const input = await authored(
          data.root,
          'directory',
          collision === 'filename' ? 'existing' : 'other',
          collision === 'filename' ? 'example.other' : 'example.reference',
        )
        await expect(
          owner.add(
            () => Promise.resolve(input.source),
            () => undefined,
            new AbortController().signal,
          ),
        ).rejects.toThrow(
          collision === 'filename' ? 'filename already exists' : 'identity',
        )
        expect([...owner.active.values()][0]).toBe(active)
        expect(
          await fs.readFile(join(data.directory, 'existing', 'index.html'), 'utf8'),
        ).toBe('original')
        expect(await fs.readdir(data.packages)).not.toContainEqual(
          expect.stringMatching(/^\.import-/),
        )
      } finally {
        await owner.dispose()
        await data.dispose()
      }
    },
  )
  it.each(['missing', 'malformed'] as const)(
    'refuses a live captured identity when its mutable source is %s without replacing its activation',
    async (damage) => {
      const data = await extensionInstallationFixture(),
        owner = data.make()
      try {
        await data.packageAt('existing')
        await owner.start(data.lock)
        const entry = owner.snapshot().installations[0]!
        await owner.enable(entry.source, entry.revision!)
        const current = [...owner.active.values()][0]!
        if (damage === 'missing')
          await fs.rename(join(data.directory, 'existing'), join(data.root, 'old-source'))
        else
          await fs.writeFile(
            join(data.directory, 'existing', 'hvir-extension.json'),
            '{invalid',
          )
        const input = await authored(data.root, 'directory')
        await expect(
          owner.add(
            () => Promise.resolve(input.source),
            () => undefined,
            new AbortController().signal,
          ),
        ).rejects.toThrow('identity is enabled')
        expect(owner.active.get(current.installationId)).toBe(current)
        expect(await fs.readdir(data.packages)).not.toContainEqual(
          expect.stringMatching(/^\.import-/),
        )
        expect(await fs.readdir(data.directory)).not.toContain('authored')
      } finally {
        await owner.dispose()
        await data.dispose()
      }
    },
  )
  it('refuses an already over-capacity folder despite its synthetic scan row', async () => {
    const data = await extensionInstallationFixture(),
      owner = data.make()
    try {
      for (let index = 0; index < 33; index++)
        await fs.mkdir(join(data.directory, `present-${index}`))
      await owner.start(data.lock)
      expect(owner.snapshot().installations).toHaveLength(1)
      const input = await authored(data.root, 'directory')
      await expect(
        owner.add(
          () => Promise.resolve(input.source),
          () => undefined,
          new AbortController().signal,
        ),
      ).rejects.toThrow('Remove an unused package')
      expect(await fs.readdir(data.directory)).toHaveLength(33)
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it.each(['invalid', 'link', 'oversized'])(
    'rejects %s source before any discoverable copy',
    async (invalid) => {
      const data = await extensionInstallationFixture(),
        owner = data.make()
      try {
        const input = await authored(data.root, 'directory')
        if (invalid === 'invalid')
          await fs.writeFile(join(input.source.path, 'hvir-extension.json'), '{}')
        if (invalid === 'oversized')
          await fs.writeFile(
            join(input.source.path, 'too-large'),
            Buffer.alloc(2 * 1024 * 1024 + 1),
          )
        if (invalid === 'link') {
          await fs.symlink(input.source.path, join(data.root, 'selected'))
          input.source = localPath(join(data.root, 'selected'))
        }
        await owner.start(data.lock)
        await expect(
          owner.add(
            () => Promise.resolve(input.source),
            () => undefined,
            new AbortController().signal,
          ),
        ).rejects.toThrow()
        expect(await fs.readdir(data.directory)).toEqual([])
        expect(await fs.readdir(data.packages)).toEqual([])
        expect(await fs.readFile(join(data.root, 'authored', 'index.html'), 'utf8')).toBe(
          'authored entry',
        )
      } finally {
        await owner.dispose()
        await data.dispose()
      }
    },
  )
  it('revokes the renderer during the actual asynchronous picker and rejects its late selection', async () => {
    const data = await extensionInstallationFixture(),
      owner = data.make(),
      scopes = new RendererResourceScopes()
    try {
      await owner.start(data.lock)
      const input = await authored(data.root, 'directory'),
        chosen = deferred<typeof input.source>(),
        entered = deferred<void>()
      const addition = new ExtensionPackageAdditionOwner(scopes, owner, {
        pick: () => {
          entered.resolve()
          return chosen.promise
        },
      })
      const caller = scopes.activateOwner(100)
      const pending = addition.add(caller)
      const rejected = expect(pending).rejects.toThrow()
      await entered.promise
      await scopes.revokeOwner(caller.id)
      await rejected
      chosen.resolve(input.source)
      await chosen.promise
      expect(await fs.readdir(data.directory)).toEqual([])
      expect(await fs.readdir(data.packages)).toEqual([])
    } finally {
      await scopes.dispose()
      await owner.dispose()
      await data.dispose()
    }
  })
  it('allows Disable and writer disposal while the native picker remains open, and rejects a late selection', async () => {
    const data = await extensionInstallationFixture(),
      owner = data.make(),
      replacement = data.make(),
      scopes = new RendererResourceScopes()
    const chosen = deferred<ReturnType<typeof localPath>>()
    try {
      await data.packageAt('existing')
      await owner.start(data.lock)
      const entry = owner.snapshot().installations[0]!
      await owner.enable(entry.source, entry.revision!)
      const id = owner.snapshot().installations[0]!.installationId!
      const entered = deferred<void>()
      const addition = new ExtensionPackageAdditionOwner(scopes, owner, {
        pick: () => {
          entered.resolve()
          return chosen.promise
        },
      })
      const operation = addition.add(scopes.activateOwner(102))
      const rejected = expect(operation).rejects.toThrow()
      await entered.promise
      await owner.disable(id)
      expect(owner.active.size).toBe(0)
      await owner.dispose()
      await rejected
      await replacement.start(data.lock)
      expect(replacement.snapshot().writable).toBe(true)
      const input = await authored(data.root, 'directory', 'late')
      chosen.resolve(input.source)
      await chosen.promise
      expect(await fs.readdir(data.directory)).toEqual(['existing'])
      expect(await fs.readdir(data.packages)).not.toContainEqual(
        expect.stringMatching(/^\.import-/),
      )
    } finally {
      chosen.resolve(localPath(join(data.root, 'unused')))
      await scopes.dispose()
      await replacement.dispose()
      await owner.dispose()
      await data.dispose()
    }
  })
  it('preserves a destination created after preflight and reports the no-replace filename collision', async () => {
    const data = await extensionInstallationFixture(),
      owner = data.make()
    try {
      const input = await authored(data.root, 'directory', 'racing', 'example.new')
      await owner.start(data.lock)
      const original = data.host.fileTransfer.renameNoReplace.bind(data.host.fileTransfer)
      const rename = vi
        .spyOn(data.host.fileTransfer, 'renameNoReplace')
        .mockImplementation(async (source, destination, options) => {
          await fs.mkdir(destination.path)
          await fs.writeFile(
            join(destination.path, 'foreign.txt'),
            'preserve concurrent owner',
          )
          await original(source, destination, options)
        })
      await expect(
        owner.add(
          () => Promise.resolve(input.source),
          () => undefined,
          new AbortController().signal,
        ),
      ).rejects.toThrow('filename already exists')
      rename.mockRestore()
      expect(await fs.readdir(join(data.directory, 'racing'))).toEqual(['foreign.txt'])
      expect(
        await fs.readFile(join(data.directory, 'racing', 'foreign.txt'), 'utf8'),
      ).toBe('preserve concurrent owner')
      expect(await fs.readdir(data.packages)).toEqual([])
    } finally {
      vi.restoreAllMocks()
      await owner.dispose()
      await data.dispose()
    }
  })
  it.each(['cancel', 'changed'])(
    'cleans exact exclusive staging after %s during writes and preserves original source',
    async (failure) => {
      const data = await extensionInstallationFixture(),
        owner = data.make(),
        lifetime = new AbortController()
      try {
        await owner.start(data.lock)
        const input = await authored(data.root, 'directory')
        const original = data.host.fileTransfer.writeFileChunksExclusive.bind(
          data.host.fileTransfer,
        )
        const hook = vi
          .spyOn(data.host.fileTransfer, 'writeFileChunksExclusive')
          .mockImplementation(async (path, chunks, options) => {
            if (failure === 'cancel') {
              await original(
                path,
                (async function* () {
                  for await (const bytes of chunks) {
                    yield bytes.slice(0, Math.max(1, Math.floor(bytes.length / 2)))
                    lifetime.abort(new Error('Renderer import revoked'))
                    yield bytes
                  }
                })(),
                options,
              )
            } else {
              await original(path, chunks, options)
              await fs.writeFile(join(input.source.path, 'index.html'), 'edited')
            }
          })
        await expect(
          owner.add(
            () => Promise.resolve(input.source),
            () => undefined,
            lifetime.signal,
          ),
        ).rejects.toThrow(failure === 'cancel' ? 'revoked' : 'changed')
        hook.mockRestore()
        expect(await fs.readdir(data.directory)).toEqual([])
        expect(await fs.readdir(data.packages)).toEqual([])
        expect((await fs.stat(input.source.path)).isDirectory()).toBe(true)
      } finally {
        await owner.dispose()
        await data.dispose()
      }
    },
  )
  it.each(['before', 'after'] as const)(
    'keeps revocation truthful %s physical no-replace submission',
    async (boundary) => {
      const data = await extensionInstallationFixture(),
        owner = data.make(),
        scopes = new RendererResourceScopes()
      try {
        const input = await authored(data.root, 'directory')
        await owner.start(data.lock)
        const caller = scopes.activateOwner(101),
          entered = deferred<void>(),
          finish = deferred<void>()
        const original = data.host.fileTransfer.renameNoReplace.bind(
          data.host.fileTransfer,
        )
        const rename = vi
          .spyOn(data.host.fileTransfer, 'renameNoReplace')
          .mockImplementation(async (source, destination, options) => {
            if (boundary === 'after') await original(source, destination, options)
            entered.resolve()
            await finish.promise
            if (boundary === 'before') await original(source, destination, options)
          })
        const addition = new ExtensionPackageAdditionOwner(scopes, owner, {
          pick: () => Promise.resolve(input.source),
        })
        const operation = addition.add(caller),
          rejected = expect(operation).rejects.toThrow()
        await entered.promise
        await scopes.revokeOwner(caller.id)
        finish.resolve()
        await rejected
        rename.mockRestore()
        expect(owner.snapshot().installations).toEqual([])
        expect(await fs.readdir(data.directory)).toEqual(
          boundary === 'after' ? ['authored'] : [],
        )
        expect(await fs.readdir(data.packages)).toEqual([])
        if (boundary === 'after') {
          const observed = (await owner.discover()).installations[0]!
          expect(observed.enabled).toBe(false)
          expect(observed.manifest?.id).toBe('example.reference')
        }
      } finally {
        await scopes.dispose()
        await owner.dispose()
        await data.dispose()
      }
    },
  )
  it('fences writer loss during staging and settles without publishing a candidate', async () => {
    const data = await extensionInstallationFixture(),
      owner = data.make()
    try {
      const input = await authored(data.root, 'directory')
      await owner.start(data.lock)
      const original = data.host.fileTransfer.writeFileChunksExclusive.bind(
        data.host.fileTransfer,
      )
      const hook = vi
        .spyOn(data.host.fileTransfer, 'writeFileChunksExclusive')
        .mockImplementation(async (path, chunks, options) => {
          await original(path, chunks, options)
          await fs.rename(data.lock.path, `${data.lock.path}.retired`)
          await fs.writeFile(data.lock.path, '')
        })
      await expect(
        owner.add(
          () => Promise.resolve(input.source),
          () => undefined,
          new AbortController().signal,
        ),
      ).rejects.toThrow('revoked')
      hook.mockRestore()
      expect(owner.snapshot().writable).toBe(false)
      expect(await fs.readdir(data.directory)).toEqual([])
      expect(await fs.readdir(data.packages)).toEqual([])
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it('refuses changed ZIP bytes even when the validated assets and source inode are unchanged', async () => {
    const data = await extensionInstallationFixture(),
      owner = data.make()
    try {
      const input = await authored(data.root, 'zip')
      await owner.start(data.lock)
      const original = data.host.fileTransfer.writeFileChunksExclusive.bind(
        data.host.fileTransfer,
      )
      const hook = vi
        .spyOn(data.host.fileTransfer, 'writeFileChunksExclusive')
        .mockImplementation(async (path, chunks, options) => {
          await original(path, chunks, options)
          const changed = alterZipCentral(
            await fs.readFile(input.source.path),
            (header) => {
              header.writeUInt16LE(header.readUInt16LE(12) ^ 1, 12)
            },
          )
          await fs.writeFile(input.source.path, changed)
        })
      await expect(
        owner.add(
          () => Promise.resolve(input.source),
          () => undefined,
          new AbortController().signal,
        ),
      ).rejects.toThrow('selected package changed')
      hook.mockRestore()
      expect(await fs.readdir(data.packages)).toEqual([])
      expect(await fs.readdir(data.directory)).toEqual([])
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it('retains the original failure and exact staging repair location when an unexpected entry prevents safe cleanup', async () => {
    const data = await extensionInstallationFixture(),
      owner = data.make(),
      lifetime = new AbortController()
    try {
      const input = await authored(data.root, 'directory')
      await owner.start(data.lock)
      const original = data.host.fileTransfer.writeFileChunksExclusive.bind(
        data.host.fileTransfer,
      )
      const hook = vi
        .spyOn(data.host.fileTransfer, 'writeFileChunksExclusive')
        .mockImplementation(async (path, chunks, options) => {
          await original(path, chunks, options)
          await fs.writeFile(
            join(
              data.packages,
              (await fs.readdir(data.packages)).find((name) =>
                name.startsWith('.import-'),
              )!,
              'unexpected',
            ),
            'preserve foreign bytes',
          )
          lifetime.abort(new Error('Original import revocation'))
        })
      await expect(
        owner.add(
          () => Promise.resolve(input.source),
          () => undefined,
          lifetime.signal,
        ),
      ).rejects.toThrow(
        /Original import revocation.*Staging cleanup needs attention at .*\.import-/,
      )
      hook.mockRestore()
      const staging = (await fs.readdir(data.packages)).find((name) =>
        name.startsWith('.import-'),
      )!
      expect(await fs.readFile(join(data.packages, staging, 'unexpected'), 'utf8')).toBe(
        'preserve foreign bytes',
      )
      expect(await fs.readdir(data.directory)).toEqual([])
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it('collects bounded interrupted hidden import under the next writer, without discovering or enabling it', async () => {
    const data = await extensionInstallationFixture(),
      owner = data.make()
    try {
      const stage = join(data.packages, '.import-11111111-1111-1111-1111-111111111111')
      await fs.mkdir(stage)
      await fs.writeFile(join(stage, 'partial.zip'), 'partial')
      await owner.start(data.lock)
      expect(await fs.readdir(data.packages)).toEqual([])
      expect(owner.snapshot().installations).toEqual([])
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
})
