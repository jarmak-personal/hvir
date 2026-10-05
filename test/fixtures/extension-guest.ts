import type { ExtensionGuestPorts } from '../../src/main/extensions/guest-capability-ports'
import { ExtensionActionOwner } from '../../src/main/extensions/action-owner'
import { ExtensionPresentationState } from '../../src/main/extensions/presentation-state'
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
/** Explicit test ports expose lifecycle calls and refuse unselected effect capabilities. */
export function guestTestPorts(
  actions: ExtensionGuestPorts['actions'],
  presentationState: ExtensionGuestPorts['presentationState'],
  overrides: Partial<ExtensionGuestPorts> = {},
): ExtensionGuestPorts {
  const unavailable = (): never => {
    throw new Error('Unselected guest test capability')
  }
  return {
    actions,
    presentationState,
    sources: {
      approvals: { status: vi.fn(() => []) },
      select: vi.fn(unavailable),
      read: vi.fn(unavailable),
      render: vi.fn(unavailable),
      asset: vi.fn(unavailable),
      closeView: vi.fn(),
      revalidate: vi.fn(),
    },
    sourceReveal: { reveal: vi.fn(unavailable) },
    connectors: {
      approvals: { status: vi.fn(() => []) },
      execute: vi.fn(unavailable),
      output: vi.fn(unavailable),
      revalidate: vi.fn(),
    },
    deliveries: {
      capture: vi.fn(unavailable),
      manifest: vi.fn(unavailable),
      preview: vi.fn(unavailable),
      apply: vi.fn(unavailable),
      status: vi.fn(unavailable),
      domain: vi.fn(unavailable),
      reconcile: vi.fn(unavailable),
    },
    connectorDemand: vi.fn(() => false),
    updaterFailed: vi.fn(),
    visibleContributionsChanged: vi.fn(),
    updaterSessions: vi.fn(() => []),
    ...overrides,
  }
}

export function fixture(
  overrides: Partial<ExtensionGuestSurfacePort> = {},
  manifest: Record<string, unknown> = {},
  captured?: ReturnType<typeof validateCapturedExtension>,
  portsOverride: Partial<ExtensionGuestPorts> = {},
) {
  const files = new Map([
    [
      'hvir-extension.json',
      new TextEncoder().encode(JSON.stringify(exampleManifest(manifest))),
    ],
    ['index.html', new TextEncoder().encode('original')],
    ['detail.html', new TextEncoder().encode('detail')],
  ])
  const revision = captured ?? validateCapturedExtension({ sourceIdentity: '1:1', files })
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
    foreground: () => true,
    ...overrides,
  }
  const publish = vi.fn()
  const assertWritable = vi.fn(() => Promise.resolve())
  const context = contextFixture()
  const actions: ExtensionActionOwner = new ExtensionActionOwner({
    open: (renderer, installation, contribution, options, admit) =>
      owner.open(renderer, installation, contribution, admit, options),
    dispatch: (view, invocation) => owner.dispatch(view, invocation),
    runnable: (view, id, admitted) => owner.runnable(view, id, admitted),
    cancelAction: (view, id) => owner.cancelAction(view, id),
    assertView: (view) => owner.assertView(view),
  })
  const presentation = new ExtensionPresentationState(
    { read: () => Promise.resolve({}), save: () => Promise.resolve() },
    () => owner.publishValues(),
  )
  const ports = guestTestPorts(actions, presentation, portsOverride)
  const owner: ExtensionGuestOwner = new ExtensionGuestOwner(
    { active, assertWritable },
    scopes,
    surface,
    publish,
    context.contexts,
    ports,
  )
  return {
    owner,
    actions,
    presentation,
    ports,
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
