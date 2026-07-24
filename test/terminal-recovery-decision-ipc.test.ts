import { describe, expect, it, vi } from 'vitest'

import type { IpcRegistrar } from '../src/main/ipc/authority-router'
import { registerTerminalIpc } from '../src/main/ipc/features/terminal'
import { asHostId, hostPath, type HostPath } from '../src/shared'

describe('terminal recovery decision IPC', () => {
  it('qualifies and records one bounded recovery decision', async () => {
    const requestedRoot = hostPath(asHostId('ssh-requested'), '/srv/repo')
    const authorizedRoot = hostPath(asHostId('ssh-authorized'), '/srv/repo')
    const recordRecoveryDecision = vi.fn(() => Promise.resolve())
    const { handler, workspaceRoot } = fixture(authorizedRoot, recordRecoveryDecision)

    await handler({
      root: requestedRoot,
      restoredIds: ['terminal-1'],
      skippedIds: ['terminal-2'],
    })

    expect(workspaceRoot).toHaveBeenCalledWith(requestedRoot)
    expect(recordRecoveryDecision).toHaveBeenCalledWith(authorizedRoot, {
      restoredIds: ['terminal-1'],
      skippedIds: ['terminal-2'],
    })
  })

  it.each([
    {
      restoredIds: ['terminal-1', 'terminal-1'],
      skippedIds: [],
    },
    {
      restoredIds: ['terminal-1'],
      skippedIds: ['terminal-1'],
    },
    {
      restoredIds: [],
      skippedIds: ['invalid terminal id'],
    },
  ])('rejects malformed or ambiguous decisions', async (decision) => {
    const root = hostPath(asHostId('local'), '/repo')
    const recordRecoveryDecision = vi.fn(() => Promise.resolve())
    const { handler } = fixture(root, recordRecoveryDecision)

    await expect(handler({ root, ...decision })).rejects.toThrow(
      'Invalid terminal recovery decision',
    )
    expect(recordRecoveryDecision).not.toHaveBeenCalled()
  })
})

function fixture(
  authorizedRoot: HostPath,
  recordRecoveryDecision: (
    root: HostPath,
    decision: {
      readonly restoredIds: readonly string[]
      readonly skippedIds: readonly string[]
    },
  ) => Promise<void>,
) {
  const handlers = new Map<
    string,
    (
      request: unknown,
      context: { owner: () => { id: number; generation: number } },
    ) => unknown
  >()
  const workspaceRoot = vi.fn(() => authorizedRoot)
  const context = { owner: () => ({ id: 7, generation: 1 }) }
  const ipc = {
    authority: {
      workspaceRoot,
    },
    handle: (
      channel: string,
      handler: (
        request: unknown,
        context: { owner: () => { id: number; generation: number } },
      ) => unknown,
    ) => {
      handlers.set(channel, handler)
    },
    handleSend: vi.fn(),
  } as unknown as IpcRegistrar
  registerTerminalIpc(ipc, {
    terminalSessions: { recordRecoveryDecision },
    rendererResources: {
      hasResource: () => false,
      disposeResource: () => Promise.resolve(false),
    },
  } as unknown as Parameters<typeof registerTerminalIpc>[1])
  const handler = handlers.get('terminal:record-recovery-decision')
  if (!handler) throw new Error('Recovery decision handler was not registered')
  return {
    handler: (request: unknown) => Promise.resolve(handler(request, context)),
    workspaceRoot,
  }
}
