import { expect, vi } from 'vitest'
import {
  ExtensionGuestOwner,
  DEFAULT_EXTENSION_PRESENTATION,
  type ExtensionGuestSurfacePort,
} from '../../src/main/extensions/guest-owner'
import { validateCapturedExtension } from '../../src/main/extensions/package-store'
import { RendererResourceScopes } from '../../src/main/renderer-resource-scopes'
import type { ExtensionReply } from '../../src/shared/extensions/contract'
import { contextFixture } from './extension-context'
import { exampleManifest } from './extension-package'
export function fixture(
  overrides: Partial<ExtensionGuestSurfacePort> = {},
  manifest: Record<string, unknown> = {},
) {
  const files = new Map([
    [
      'hvir-extension.json',
      new TextEncoder().encode(JSON.stringify(exampleManifest(manifest))),
    ],
    ['index.html', new TextEncoder().encode('original')],
    ['detail.html', new TextEncoder().encode('detail')],
  ])
  const revision = validateCapturedExtension({ sourceIdentity: '1:1', files })
  const activation = {
    installationId: 'installation',
    generation: 'generation',
    revision,
  }
  const active = new Map([['installation', activation]])
  const scopes = new RendererResourceScopes()
  const renderer = scopes.activateOwner(1)
  const sent: { guestId: number; message: ExtensionReply }[] = []
  const destroy = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve())
  const surface: ExtensionGuestSurfacePort = {
    prepare: () => Promise.resolve(),
    destroy,
    send: (guestId, message) => sent.push({ guestId, message }),
    visibility: vi.fn(),
    ...overrides,
  }
  const publish = vi.fn()
  const assertWritable = vi.fn(() => Promise.resolve())
  const context = contextFixture()
  const owner = new ExtensionGuestOwner(
    { active, assertWritable },
    scopes,
    surface,
    publish,
    context.contexts,
  )
  return {
    owner,
    context,
    renderer,
    active,
    scopes,
    sent,
    surface,
    publish,
    destroy,
    assertWritable,
  }
}

export async function attached(
  data: ReturnType<typeof fixture>,
  guestId = 10,
  readingOrigin: 'human' | 'agent' | 'action' = 'human',
) {
  const view = await data.owner.open(
    data.renderer,
    'installation',
    'reference',
    () => {},
    { readingOrigin },
  )
  expect(data.owner.claim(data.renderer, view.partition, view.url, view.id)).toEqual(view)
  expect(data.owner.bind(data.renderer, view.partition, guestId)).toEqual(view)
  data.owner.presentation(
    data.renderer,
    view.id,
    DEFAULT_EXTENSION_PRESENTATION,
    true,
    true,
  )
  return view
}
