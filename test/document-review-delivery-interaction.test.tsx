// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DocumentReviewDeliveryPanel } from '../src/renderer/src/document-review/DocumentReviewDeliveryPanel'
import {
  DocumentReviewWorkspaceController,
  type DocumentReviewWorkspacePort,
} from '../src/renderer/src/document-review/document-review-workspace-controller'
import type { DocumentReviewWorkspaceBinding } from '../src/renderer/src/document-review/use-document-review-interaction'
import {
  useDocumentReviewDelivery,
  type DocumentReviewDeliveryInteraction,
} from '../src/renderer/src/document-review/use-document-review-delivery'
import {
  localPath,
  type DocumentReviewDeliveryDestination,
  type DocumentReviewDeliveryPayload,
  type DocumentReviewModel,
  type PreparedDocumentReviewDelivery,
  type ReviewWorkspaceIdentity,
} from '../src/shared'

const workspace: ReviewWorkspaceIdentity = {
  id: 'workspace',
  root: localPath('/repo'),
}
const exactBody =
  'docs/review.md:2\nQuote:\nTarget statement\nComment:\nPlease tighten this.'
const payload: DocumentReviewDeliveryPayload = {
  body: exactBody,
  byteLength: new TextEncoder().encode(exactBody).byteLength,
  commentIds: ['comment-1'],
}
const prepared: PreparedDocumentReviewDelivery = {
  id: 'prepared-1',
  destination: {
    terminalId: 'terminal-1',
    title: 'Plan review',
    providerName: 'Codex',
    lifecycle: 'live',
    connection: 'connected',
    attention: 'idle',
    capability: 'insert',
  },
  payload,
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('document review delivery interaction', () => {
  it('keeps Insert as the explicit default on a send-now destination', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const insertDestination = {
      ...prepared.destination,
      capability: 'send-now' as const,
    }
    const insertPrepared = { ...prepared, destination: insertDestination }
    const invoke = vi.fn((channel: string) => {
      if (channel === 'document-review:preview-delivery') {
        return Promise.resolve({ ok: true, value: payload })
      }
      if (channel === 'document-review:delivery-destinations') {
        return Promise.resolve({ ok: true, value: [insertDestination] })
      }
      if (channel === 'document-review:prepare-delivery') {
        return Promise.resolve({ ok: true, value: insertPrepared })
      }
      if (channel === 'document-review:insert-delivery') {
        return Promise.resolve({ ok: true, value: { outcome: 'inserted' } })
      }
      throw new Error(`Unexpected IPC ${channel}`)
    })
    installApi(invoke)
    const review = binding(model())
    render(<DeliveryHarness binding={review} />)

    click('Preview batch')
    await settle()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledWith('document-review:preview-delivery', {
      workspace,
      workspaceGeneration: 4,
      selection: { kind: 'batch', batchId: 'active-review' },
    })
    expect(
      host.querySelector('[aria-label="Exact review delivery preview"]')?.textContent,
    ).toBe(exactBody)

    choose('terminal-1')
    await settle()
    expect(invoke).toHaveBeenLastCalledWith('document-review:prepare-delivery', {
      workspace,
      workspaceGeneration: 4,
      selection: { kind: 'batch', batchId: 'active-review' },
      terminalId: 'terminal-1',
    })
    expect(
      host.querySelector('[aria-label="Exact review delivery preview"]')?.textContent,
    ).toBe(exactBody)
    expect(host.textContent).toContain('Plan review')
    expect(host.textContent).toContain('Codex')
    expect(host.textContent).toContain('live · host connected')
    expect(host.textContent).toContain('idle')
    expect(host.textContent).not.toContain('cannot prove')

    click('Copy exact preview')
    await settle()
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith(exactBody)
    expect(button('Copied')).toBeTruthy()
    expect(review.state.model?.comments[0]?.lifecycle).toBe('draft')

    click('Insert into composer')
    await settle()
    expect(invoke).toHaveBeenLastCalledWith('document-review:insert-delivery', {
      preparedId: prepared.id,
    })
    expect(invoke.mock.calls.some(([channel]) => channel === 'pty:write')).toBe(false)
    expect(button('Inserted')).toBeTruthy()
    expect(host.textContent).not.toContain('Review comments remain draft')
    expect(review.state.model?.comments[0]?.lifecycle).toBe('draft')
  })

  it('previews and copies the exact payload with zero live terminals', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const invoke = vi.fn((channel: string) => {
      if (channel === 'document-review:preview-delivery') {
        return Promise.resolve({ ok: true, value: payload })
      }
      if (channel === 'document-review:delivery-destinations') {
        return Promise.resolve({ ok: true, value: [] })
      }
      throw new Error(`Unexpected IPC ${channel}`)
    })
    installApi(invoke)
    render(<DeliveryHarness binding={binding(model())} />)

    click('Preview batch')
    await settle()

    expect(host.textContent).toContain('No live terminals are available')
    expect(
      host.querySelector('[aria-label="Exact review delivery preview"]')?.textContent,
    ).toBe(exactBody)
    click('Copy exact preview')
    await settle()
    expect(writeText).toHaveBeenCalledWith(exactBody)
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'document-review:prepare-delivery'),
    ).toBe(false)
  })

  it('shows Copy-only destination metadata without preparing insert authority', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    })
    const copyOnly: DocumentReviewDeliveryDestination = {
      terminalId: 'shell',
      title: 'Build shell',
      providerName: 'Shell',
      lifecycle: 'live',
      connection: 'connected',
      attention: 'idle',
      capability: 'copy-only',
    }
    const invoke = vi.fn((channel: string) => {
      if (channel === 'document-review:preview-delivery') {
        return Promise.resolve({ ok: true, value: payload })
      }
      if (channel === 'document-review:delivery-destinations') {
        return Promise.resolve({ ok: true, value: [copyOnly] })
      }
      throw new Error(`Unexpected IPC ${channel}`)
    })
    installApi(invoke)
    render(<DeliveryHarness binding={binding(model())} />)

    click('Preview batch')
    await settle()
    choose('shell')

    expect(host.textContent).toContain('Build shell')
    expect(host.textContent).not.toContain('trusted atomic composer contract')
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'document-review:prepare-delivery'),
    ).toBe(false)
    expect(button('Insert into composer')).toMatchObject({
      disabled: true,
      title: 'This provider is Copy-only',
    })
  })

  it('keeps routine working attention in metadata without expanding a warning', () => {
    const destination = { ...prepared.destination, attention: 'working' as const }
    render(<DocumentReviewDeliveryPanel delivery={panelInteraction(destination)} />)

    expect(host.textContent).toContain('Attentionworking')
    expect(host.textContent).not.toContain('reports that its harness is working')
  })

  it('surfaces a terminal attention request as an actionable warning', () => {
    const destination = { ...prepared.destination, attention: 'bell' as const }
    render(<DocumentReviewDeliveryPanel delivery={panelInteraction(destination)} />)

    expect(host.textContent).toContain('Attentionbell')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'requesting attention',
    )
  })

  it('keeps idle attention visible without an extra warning', () => {
    render(
      <DocumentReviewDeliveryPanel
        delivery={panelInteraction(prepared.destination)}
      />,
    )

    expect(host.textContent).toContain('Attentionidle')
    expect(host.textContent).not.toContain('reports that its harness is working')
    expect(host.textContent).not.toContain('requesting attention')
  })

  it('keeps an exact prepared preview after insertion failure for retry or Copy', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => Promise.resolve()) } })
    let insertAttempts = 0
    const invoke = vi.fn((channel: string) => {
      if (channel === 'document-review:preview-delivery') {
        return Promise.resolve({ ok: true, value: payload })
      }
      if (channel === 'document-review:delivery-destinations') {
        return Promise.resolve({ ok: true, value: [prepared.destination] })
      }
      if (channel === 'document-review:prepare-delivery') {
        return Promise.resolve({ ok: true, value: prepared })
      }
      if (channel === 'document-review:insert-delivery') {
        insertAttempts += 1
        return Promise.resolve(
          insertAttempts === 1
            ? { ok: false, error: 'The prepared terminal exited' }
            : { ok: true, value: { outcome: 'inserted' } },
        )
      }
      throw new Error(`Unexpected IPC ${channel}`)
    })
    installApi(invoke)
    render(<DeliveryHarness binding={binding(model())} />)
    click('Preview batch')
    await settle()
    choose('terminal-1')
    await settle()

    click('Insert into composer')
    await settle()
    expect(host.textContent).toContain('The prepared terminal exited')
    expect(
      host.querySelector('[aria-label="Exact review delivery preview"]')?.textContent,
    ).toBe(exactBody)
    expect(button('Copy exact preview')).toBeTruthy()

    click('Insert into composer')
    await settle()
    expect(insertAttempts).toBe(2)
    expect(button('Inserted')).toBeTruthy()
  })

  it('offers send-now separately and adopts durable sent state without routine caveats', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    })
    const sendDestination: DocumentReviewDeliveryDestination = {
      ...prepared.destination,
      capability: 'send-now',
    }
    const sendPrepared = { ...prepared, destination: sendDestination }
    const sentModel: DocumentReviewModel = {
      ...model(),
      comments: model().comments.map((comment) => ({
        ...comment,
        lifecycle: 'sent' as const,
      })),
    }
    const adoptAuthoritative = vi.fn(() => true)
    const review = { ...binding(model()), adoptAuthoritative }
    const invoke = vi.fn((channel: string) => {
      if (channel === 'document-review:preview-delivery') {
        return Promise.resolve({ ok: true, value: payload })
      }
      if (channel === 'document-review:delivery-destinations') {
        return Promise.resolve({ ok: true, value: [sendDestination] })
      }
      if (channel === 'document-review:prepare-delivery') {
        return Promise.resolve({ ok: true, value: sendPrepared })
      }
      if (channel === 'document-review:send-now-delivery') {
        return Promise.resolve({
          ok: true,
          value: {
            outcome: 'sent',
            snapshot: {
              workspaceGeneration: 4,
              revision: 4,
              model: sentModel,
            },
          },
        })
      }
      throw new Error(`Unexpected IPC ${channel}`)
    })
    installApi(invoke)
    render(<DeliveryHarness binding={review} />)
    click('Preview batch')
    await settle()
    choose('terminal-1')
    await settle()

    expect(host.textContent).not.toContain('Send now writes the exact preview')
    expect(host.textContent).not.toContain('Sent means PTY-boundary acceptance only')
    click('Send exact review now')
    await settle()

    expect(invoke).toHaveBeenLastCalledWith('document-review:send-now-delivery', {
      preparedId: prepared.id,
    })
    expect(adoptAuthoritative).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 4, model: sentModel }),
    )
    expect(host.textContent).not.toContain('accepted at the PTY boundary')
    expect(host.textContent).not.toContain('does not mean the agent read')
    expect(button('Sent')?.disabled).toBe(true)
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'pty:write'),
    ).toBe(false)
  })

  it('adopts a successful send while the panel closes and advances later saves', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    })
    const destination: DocumentReviewDeliveryDestination = {
      ...prepared.destination,
      capability: 'send-now',
    }
    const exact = { ...prepared, destination }
    const initial = model()
    const activeModel: DocumentReviewModel = {
      ...initial,
      comments: [
        ...initial.comments,
        {
          ...initial.comments[0]!,
          id: 'comment-2',
          body: 'Keep this draft.',
        },
      ],
    }
    const sentModel: DocumentReviewModel = {
      ...activeModel,
      comments: activeModel.comments.map((comment) =>
        comment.id === 'comment-1'
          ? { ...comment, lifecycle: 'sent' as const }
          : comment,
      ),
    }
    const send = deferred<unknown>()
    const save = vi.fn<DocumentReviewWorkspacePort['save']>((request) =>
      Promise.resolve({
        workspaceGeneration: 4,
        revision: request.expectedRevision + 1,
        model: request.model,
      }),
    )
    const controller = new DocumentReviewWorkspaceController(
      {
        restore: () =>
          Promise.resolve({
            workspaceGeneration: 4,
            revision: 3,
            model: activeModel,
          }),
        save,
        revalidate: () => Promise.reject(new Error('Unexpected revalidation')),
      },
      () => undefined,
    )
    controller.activate(workspace)
    await settle()
    const review: DocumentReviewWorkspaceBinding = {
      get state() {
        return controller.snapshot()
      },
      apply: (action) => controller.apply(action),
      readDocument: (document) => controller.readDocument(document),
      flush: () => controller.flush(),
      adoptAuthoritative: (snapshot) => controller.adoptAuthoritative(snapshot),
    }
    const invoke = vi.fn((channel: string) => {
      if (channel === 'document-review:preview-delivery') {
        return Promise.resolve({ ok: true, value: payload })
      }
      if (channel === 'document-review:delivery-destinations') {
        return Promise.resolve({ ok: true, value: [destination] })
      }
      if (channel === 'document-review:prepare-delivery') {
        return Promise.resolve({ ok: true, value: exact })
      }
      if (channel === 'document-review:send-now-delivery') return send.promise
      throw new Error(`Unexpected IPC ${channel}`)
    })
    installApi(invoke)
    render(<DeliveryHarness binding={review} />)
    click('Preview batch')
    await settle()
    choose('terminal-1')
    await settle()
    click('Send exact review now')
    click('Close preview')
    expect(host.querySelector('[aria-label="Review handoff preview"]')).toBeNull()

    send.resolve({
      ok: true,
      value: {
        outcome: 'sent',
        snapshot: { workspaceGeneration: 4, revision: 4, model: sentModel },
      },
    })
    await settle()

    expect(controller.snapshot()).toMatchObject({
      revision: 4,
      model: {
        comments: [
          expect.objectContaining({ id: 'comment-1', lifecycle: 'sent' }),
          expect.objectContaining({ id: 'comment-2', lifecycle: 'draft' }),
        ],
      },
    })
    expect(
      review.apply({
        type: 'edit-comment',
        workspace,
        commentId: 'comment-2',
        body: 'Updated after send.',
      }).ok,
    ).toBe(true)
    await review.flush()
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 4 }),
    )
    expect(controller.snapshot()).toMatchObject({
      revision: 5,
      error: undefined,
      model: {
        comments: [
          expect.objectContaining({ id: 'comment-1', lifecycle: 'sent' }),
          expect.objectContaining({ id: 'comment-2', body: 'Updated after send.' }),
        ],
      },
    })
  })

  it('keeps send-now retry and Copy available after a delivery failure', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    })
    const destination = { ...prepared.destination, capability: 'send-now' as const }
    const exact = { ...prepared, destination }
    const invoke = vi.fn((channel: string) => {
      if (channel === 'document-review:preview-delivery') {
        return Promise.resolve({ ok: true, value: payload })
      }
      if (channel === 'document-review:delivery-destinations') {
        return Promise.resolve({ ok: true, value: [destination] })
      }
      if (channel === 'document-review:prepare-delivery') {
        return Promise.resolve({ ok: true, value: exact })
      }
      if (channel === 'document-review:send-now-delivery') {
        return Promise.resolve({ ok: false, error: 'PTY exited before write completion' })
      }
      throw new Error(`Unexpected IPC ${channel}`)
    })
    installApi(invoke)
    render(<DeliveryHarness binding={binding(model())} />)
    click('Preview batch')
    await settle()
    choose('terminal-1')
    await settle()
    click('Send exact review now')
    await settle()

    expect(host.textContent).toContain('PTY exited before write completion')
    expect(button('Send exact review now')?.disabled).toBe(false)
    expect(button('Copy exact preview')?.disabled).toBe(false)
    expect(
      host.querySelector('[aria-label="Exact review delivery preview"]')?.textContent,
    ).toBe(exactBody)
  })

  it.each([
    [
      'confirmed lifecycle failure',
      'confirmed',
      'disk unavailable',
      'accepted at the PTY boundary',
    ],
    [
      'indeterminate timeout',
      'indeterminate',
      'SSH PTY write completion timed out',
      'may have been submitted',
    ],
  ] as const)(
    'consumes renderer send authority after %s while retaining Copy',
    async (_label, ptyAcceptance, reason, boundaryMessage) => {
      const writeText = vi.fn(() => Promise.resolve())
      vi.stubGlobal('navigator', { clipboard: { writeText } })
      const destination = { ...prepared.destination, capability: 'send-now' as const }
      const exact = { ...prepared, destination }
      const invoke = vi.fn((channel: string) => {
        if (channel === 'document-review:preview-delivery') {
          return Promise.resolve({ ok: true, value: payload })
        }
        if (channel === 'document-review:delivery-destinations') {
          return Promise.resolve({ ok: true, value: [destination] })
        }
        if (channel === 'document-review:prepare-delivery') {
          return Promise.resolve({ ok: true, value: exact })
        }
        if (channel === 'document-review:send-now-delivery') {
          return Promise.resolve({
            ok: true,
            value: {
              outcome: 'send-authority-consumed',
              ptyAcceptance,
              reason,
            },
          })
        }
        throw new Error(`Unexpected IPC ${channel}`)
      })
      installApi(invoke)
      render(<DeliveryHarness binding={binding(model())} />)
      click('Preview batch')
      await settle()
      choose('terminal-1')
      await settle()
      click('Send exact review now')
      await settle()

      expect(host.textContent).toContain(boundaryMessage)
      expect(host.textContent).toContain('does not prove agent receipt')
      expect(host.textContent).toContain('Send authority was consumed')
      expect(host.textContent).toContain('preview and prepare again')
      expect(button('Send exact review now')?.disabled).toBe(true)
      expect(button('Copy exact preview')?.disabled).toBe(false)

      click('Send exact review now')
      click('Copy exact preview')
      await settle()
      expect(
        invoke.mock.calls.filter(
          ([channel]) => channel === 'document-review:send-now-delivery',
        ),
      ).toHaveLength(1)
      expect(writeText).toHaveBeenCalledExactlyOnceWith(exactBody)
    },
  )

  it('invalidates a prepared preview when the review model changes', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(() => Promise.resolve()) } })
    installApi(
      vi.fn((channel: string) =>
        Promise.resolve(
          channel === 'document-review:delivery-destinations'
            ? { ok: true, value: [prepared.destination] }
            : channel === 'document-review:preview-delivery'
              ? { ok: true, value: payload }
            : { ok: true, value: prepared },
        ),
      ),
    )
    const initial = binding(model())
    render(<DeliveryHarness binding={initial} />)
    click('Preview batch')
    await settle()
    choose('terminal-1')
    await settle()
    expect(host.querySelector('[aria-label="Exact review delivery preview"]')).toBeTruthy()

    const changed = {
      ...initial,
      state: {
        ...initial.state,
        model: {
          ...initial.state.model!,
          comments: [
            { ...initial.state.model!.comments[0]!, body: 'Changed after preview' },
          ],
        },
      },
    }
    render(<DeliveryHarness binding={changed} />)
    await settle()
    expect(host.querySelector('[aria-label="Exact review delivery preview"]')).toBeNull()
    expect(host.textContent).toContain('Preview the selection again')
    expect(
      host.querySelector<HTMLSelectElement>('[aria-label="Review handoff destination"]')
        ?.value,
    ).toBe('')
  })
})

