import { promises as fs } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { extensionInstallationFixture } from './fixtures/extension-installation'
import { fixture as guestFixture, attached } from './fixtures/extension-guest'
import { sourceFixture } from './fixtures/extension-source'
import { validateCapturedExtension } from '../src/main/extensions/package-store'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { DEFAULT_EXTENSION_PRESENTATION } from '../src/main/extensions/guest-owner'
const root = 'test/fixtures/extensions'
it('retains closed frozen scoped-read/delivery and newer-minor inputs independently of current rebuilds', async () => {
  const inventory = JSON.parse(
    await fs.readFile(join(root, 'contracts-inventory.json'), 'utf8'),
  ) as { files: Record<string, { bytes: number; sha256: string }> }
  for (const [path, expected] of Object.entries(inventory.files)) {
    const bytes = await fs.readFile(join(root, path))
    expect({
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }).toEqual(expected)
  }
})
it('enables actual newer-minor optional input but gates unknown capability, and refuses required safety before guest execution', async () => {
  const data = await extensionInstallationFixture(),
    activation = data.make()
  const optional = JSON.parse(
    await fs.readFile(join(root, 'newer-minor/optional/hvir-extension.json'), 'utf8'),
  ) as Record<string, unknown>
  const prepare = vi.fn(() => Promise.resolve())
  const guest = guestFixture({ prepare }, optional)
  try {
    for (const name of ['optional', 'required'])
      await fs.cp(join(root, 'newer-minor', name), join(data.directory, name), {
        recursive: true,
      })
    await activation.start(data.lock)
    const entry = activation
      .snapshot()
      .installations.find((item) => item.source === 'optional')!
    await activation.enable(entry.source, entry.revision!)
    expect(activation.active.size).toBe(1)
    const enabled = [...activation.active.values()][0]!
    guest.active.set('installation', {
      ...guest.active.get('installation')!,
      revision: enabled.revision,
    })
    const required = activation
      .snapshot()
      .installations.find((item) => item.source === 'required')!
    expect(required.revision).toBeUndefined()
    await expect(activation.enable(required.source, 'unavailable')).rejects.toThrow()
    expect(activation.active.size).toBe(1)
    const view = await attached(guest)
    runInNewContext(
      await fs.readFile(join(root, 'newer-minor/optional/minor.js'), 'utf8'),
      {
        window: {
          hvirExtension: { send: (message: unknown) => guest.owner.receive(10, message) },
        },
      },
    )
    await vi.waitFor(() =>
      expect(guest.sent.some((entry) => entry.message.kind === 'hello')).toBe(true),
    )
    const hello = guest.sent.find((entry) => entry.message.kind === 'hello')!.message
    expect(hello).toMatchObject({ kind: 'hello', contract: '1.0' })
    if (hello.kind !== 'hello') throw new Error('Expected negotiated hello')
    expect(hello.capabilities).not.toContain('future.optional-observation')
    await vi.waitFor(() =>
      expect(guest.sent.filter((item) => item.message.kind === 'result')).toHaveLength(2),
    )
    expect(
      guest.sent.find(
        (item) => item.message.kind === 'result' && item.message.id === 'future',
      )?.message,
    ).toMatchObject({ ok: false })
    expect(
      guest.sent.find(
        (item) => item.message.kind === 'result' && item.message.id === 'known',
      )?.message,
    ).toMatchObject({ ok: true })
    expect(view.contributionId).toBe('reference')
    await expect(
      guest.owner.open(guest.renderer, required.installationId!, 'reference'),
    ).rejects.toThrow()
    expect(prepare).toHaveBeenCalledOnce()
  } finally {
    await guest.owner.dispose()
    await activation.dispose()
    await data.dispose()
  }
})
it.each(['human', 'agent', 'action'] as const)(
  'frozen released scoped read remains confined to current human origin (%s)',
  async (origin) => {
    const manifest = validateExtensionManifest(
      JSON.parse(
        await fs.readFile(join(root, '0.3.0/contracts/skillager-manifest.json'), 'utf8'),
      ),
    ).manifest
    const source = sourceFixture('application', undefined, undefined, manifest)
    await source.approvals.start()
    const prepared = await source.approvals.prepare(
      { installationId: 'installation', source: 'library', root: source.root },
      () => undefined,
    )
    await source.approvals.approve(prepared.token)
    const files = new Map<string, Uint8Array>([
      ['hvir-extension.json', new TextEncoder().encode(JSON.stringify(manifest))],
    ])
    for (const view of manifest.views) files.set(view.entry, new Uint8Array())
    files.set(manifest.updater!, new Uint8Array())
    const guest = guestFixture(
      {},
      {},
      validateCapturedExtension({ sourceIdentity: 'released-scoped-contract', files }),
    )
    source.active.set('installation', guest.active.get('installation')!)
    guest.owner.sources = source.reading
    try {
      const view = await guest.owner.open(
        guest.renderer,
        'installation',
        'library',
        undefined,
        { readingOrigin: origin },
      )
      guest.owner.claim(guest.renderer, view.partition, view.url, view.id)
      guest.owner.bind(guest.renderer, view.partition, 10)
      guest.owner.presentation(
        guest.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        true,
        true,
      )
      guest.owner.receive(10, { kind: 'hello', contract: '1.0' })
      const select = async (id: string) => {
        guest.owner.receive(10, {
          kind: 'request',
          id,
          capability: 'source.select',
          input: { source: 'library', path: source.path },
        })
        await vi.waitFor(() =>
          expect(
            guest.sent.some(
              (item) => item.message.kind === 'result' && item.message.id === id,
            ),
          ).toBe(true),
        )
        return guest.sent.find(
          (item) => item.message.kind === 'result' && item.message.id === id,
        )!.message
      }
      expect(await select('selected')).toMatchObject({ ok: origin === 'human' })
      expect(source.host.readTextFilePrefix).toHaveBeenCalledTimes(
        origin === 'human' ? 1 : 0,
      )
      guest.owner.presentation(
        guest.renderer,
        view.id,
        DEFAULT_EXTENSION_PRESENTATION,
        false,
        false,
      )
      expect(await select('hidden')).toMatchObject({ ok: false })
      expect(source.host.readTextFilePrefix).toHaveBeenCalledTimes(
        origin === 'human' ? 1 : 0,
      )
    } finally {
      await guest.owner.dispose()
      source.dispose()
    }
  },
)
