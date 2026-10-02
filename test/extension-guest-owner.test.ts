import {
  MAX_FONT_FAMILY_LENGTH,
  MAX_INTERFACE_FONT_STACK_LENGTH,
} from '../src/shared/interface-typography'
import { fontFamilyStack } from '../src/renderer/src/settings/typography-settings'
import { describe, expect, it, vi } from 'vitest'
import {
  ExtensionGuestOwner,
  DEFAULT_EXTENSION_PRESENTATION,
  type ExtensionGuestSurfacePort,
} from '../src/main/extensions/guest-owner'
import { validateCapturedExtension } from '../src/main/extensions/package-store'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import type { ExtensionReply } from '../src/shared/extensions/contract'
import { exampleManifest } from './fixtures/extension-package'

function fixture(overrides: Partial<ExtensionGuestSurfacePort> = {}) {
  const files = new Map([
    ['hvir-extension.json', new TextEncoder().encode(JSON.stringify(exampleManifest()))],
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
  const owner = new ExtensionGuestOwner(
    { active, assertWritable },
    scopes,
    surface,
    publish,
  )
  return {
    owner,
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

async function attached(data: ReturnType<typeof fixture>, guestId = 10) {
  const view = await data.owner.open(data.renderer, 'installation', 'reference')
  expect(data.owner.claim(data.renderer, view.partition, view.url, view.id)).toEqual(view)
  expect(data.owner.bind(data.renderer, view.partition, guestId)).toEqual(view)
  data.owner.presentation(data.renderer, view.id, DEFAULT_EXTENSION_PRESENTATION, true)
  return view
}

describe('extension guest capability and lifetime owner', () => {
  it('reapplies hidden intent only for the exact current physical guest and activation', async () => {
    const visibility = vi.fn()
    const data = fixture({ visibility })
    const view = await attached(data)
    visibility.mockClear()
    data.owner.nativeVisibilityChanged(99)
    data.owner.nativeVisibilityChanged(10)
    expect(visibility).not.toHaveBeenCalled()
    data.owner.presentation(data.renderer, view.id, DEFAULT_EXTENSION_PRESENTATION, false)
    visibility.mockClear()
    data.owner.nativeVisibilityChanged(10)
    expect(visibility.mock.calls).toEqual([[10, false]])
    const activation = data.active.get('installation')!
    data.active.set('installation', { ...activation, generation: 'replacement' })
    data.owner.nativeVisibilityChanged(10)
    expect(visibility).toHaveBeenCalledTimes(1)
    data.active.set('installation', activation)
    await data.scopes.revokeOwner(data.renderer.id)
    data.scopes.activateOwner(data.renderer.id)
    data.owner.nativeVisibilityChanged(10)
    expect(visibility).toHaveBeenCalledTimes(1)
    await data.owner.dispose()
    data.owner.nativeVisibilityChanged(10)
    expect(visibility).toHaveBeenCalledTimes(1)
  })
  it('ignores native visibility from a failed or closed guest', async () => {
    const visibility = vi.fn()
    const data = fixture({ visibility })
    const view = await attached(data)
    data.owner.presentation(data.renderer, view.id, DEFAULT_EXTENSION_PRESENTATION, false)
    visibility.mockClear()
    data.owner.failed(10)
    data.owner.nativeVisibilityChanged(10)
    await data.owner.close(data.renderer, view.id)
    data.owner.nativeVisibilityChanged(10)
    expect(visibility).not.toHaveBeenCalled()
    await data.owner.dispose()
  })
  it('accepts the longest escaped Settings font stack and applies visibility even for rejected presentation', async () => {
    const visibility = vi.fn()
    const data = fixture({ visibility })
    const view = await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    const fontFamily = fontFamilyStack(
      { mode: 'custom', family: '\\'.repeat(MAX_FONT_FAMILY_LENGTH) },
      'interface',
    )
    expect(fontFamily.length).toBe(MAX_INTERFACE_FONT_STACK_LENGTH)
    data.owner.presentation(
      data.renderer,
      view.id,
      { ...DEFAULT_EXTENSION_PRESENTATION, fontFamily },
      true,
    )
    expect(data.sent.at(-1)).toMatchObject({
      message: { kind: 'presentation', presentation: { fontFamily } },
    })
    expect(() =>
      data.owner.presentation(
        data.renderer,
        view.id,
        {
          ...DEFAULT_EXTENSION_PRESENTATION,
          fontFamily: 'x'.repeat(MAX_INTERFACE_FONT_STACK_LENGTH + 1),
        },
        false,
      ),
    ).toThrow('interface font')
    expect(visibility).toHaveBeenLastCalledWith(10, false)
    await data.owner.dispose()
  })
  it('retains only the latest hidden presentation and publishes it on selection', async () => {
    const data = fixture()
    const view = await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.sent.length = 0
    for (const fontSize of [14, 15, 16])
      data.owner.presentation(
        data.renderer,
        view.id,
        { ...DEFAULT_EXTENSION_PRESENTATION, fontSize },
        false,
      )
    expect(data.sent).toEqual([])
    data.owner.presentation(
      data.renderer,
      view.id,
      { ...DEFAULT_EXTENSION_PRESENTATION, fontSize: 16 },
      true,
    )
    expect(data.sent).toEqual([
      {
        guestId: 10,
        message: {
          kind: 'presentation',
          presentation: { ...DEFAULT_EXTENSION_PRESENTATION, fontSize: 16 },
        },
      },
    ])
    await data.owner.dispose()
  })
  it('bounds views per extension and requests per view and extension without queuing excess work', async () => {
    const data = fixture()
    await attached(data)
    const detail = await data.owner.open(data.renderer, 'installation', 'detail')
    data.owner.claim(data.renderer, detail.partition, detail.url, detail.id)
    data.owner.bind(data.renderer, detail.partition, 11)
    data.owner.presentation(
      data.renderer,
      detail.id,
      DEFAULT_EXTENSION_PRESENTATION,
      true,
    )
    const otherRenderer = data.scopes.activateOwner(2)
    const third = await data.owner.open(otherRenderer, 'installation', 'reference')
    data.owner.claim(otherRenderer, third.partition, third.url, third.id)
    data.owner.bind(otherRenderer, third.partition, 12)
    data.owner.presentation(otherRenderer, third.id, DEFAULT_EXTENSION_PRESENTATION, true)
    await data.owner.open(data.scopes.activateOwner(3), 'installation', 'reference')
    await expect(
      data.owner.open(data.scopes.activateOwner(4), 'installation', 'reference'),
    ).rejects.toThrow('Close an extension view')
    for (const guestId of [10, 11, 12])
      data.owner.receive(guestId, { kind: 'hello', contract: '1.0' })
    let finish: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    data.assertWritable.mockImplementation(() => pending)
    for (const guestId of [10, 11])
      for (let index = 0; index < 8; index++) {
        data.owner.receive(guestId, {
          kind: 'request',
          id: `pending-${index}`,
          capability: 'presentation.read',
        })
      }
    data.owner.receive(10, {
      kind: 'request',
      id: 'view-overflow',
      capability: 'presentation.read',
    })
    data.owner.receive(12, {
      kind: 'request',
      id: 'extension-overflow',
      capability: 'presentation.read',
    })
    expect(data.sent.slice(-2).map((entry) => entry.message)).toEqual([
      expect.objectContaining({
        id: 'view-overflow',
        ok: false,
        error: 'Extension request capacity is full',
      }),
      expect.objectContaining({
        id: 'extension-overflow',
        ok: false,
        error: 'Extension request capacity is full',
      }),
    ])
    finish!()
    await vi.waitFor(() =>
      expect(
        data.sent.filter((entry) => entry.message.kind === 'result' && entry.message.ok),
      ).toHaveLength(16),
    )
    await data.owner.dispose()
  })
  it('does not publish or attach a pending surface through a concurrent duplicate Open', async () => {
    let finish: (() => void) | undefined
    const data = fixture({
      prepare: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    const opening = data.owner.open(data.renderer, 'installation', 'reference')
    await vi.waitFor(() => expect(finish).toBeDefined())
    await expect(
      data.owner.open(data.renderer, 'installation', 'reference'),
    ).rejects.toThrow('opening')
    expect(data.owner.snapshot(data.renderer)).toEqual([])
    expect(data.publish).not.toHaveBeenCalled()
    finish!()
    await opening
    expect(data.owner.snapshot(data.renderer)).toHaveLength(1)
    await data.owner.dispose()
  })
  it('binds one exact attachment and ignores forged guest/view/approval identity fields', async () => {
    const data = fixture()
    const view = await attached(data)
    expect(
      data.owner.claim(data.renderer, view.partition, view.url, view.id),
    ).toBeUndefined()
    expect(data.owner.bind(data.renderer, view.partition, 99)).toBeUndefined()
    data.owner.receive(99, {
      kind: 'hello',
      contract: '1.0',
      viewId: view.id,
      userApproved: true,
    })
    expect(data.sent).toEqual([])
    data.owner.receive(10, { kind: 'hello', contract: '1.0', userApproved: true })
    expect(data.sent.at(-1)?.message).toMatchObject({
      kind: 'hello',
      capabilities: ['presentation.read', 'viewer.open-own'],
      warnings: ['Ignored unknown field: userApproved'],
    })
    data.owner.receive(10, {
      kind: 'request',
      id: 'ungranted',
      capability: 'project.read',
      input: { userApproved: true, host: 'all' },
    })
    expect(data.sent.at(-1)?.message).toMatchObject({
      kind: 'result',
      id: 'ungranted',
      ok: false,
    })
  })
  it('requires negotiation and confines view targets to its accepted declarations', async () => {
    const data = fixture()
    await attached(data)
    data.owner.receive(10, {
      kind: 'request',
      id: 'early',
      capability: 'viewer.open-own',
      input: { contributionId: 'detail' },
    })
    expect(data.sent.at(-1)?.message).toMatchObject({
      ok: false,
      error: 'Negotiate before requesting a capability',
    })
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.owner.receive(10, {
      kind: 'request',
      id: 'other',
      capability: 'viewer.open-own',
      input: { contributionId: 'elsewhere' },
    })
    await vi.waitFor(() =>
      expect(data.sent.at(-1)?.message).toMatchObject({ id: 'other', ok: false }),
    )
    data.owner.receive(10, {
      kind: 'request',
      id: 'own',
      capability: 'viewer.open-own',
      input: { contributionId: 'detail', installationId: 'other', approved: true },
    })
    await vi.waitFor(() =>
      expect(data.sent.at(-1)?.message).toMatchObject({ id: 'own', ok: true }),
    )
    expect(data.owner.snapshot(data.renderer).map((view) => view.contributionId)).toEqual(
      ['reference', 'detail'],
    )
  })
  it('refuses hidden refresh and bounds message rate independently of the guest preload', async () => {
    const data = fixture()
    const view = await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.owner.presentation(data.renderer, view.id, DEFAULT_EXTENSION_PRESENTATION, false)
    data.owner.receive(10, {
      kind: 'request',
      id: 'hidden',
      capability: 'presentation.read',
    })
    expect(data.sent.at(-1)?.message).toMatchObject({ id: 'hidden', ok: false })
    for (let index = 0; index < 31; index++)
      data.owner.receive(10, { kind: 'cancel', id: `cancel-${index}` })
    expect(data.owner.snapshot(data.renderer)[0]?.failure).toContain('stopped')
    await data.owner.close(data.renderer, view.id)
    expect(data.owner.snapshot(data.renderer)).toEqual([])
    expect(data.destroy).toHaveBeenCalled()
  })
  it('reclaims guest capacity after close and rejects late preparation after disable', async () => {
    let finish: (() => void) | undefined
    const data = fixture({
      prepare: () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    })
    const opening = data.owner.open(data.renderer, 'installation', 'reference')
    await vi.waitFor(() => expect(finish).toBeDefined())
    data.active.clear()
    data.owner.revokeInstallation('installation')
    finish!()
    await expect(opening).rejects.toThrow('revoked')
    expect(data.owner.snapshot(data.renderer)).toEqual([])
    expect(data.destroy).toHaveBeenCalledOnce()
  })
  it('revokes all renderer descendants before late capability completion and rejects reused generations', async () => {
    const data = fixture()
    const view = await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    await data.scopes.rolloverOwner(data.renderer.id).cleanup
    expect(data.owner.snapshot(data.renderer)).toEqual([])
    expect(data.sent.at(-1)?.message).toEqual({ kind: 'revoked' })
    data.owner.receive(10, {
      kind: 'request',
      id: 'late',
      capability: 'presentation.read',
    })
    expect(
      data.sent.some(
        (entry) => entry.message.kind === 'result' && entry.message.id === 'late',
      ),
    ).toBe(false)
    expect(
      data.owner.claim(data.renderer, view.partition, view.url, view.id),
    ).toBeUndefined()
    await data.owner.dispose()
    await data.owner.dispose()
    expect(data.destroy).toHaveBeenCalledOnce()
  })
  it('cancelled requests cannot open late views', async () => {
    let finish: (() => void) | undefined
    let prepares = 0
    const data = fixture({
      prepare: () =>
        ++prepares === 1
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              finish = resolve
            }),
    })
    await attached(data)
    data.owner.receive(10, { kind: 'hello', contract: '1.0' })
    data.owner.receive(10, {
      kind: 'request',
      id: 'cancel-me',
      capability: 'viewer.open-own',
      input: { contributionId: 'detail' },
    })
    await vi.waitFor(() => expect(finish).toBeDefined())
    data.owner.receive(10, { kind: 'cancel', id: 'cancel-me' })
    finish!()
    await vi.waitFor(() =>
      expect(
        data.owner.snapshot(data.renderer).map((view) => view.contributionId),
      ).toEqual(['reference']),
    )
    expect(
      data.sent.some(
        (entry) => entry.message.kind === 'result' && entry.message.id === 'cancel-me',
      ),
    ).toBe(false)
  })
  it('renderer revocation waits for its actual per-view disposal receipt without draining another owner', async () => {
    const receipts = new Map<string, { promise: Promise<void>; finish: () => void }>()
    const data = fixture({
      destroy: (id) => {
        let finish!: () => void
        const promise = new Promise<void>((resolve) => {
          finish = resolve
        })
        receipts.set(id, { promise, finish })
        return promise
      },
    })
    const first = await attached(data)
    const other = data.scopes.activateOwner(2)
    const second = await data.owner.open(other, 'installation', 'reference')
    const closingOther = data.owner.close(other, second.id)
    expect(data.owner.close(other, second.id)).toBe(closingOther)
    const revoked = data.scopes.rolloverOwner(data.renderer.id)
    expect(data.owner.snapshot(data.renderer)).toEqual([])
    expect(data.sent.at(-1)?.message).toEqual({ kind: 'revoked' })
    let complete = false
    void revoked.cleanup.then(() => {
      complete = true
    })
    await Promise.resolve()
    expect(complete).toBe(false)
    receipts.get(first.id)!.finish()
    await revoked.cleanup
    expect(complete).toBe(true)
    let otherComplete = false
    void closingOther.then(() => {
      otherComplete = true
    })
    await Promise.resolve()
    expect(otherComplete).toBe(false)
    receipts.get(second.id)!.finish()
    await closingOther
    await data.owner.dispose()
  })
  it('retains a failed native disposal receipt for later renderer-scoped cleanup', async () => {
    const failure = new Error('native cleanup refused')
    const data = fixture({ destroy: () => Promise.reject(failure) })
    const view = await attached(data)
    const receipt = data.owner.close(data.renderer, view.id)
    await expect(receipt).rejects.toBe(failure)
    expect(data.owner.close(data.renderer, view.id)).toBe(receipt)
    await expect(data.scopes.revokeOwner(data.renderer.id)).rejects.toMatchObject({
      errors: [{ errors: [failure] }],
    })
    await expect(data.owner.dispose()).rejects.toMatchObject({ errors: [failure] })
  })
  it('reports one failed disposal only after every affected view receipt settles', async () => {
    const failure = new Error('native cleanup refused')
    let finish!: () => void
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let firstId = ''
    const data = fixture({
      destroy: (id) => (id === firstId ? Promise.reject(failure) : pending),
    })
    firstId = (await attached(data)).id
    await data.owner.open(data.renderer, 'installation', 'detail')
    const draining = data.scopes.revokeOwner(data.renderer.id)
    let complete = false
    void draining.then(
      () => {
        complete = true
      },
      () => {
        complete = true
      },
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(complete).toBe(false)
    finish()
    await expect(draining).rejects.toMatchObject({ errors: [{ errors: [failure] }] })
    expect(complete).toBe(true)
    await expect(data.owner.dispose()).rejects.toMatchObject({ errors: [failure] })
  })
})
