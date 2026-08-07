// @vitest-environment happy-dom

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DocumentReviewDeliveryPanel } from '../src/renderer/src/document-review/DocumentReviewDeliveryPanel'
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
    expect(host.textContent).toContain('cannot prove')

    click('Copy exact preview')
    await settle()
    expect(writeText).toHaveBeenCalledOnce()
    expect(writeText).toHaveBeenCalledWith(exactBody)
    expect(review.state.model?.comments[0]?.lifecycle).toBe('draft')

    click('Insert into composer')
    await settle()
    expect(invoke).toHaveBeenLastCalledWith('document-review:insert-delivery', {
      preparedId: prepared.id,
    })
    expect(invoke.mock.calls.some(([channel]) => channel === 'pty:write')).toBe(false)
    expect(host.textContent).toContain('Review comments remain draft')
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
    expect(host.textContent).toContain('This provider has no trusted atomic composer contract')
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'document-review:prepare-delivery'),
    ).toBe(false)
    expect(button('Insert into composer')?.disabled).toBe(true)
  })

  it.each([
    ['working', 'reports that its harness is working', 'status'],
    ['bell', 'requesting attention', 'alert'],
  ] as const)(
    'surfaces %s attention as a visible warning',
    (attention, warning, role) => {
      const destination = { ...prepared.destination, attention }
      render(
        <DocumentReviewDeliveryPanel
          delivery={panelInteraction(destination)}
        />,
      )

      expect(host.textContent).toContain(`Attention${attention}`)
      expect(
        [...host.querySelectorAll(`[role="${role}"]`)].some((element) =>
          element.textContent?.includes(warning),
        ),
      ).toBe(true)
    },
  )

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
    expect(host.textContent).toContain('Review comments remain draft')
  })

  it('offers send-now separately, adopts durable sent state, and explains its boundary', async () => {
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

    expect(host.textContent).toContain('Send now writes the exact preview to Plan review')
    expect(host.textContent).toContain('Sent means PTY-boundary acceptance only')
    click('Send exact review now')
    await settle()

    expect(invoke).toHaveBeenLastCalledWith('document-review:send-now-delivery', {
      preparedId: prepared.id,
    })
    expect(adoptAuthoritative).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 4, model: sentModel }),
    )
    expect(host.textContent).toContain('accepted at the PTY boundary')
    expect(host.textContent).toContain('does not mean the agent read, accepted, or resolved')
    expect(button('Send exact review now')?.disabled).toBe(true)
    expect(
      invoke.mock.calls.some(([channel]) => channel === 'pty:write'),
    ).toBe(false)
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
