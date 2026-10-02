import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ExtensionPresentationState } from '../src/main/extensions/presentation-state'
import { readInstallationState } from '../src/main/extensions/installation-state'
import { extensionInstallationFixture as fixture } from './fixtures/extension-installation'

describe('extension activation and state owner', () => {
  it.each(['truncated', 'oversized', 'invalid shape'] as const)(
    'keeps unrelated installations usable and forgettable with %s presentation cache',
    async (condition) => {
      const data = await fixture(),
        owner = data.make(),
        successor = data.make()
      try {
        await data.packageAt('a')
        await data.packageAt('b', { id: 'other.reference' })
        await owner.start(data.lock)
        for (const source of ['a', 'b'])
          await owner.enable(
            source,
            owner.snapshot().installations.find((entry) => entry.source === source)!
              .revision!,
          )
        await owner.dispose()
        await fs.writeFile(
          join(data.root, 'presentation.json'),
          condition === 'truncated'
            ? '{broken'
            : condition === 'oversized'
              ? 'x'.repeat(256 * 1024 + 1)
              : '[]',
        )
        await successor.start(data.lock)
        const presentation = new ExtensionPresentationState(
          {
            read: () => successor.readPresentation(),
            save: (value, current, signal) =>
              successor.savePresentation(value, current, signal),
          },
          vi.fn(),
        )
        await expect(presentation.restore()).resolves.toBeUndefined()
        expect(successor.active.size).toBe(2)
        const selected = successor
          .snapshot()
          .installations.find((entry) => entry.source === 'a')!
        await expect(
          successor.remove('a', selected.sourceIdentity, true),
        ).resolves.toBeDefined()
        expect(successor.active.size).toBe(1)
        expect(
          successor.snapshot().installations.find((entry) => entry.source === 'b')!
            .enabled,
        ).toBe(true)
        expect(await successor.readPresentation()).toEqual({})
      } finally {
        await Promise.all([owner.dispose(), successor.dispose()])
        await data.dispose()
      }
    },
  )
  it.each([false, true])(
    'keeps presentation and identity together across remove/reinstall/restart (forget=%s)',
    async (forget) => {
      const data = await fixture()
      const owner = data.make((id) => presentation.forget(id))
      const presentation = new ExtensionPresentationState(
        {
          read: () => owner.readPresentation(),
          save: (value, current, signal) =>
            owner.savePresentation(value, current, signal),
        },
        vi.fn(),
      )
      const successor = data.make()
      try {
        const declaration = {
          railItems: [
            {
              id: 'state',
              placement: 'header',
              kind: 'control',
              icon: '◇',
              tooltip: 'Saved state',
              click: { view: 'reference', placement: 'viewer' },
            },
          ],
        }
        await data.packageAt('valid', declaration)
        await fs.writeFile(join(data.root, 'domain-data.txt'), 'User domain data')
        await owner.start(data.lock)
        await presentation.restore()
        await owner.enable('valid', owner.snapshot().installations[0]!.revision!)
        const first = [...owner.active.values()][0]!
        await presentation.publish(
          first,
          { item: 'state', label: 'Saved' },
          () => [],
          () => {
            if (owner.active.get(first.installationId) !== first)
              throw new Error('revoked')
          },
          new AbortController().signal,
        )
        const selected = owner
          .snapshot()
          .installations.find((entry) => entry.source === 'valid')!
        await owner.remove('valid', selected.sourceIdentity, forget)
        expect(presentation.values(first)).toHaveLength(forget ? 0 : 1)
        expect(Object.keys((await owner.readPresentation()) as object)).toHaveLength(
          forget ? 0 : 1,
        )
        await data.packageAt('valid', declaration)
        await owner.discover()
        await owner.enable(
          'valid',
          owner.snapshot().installations.find((entry) => entry.source === 'valid')!
            .revision!,
        )
        const reinstalled = [...owner.active.values()][0]!
        expect(reinstalled.installationId === first.installationId).toBe(!forget)
        await owner.dispose()
        await successor.start(data.lock)
        const restored = new ExtensionPresentationState(
          {
            read: () => successor.readPresentation(),
            save: (value, current, signal) =>
              successor.savePresentation(value, current, signal),
          },
          vi.fn(),
        )
        await restored.restore()
        const active = [...successor.active.values()][0]!
        expect(active.installationId).toBe(reinstalled.installationId)
        expect(restored.values(active)).toEqual(
          forget ? [] : [{ item: 'state', label: 'Saved' }],
        )
        await restored.publish(
          active,
          { item: 'state', label: 'New saved value' },
          () => [],
          () => undefined,
          new AbortController().signal,
        )
        expect(Object.keys((await successor.readPresentation()) as object)).toEqual([
          active.installationId,
        ])
        expect(await fs.readFile(join(data.root, 'domain-data.txt'), 'utf8')).toBe(
          'User domain data',
        )
      } finally {
        await Promise.all([owner.dispose(), successor.dispose()])
        await data.dispose()
      }
    },
  )

  it('cannot resurrect forgotten presentation through an unrelated queued publication', async () => {
    const data = await fixture()
    const owner = data.make((id) => presentation.forget(id))
    const presentation = new ExtensionPresentationState(
      {
        read: () => owner.readPresentation(),
        save: (value, current, signal) => owner.savePresentation(value, current, signal),
      },
      vi.fn(),
    )
    const successor = data.make()
    let finish: (() => void) | undefined
    const write = data.host.writeFile.bind(data.host)
    try {
      const declaration = {
        railItems: [
          {
            id: 'state',
            placement: 'header',
            kind: 'control',
            icon: '◇',
            tooltip: 'State',
            click: { view: 'reference', placement: 'viewer' },
          },
        ],
      }
      await data.packageAt('a', declaration)
      await data.packageAt('b', { ...declaration, id: 'other.reference' })
      await owner.start(data.lock)
      await presentation.restore()
      for (const source of ['a', 'b'])
        await owner.enable(
          source,
          owner.snapshot().installations.find((entry) => entry.source === source)!
            .revision!,
        )
      const a = [...owner.active.values()].find(
        (entry) => entry.revision.manifest.id === 'example.reference',
      )!
      const b = [...owner.active.values()].find(
        (entry) => entry.revision.manifest.id === 'other.reference',
      )!
      for (const active of [a, b])
        await presentation.publish(
          active,
          { item: 'state', label: active === a ? 'A' : 'B' },
          () => [],
          () => undefined,
          new AbortController().signal,
        )
      const saved = vi.spyOn(owner, 'savePresentation')
      const intercepted = vi
        .spyOn(data.host, 'writeFile')
        .mockImplementation(async (path, bytes, options) => {
          if (path.path === join(data.root, 'presentation.json') && !finish)
            await new Promise<void>((resolve) => {
              finish = resolve
            })
          return write(path, bytes, options)
        })
      const removing = owner.remove(
        'a',
        owner.snapshot().installations.find((entry) => entry.source === 'a')!
          .sourceIdentity,
        true,
      )
      await vi.waitFor(() => expect(finish).toBeDefined())
      const publishing = presentation.publish(
        b,
        { item: 'state', label: 'B after forget' },
        () => [],
        () => {
          if (owner.active.get(b.installationId) !== b) throw new Error('B revoked')
        },
        new AbortController().signal,
      )
      await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(1))
      expect(saved.mock.calls[0]![0]).toHaveProperty(a.installationId)
      finish!()
      await Promise.all([removing, publishing])
      intercepted.mockRestore()
      expect(Object.keys((await owner.readPresentation()) as object)).toEqual([
        b.installationId,
      ])
      await owner.dispose()
      await successor.start(data.lock)
      const restored = new ExtensionPresentationState(
        {
          read: () => successor.readPresentation(),
          save: (value, current, signal) =>
            successor.savePresentation(value, current, signal),
        },
        vi.fn(),
      )
      await restored.restore()
      expect(restored.values([...successor.active.values()][0]!)).toEqual([
        { item: 'state', label: 'B after forget' },
      ])
    } finally {
      finish?.()
      vi.restoreAllMocks()
      await Promise.all([owner.dispose(), successor.dispose()])
      await data.dispose()
    }
  })

  it('aborts an unpublished authority-state write on lock replacement and never admits its activation', async () => {
    const data = await fixture()
    const owner = data.make()
    const write = data.host.writeFile.bind(data.host)
    let finish: (() => void) | undefined
    const state = join(data.root, 'state.json')
    const intercepted = vi
      .spyOn(data.host, 'writeFile')
      .mockImplementation(async (path, bytes, options) => {
        if (path.path === state)
          await new Promise<void>((resolve) => {
            finish = resolve
          })
        return write(path, bytes, options)
      })
    try {
      await data.packageAt('valid')
      await owner.start(data.lock)
      const enabling = owner.enable('valid', owner.snapshot().installations[0]!.revision!)
      const refused = expect(enabling).rejects.toThrow()
      await vi.waitFor(() => expect(finish).toBeDefined())
      await fs.rename(data.lock.path, `${data.lock.path}.old`)
      await fs.writeFile(data.lock.path, '')
      await expect(owner.assertWritable()).rejects.toThrow('revoked')
      finish!()
      await refused
      expect(owner.active.size).toBe(0)
      await expect(fs.readFile(state)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      finish?.()
      intercepted.mockRestore()
      await owner.dispose()
      await data.dispose()
    }
  })
  it('keeps the kernel lease until a submitted atomic publication drains, and the successor reads that complete state first', async () => {
    const data = await fixture()
    const owner = data.make(),
      conflict = data.make(),
      successor = data.make()
    const rename = fs.rename.bind(fs)
    let finish: (() => void) | undefined
    const state = join(data.root, 'state.json')
    const submitted = vi
      .spyOn(fs, 'rename')
      .mockImplementation(async (source, destination) => {
        if (destination === state)
          await new Promise<void>((resolve) => {
            finish = resolve
          })
        return rename(source, destination)
      })
    try {
      await data.packageAt('valid')
      await owner.start(data.lock)
      const enabling = owner.enable('valid', owner.snapshot().installations[0]!.revision!)
      const refused = expect(enabling).rejects.toThrow('ownership ended')
      await vi.waitFor(() => expect(finish).toBeDefined())
      const disposing = owner.dispose()
      await conflict.start(data.lock)
      expect(conflict.snapshot().writable).toBe(false)
      await expect(fs.readFile(state)).rejects.toMatchObject({ code: 'ENOENT' })
      finish!()
      await refused
      await disposing
      expect(owner.active.size).toBe(0)
      await successor.start(data.lock)
      expect(successor.active.size).toBe(1)
      expect(
        readInstallationState(JSON.parse(await fs.readFile(state, 'utf8'))).installations,
      ).toHaveLength(1)
    } finally {
      finish?.()
      submitted.mockRestore()
      await Promise.all([owner.dispose(), conflict.dispose(), successor.dispose()])
      await data.dispose()
    }
  })
  it('isolates invalid packages and rejects duplicate package identities without executing discovery', async () => {
    const data = await fixture()
    const owner = data.make()
    try {
      await data.packageAt('valid')
      await data.packageAt('bad', { requiredCapabilities: ['missing.safety'] })
      await owner.start(data.lock)
      const state = owner.snapshot()
      expect(
        state.installations.find((entry) => entry.source === 'bad')?.error,
      ).toContain('missing.safety')
      expect(owner.active.size).toBe(0)
      const valid = state.installations.find((entry) => entry.source === 'valid')!
      await owner.enable('valid', valid.revision!)
      expect(owner.active.size).toBe(1)
      await data.packageAt('duplicate')
      await owner.discover()
      expect(
        owner
          .snapshot()
          .installations.filter((entry) => entry.error?.includes('Duplicate')),
      ).toHaveLength(2)
      expect(owner.active.size).toBe(0)
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
  it('does not admit conflicting instances and reloads persisted state before a successor activates', async () => {
    const data = await fixture()
    const first = data.make(),
      conflict = data.make(),
      successor = data.make()
    try {
      await data.packageAt('valid')
      await first.start(data.lock)
      await conflict.start(data.lock)
      expect(conflict.snapshot().writable).toBe(false)
      await expect(conflict.enable('valid', 'forged')).rejects.toThrow(
        'Another hvir instance',
      )
      const valid = first.snapshot().installations[0]!
      await first.enable('valid', valid.revision!)
      const original = [...first.active.values()][0]!
      await fs.writeFile(join(data.directory, 'valid', 'index.html'), 'external-change')
      await first.discover()
      expect(first.active.size).toBe(0)
      // Even restoring the accepted bytes cannot restore authority after observed edits.
      await fs.writeFile(join(data.directory, 'valid', 'index.html'), 'original')
      await first.dispose()
      await successor.start(data.lock)
      expect(successor.active.size).toBe(0)
      const candidate = successor.snapshot().installations[0]!
      await successor.enable('valid', candidate.revision!)
      const restored = [...successor.active.values()][0]!
      expect(restored.installationId).toBe(original.installationId)
      expect(restored.revision.hash).toBe(original.revision.hash)
      await successor.disable(restored.installationId)
      expect(successor.active.size).toBe(0)
      expect(data.revoke).toHaveBeenCalledWith(restored.installationId)
    } finally {
      await first.dispose()
      await conflict.dispose()
      await successor.dispose()
      await data.dispose()
    }
  })
  it('rejects changed candidates and prevents discovery from activating a reappearing installation', async () => {
    const data = await fixture()
    const owner = data.make()
    try {
      await data.packageAt('valid')
      await owner.start(data.lock)
      const valid = owner.snapshot().installations[0]!
      await fs.writeFile(join(data.directory, 'valid', 'index.html'), 'changed')
      await expect(owner.enable('valid', valid.revision!)).rejects.toThrow('changed')
      await owner.discover()
      await owner.enable('valid', owner.snapshot().installations[0]!.revision!)
      await fs.rename(join(data.directory, 'valid'), join(data.root, 'removed'))
      await owner.discover()
      expect(owner.active.size).toBe(0)
      await data.packageAt('valid')
      await owner.discover()
      expect(owner.active.size).toBe(0)
      expect(owner.snapshot().installations[0]!.enabled).toBe(false)
    } finally {
      await owner.dispose()
      await data.dispose()
    }
  })
})
