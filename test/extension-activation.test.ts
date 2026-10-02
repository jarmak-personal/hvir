import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readInstallationState } from '../src/main/extensions/installation-state'
import { extensionInstallationFixture as fixture } from './fixtures/extension-installation'

describe('extension activation and state owner', () => {
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