function panelInteraction(
  selectedDestination: DocumentReviewDeliveryDestination,
): DocumentReviewDeliveryInteraction {
  return {
    open: true,
    loading: false,
    destinations: [selectedDestination],
    selectedTerminalId: selectedDestination.terminalId,
    selectedDestination,
    payload,
    prepared: { ...prepared, destination: selectedDestination },
    copied: false,
    inserted: false,
    sent: false,
    previewComment: () => undefined,
    previewBatch: () => undefined,
    selectDestination: () => undefined,
    copy: () => undefined,
    insert: () => undefined,
    sendNow: () => undefined,
    close: () => undefined,
  }
}

function DeliveryHarness({
  binding,
}: {
  readonly binding: DocumentReviewWorkspaceBinding
}): ReactElement {
  const delivery = useDocumentReviewDelivery(binding)
  return (
    <div>
      <button
        type="button"
        onClick={() => delivery.previewBatch('active-review')}
      >
        Preview batch
      </button>
      <DocumentReviewDeliveryPanel delivery={delivery} />
    </div>
  )
}

function binding(reviewModel: DocumentReviewModel): DocumentReviewWorkspaceBinding {
  return {
    state: {
      status: 'ready',
      localGeneration: 2,
      workspace,
      workspaceGeneration: 4,
      revision: 3,
      model: reviewModel,
    },
    apply: () => ({ ok: true, model: reviewModel }),
    readDocument: (document) =>
      Promise.resolve({ status: 'stale', document, reason: 'host-unavailable' }),
    flush: () => Promise.resolve(),
    adoptAuthoritative: () => true,
  }
}

function model(): DocumentReviewModel {
  const document = localPath('/repo/docs/review.md')
  return {
    workspace,
    comments: [
      {
        id: 'comment-1',
        workspace,
        document,
        body: 'Please tighten this.',
        lifecycle: 'draft',
        anchor: {
          snapshot: { algorithm: 'sha256', digest: 'a'.repeat(64), byteLength: 16 },
          range: { startLine: 2, endLine: 2 },
          excerpt: 'Target statement',
          contextBefore: '',
          contextAfter: '',
          state: { status: 'current' },
        },
      },
    ],
    batches: [{ id: 'active-review', workspace, commentIds: ['comment-1'] }],
  }
}

function installApi(invoke: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: { invoke },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

function render(element: ReactElement): void {
  act(() => root.render(element))
}

function click(label: string): void {
  act(() => button(label)?.click())
}

function button(label: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) =>
      candidate.textContent?.trim() === label ||
      candidate.getAttribute('aria-label') === label,
  )
}

function choose(value: string): void {
  const select = host.querySelector<HTMLSelectElement>(
    '[aria-label="Review handoff destination"]',
  )
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(
      select,
      value,
    )
    select?.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
}
