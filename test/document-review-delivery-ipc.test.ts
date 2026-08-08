import { describe, expect, it, vi } from 'vitest'

import type {
  IpcInvokeContext,
  IpcRegistrar,
} from '../src/main/ipc/authority-router'
import { registerDocumentReviewIpc } from '../src/main/ipc/features/document-review'
import { localPath, type DocumentReviewPreviewRequest } from '../src/shared'

describe('document review delivery IPC', () => {
  it('bounds non-ASCII selection identifiers by the shared UTF-8 byte limit', async () => {
    const { preview, invokePreview } = fixture()
    const accepted = 'é'.repeat(64)
    const rejected = `${accepted}é`

    await expect(
      invokePreview({
        selection: { kind: 'batch', batchId: accepted },
      }),
    ).resolves.toMatchObject({ ok: true })
    expect(preview).toHaveBeenCalledOnce()

    await expect(
      invokePreview({
        selection: { kind: 'batch', batchId: rejected },
      }),
    ).resolves.toEqual({ ok: false, error: 'Invalid review selection' })
    expect(preview).toHaveBeenCalledOnce()
  })

  it('validates prepared identifiers before routing send-now with renderer authority', async () => {
    const { sendNow, invokeSendNow } = fixture()

    await expect(invokeSendNow('prepared-1')).resolves.toMatchObject({ ok: true })
    expect(sendNow).toHaveBeenCalledWith(
      { id: 7, generation: 1 },
      'prepared-1',
    )

    await expect(invokeSendNow('é'.repeat(65))).resolves.toEqual({
      ok: false,
      error: 'Invalid prepared review delivery',
    })
    expect(sendNow).toHaveBeenCalledOnce()
  })
})

function fixture() {
  const root = localPath('/repo')
  const workspace = { id: 'workspace', root }
  const handlers = new Map<
    string,
    (request: unknown, context: IpcInvokeContext) => unknown
  >()
  const ipc = {
    authority: {
      workspaceRoot: vi.fn(() => root),
      assertActiveWorkspace: vi.fn(),
    },
    handle: (
      channel: string,
      handler: (request: unknown, context: IpcInvokeContext) => unknown,
    ) => handlers.set(channel, handler),
    handleSend: vi.fn(),
  } as unknown as IpcRegistrar
  const preview = vi.fn(() => ({
    body: 'exact',
    byteLength: 5,
    commentIds: [],
  }))
  const sendNow = vi.fn(() =>
    Promise.resolve({ outcome: 'sent', snapshot: {} }),
  )
  registerDocumentReviewIpc(ipc, {
    documentReview: {},
    documentReviewDelivery: { preview, sendNow },
    getProject: () => ({ root, host: { hostId: root.hostId } }),
    getProjectState: () => ({
      activeProjectId: 'project',
      activeWorkspaceId: workspace.id,
      projects: [
        {
          id: 'project',
          workspaces: [workspace],
        },
      ],
    }),
  } as unknown as Parameters<typeof registerDocumentReviewIpc>[1])
  const handler = handlers.get('document-review:preview-delivery')
  if (!handler) throw new Error('Preview delivery handler was not registered')
  const sendNowHandler = handlers.get('document-review:send-now-delivery')
  if (!sendNowHandler) throw new Error('Send-now delivery handler was not registered')
  const context = {
    owner: () => ({ id: 7, generation: 1 }),
  } as IpcInvokeContext
  return {
    preview,
    sendNow,
    invokePreview: (
      request: Pick<DocumentReviewPreviewRequest, 'selection'>,
    ) =>
      Promise.resolve(
        handler(
          {
            workspace,
            workspaceGeneration: 3,
            ...request,
          },
          context,
        ),
      ),
    invokeSendNow: (preparedId: string) =>
      Promise.resolve(sendNowHandler({ preparedId }, context)),
  }
}
