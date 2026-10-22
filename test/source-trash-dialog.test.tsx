// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { SourceTrashDialog } from '../src/renderer/src/tree/SourceTrashDialog'
import {
  localPath,
  type OperationResult,
  type ProjectFileOperationStartResult,
} from '../src/shared'
import type { ExtensionSourceTrashProposal } from '../src/shared/extensions/source-trash'
import type { ProjectFileOperationProgress } from '../src/shared/project-file-operations'

let root: Root | undefined
afterEach(async () => {
  await renderTurn(() => root?.unmount())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
async function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const proposal: ExtensionSourceTrashProposal = {
    id: 'review',
    name: 'Extension',
    workspaceId: 'workspace-a',
    root: localPath('/a'),
    path: localPath('/a/skill'),
  }
  const receive = new Map<string, (value: never) => void>()
  const invoke = vi.fn(
    (
      channel: string,
    ): Promise<
      | ExtensionSourceTrashProposal[]
      | OperationResult<ProjectFileOperationStartResult>
      | undefined
    > => {
      if (channel === 'extensions:source-trash-proposals')
        return Promise.resolve([proposal])
      if (channel === 'extensions:source-trash-confirm')
        return Promise.resolve({
          ok: true,
          value: {
            outcome: 'started',
            operationId: 'operation',
            generation: 2,
            itemCount: 1,
          },
        })
      return Promise.resolve(undefined)
    },
  )
  Object.defineProperty(window, 'hvir', {
    configurable: true,
    value: {
      invoke,
      on: (channel: string, listener: (value: never) => void) => {
        receive.set(channel, listener)
        return () => receive.delete(channel)
      },
    },
  })
  const removal = {
    reviewWorkspacePathRemoval: vi.fn(() => ({
      openCount: 1,
      dirtyPaths: [] as ReturnType<typeof localPath>[],
    })),
    closeWorkspaceCleanPath: vi.fn(() => ({
      openCount: 1,
      closedCount: 1,
      dirtyPaths: [],
    })),
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await renderTurn(() => {
    root!.render(<SourceTrashDialog removal={removal} />)
  })
  const emit = async (channel: string, value: unknown) => {
    await renderTurn(() => {
      receive.get(channel)?.(value as never)
    })
  }
  const submit = async () => {
    await renderTurn(() =>
      document.querySelector<HTMLFormElement>('form')!.requestSubmit(),
    )
  }
  return { proposal, invoke, removal, emit, submit }
}
it('shows the existing Files dialog directly and cancellation performs no file operation', async () => {
  const f = await fixture()
  expect(document.querySelector('.file-deletion-dialog')?.textContent).toContain(
    'local:/a/skill',
  )
  expect(document.activeElement?.textContent).toBe('Cancel')
  expect(f.invoke).not.toHaveBeenCalledWith(
    'extensions:source-trash-confirm',
    expect.anything(),
  )
  await renderTurn(() =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Cancel')!
      .click(),
  )
  expect(f.invoke).toHaveBeenCalledWith('extensions:source-trash-cancel', {
    id: 'review',
  })
  expect(f.removal.closeWorkspaceCleanPath).not.toHaveBeenCalled()
})
it('checks target workspace dirty buffers immediately before the trusted confirmation', async () => {
  const f = await fixture()
  f.removal.reviewWorkspacePathRemoval.mockReturnValue({
    openCount: 1,
    dirtyPaths: [localPath('/a/skill/SKILL.md')],
  })
  await f.submit()
  expect(document.querySelector('[role=alert]')?.textContent).toContain('unsaved changes')
  expect(f.invoke).not.toHaveBeenCalledWith(
    'extensions:source-trash-confirm',
    expect.anything(),
  )
  expect(f.removal.reviewWorkspacePathRemoval).toHaveBeenCalledWith(
    f.proposal.root,
    f.proposal.path,
  )
})

it('cancels a running removal through the existing Files operation owner', async () => {
  const f = await fixture()
  await f.submit()
  const button = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent === 'Cancel operation',
  )!
  await renderTurn(() => button.click())
  expect(f.invoke).toHaveBeenCalledWith('fs:cancel-file-operation', {
    operationId: 'operation',
    generation: 2,
  })
  await f.emit('fs:project-file-operation', {
    workspaceRoot: f.proposal.root,
    operationId: 'operation',
    generation: 2,
    phase: 'cancelling',
    completedItems: 0,
    totalItems: 1,
  })
  expect(button.disabled).toBe(true)
  expect(f.removal.closeWorkspaceCleanPath).not.toHaveBeenCalled()
})
it.each(['trashed-entry', 'deletion-state-unknown'] as const)(
  'closes only the exact workspace tabs after %s',
  async (effect) => {
    const f = await fixture()
    await f.submit()
    expect(f.invoke).toHaveBeenCalledWith('extensions:source-trash-confirm', {
      id: 'review',
    })
    const event: ProjectFileOperationProgress = {
      workspaceRoot: f.proposal.root,
      operationId: 'operation',
      generation: 2,
      phase: 'completed',
      completedItems: 1,
      totalItems: 1,
      result: {
        outcome: 'completed',
        operationId: 'operation',
        generation: 2,
        items: [
          {
            itemId: 'delete:0',
            source: f.proposal.path,
            destination: f.proposal.path,
            status: effect === 'trashed-entry' ? 'completed' : 'failed',
            effect,
          },
        ],
      },
    }
    await f.emit('fs:project-file-operation', event)
    if (effect === 'trashed-entry')
      expect(f.removal.closeWorkspaceCleanPath).toHaveBeenCalledWith(
        f.proposal.root,
        f.proposal.path,
      )
    else expect(f.removal.closeWorkspaceCleanPath).not.toHaveBeenCalled()
  },
)
it('withdraws a revoked review so a late click cannot confirm it', async () => {
  const f = await fixture(),
    button = [...document.querySelectorAll('button')].find(
      (entry) => entry.type === 'submit',
    )!
  await f.emit('extensions:source-trash-changed', [])
  await renderTurn(() => button.click())
  expect(document.querySelector('.file-deletion-dialog')).toBeNull()
  expect(f.invoke).not.toHaveBeenCalledWith(
    'extensions:source-trash-confirm',
    expect.anything(),
  )
})

it('retains a consumed launch failure until Close and cannot confirm the invalid request again', async () => {
  const f = await fixture()
  f.invoke.mockRejectedValueOnce(
    new Error('The selected directory changed. Review it again.'),
  )
  await f.submit()
  await f.emit('extensions:source-trash-changed', [])
  expect(document.querySelector('[role=alert]')?.textContent).toContain(
    'The selected directory changed',
  )
  expect(document.querySelector<HTMLButtonElement>('button[type=submit]')?.disabled).toBe(
    true,
  )
  await f.submit()
  expect(
    f.invoke.mock.calls.filter(
      ([channel]) => channel === 'extensions:source-trash-confirm',
    ),
  ).toHaveLength(1)
  expect(f.removal.closeWorkspaceCleanPath).not.toHaveBeenCalled()
  await renderTurn(() =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Close')!
      .click(),
  )
  expect(document.querySelector('.file-deletion-dialog')).toBeNull()
})

it('retains the operation owner when completion withdraws the review before the start reply', async () => {
  const f = await fixture()
  let reply!: (value: Awaited<ReturnType<typeof f.invoke>>) => void
  f.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        reply = resolve
      }),
  )
  await f.submit()
  await f.emit('fs:project-file-operation', {
    workspaceRoot: f.proposal.root,
    operationId: 'operation',
    generation: 2,
    phase: 'completed',
    completedItems: 1,
    totalItems: 1,
    result: {
      outcome: 'completed',
      operationId: 'operation',
      generation: 2,
      items: [
        {
          itemId: 'delete:0',
          source: f.proposal.path,
          destination: f.proposal.path,
          status: 'completed',
          effect: 'trashed-entry',
        },
      ],
    },
  })
  await f.emit('extensions:source-trash-changed', [])
  expect(f.removal.closeWorkspaceCleanPath).not.toHaveBeenCalled()
  await renderTurn(() => {
    reply({
      ok: true,
      value: {
        outcome: 'started',
        operationId: 'operation',
        generation: 2,
        itemCount: 1,
      },
    })
  })
  expect(f.removal.closeWorkspaceCleanPath).toHaveBeenCalledExactlyOnceWith(
    f.proposal.root,
    f.proposal.path,
  )
  expect(document.querySelector('.file-deletion-dialog')).toBeNull()
})

async function renderTurn(work: () => void): Promise<void> {
  await act(async () => {
    work()
    await Promise.resolve()
  })
}
