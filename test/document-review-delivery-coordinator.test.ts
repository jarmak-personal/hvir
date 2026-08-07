import { describe, expect, it } from 'vitest'

import { DocumentReviewDeliveryCoordinator } from '../src/main/document-review'
import { harnessProviders } from '../src/main/harness/harness-provider'
import type { ProjectHost } from '../src/main/project-host'
import type { ManagedPty } from '../src/main/pty/pty-supervisor'
import { RendererResourceScopes } from '../src/main/renderer-resource-scopes'
import type { OwnedTerminalSession } from '../src/main/terminal/session-registry'
import {
  asHarnessProfileId,
  asHarnessProviderId,
  asHostId,
  hostPath,
  localPath,
  type DocumentReviewModel,
  type HostConnectionState,
  type ReviewWorkspaceIdentity,
} from '../src/shared'

const OWNER = { id: 41, generation: 1 }

describe('document review delivery coordinator', () => {
  it.each([
    ['local', localPath('/repo')],
    ['SSH', hostPath(asHostId('ssh:review'), '/srv/repo')],
  ])('uses the same exact host-qualified destination policy for %s', (_label, root) => {
    const fixture = deliveryFixture({ id: `workspace-${root.hostId}`, root })
    const supported = fixture.addTerminal('supported', 'claude-code', 'Ready')
    fixture.addTerminal('copy', 'plain-shell', 'Shell')
    fixture.addTerminal(
      'foreign-workspace',
      'codex',
      'Other workspace',
      hostPath(root.hostId, `${root.path}-other`),
    )
    fixture.addTerminal(
      'foreign-owner',
      'codex',
      'Other renderer',
      root,
      { id: OWNER.id, generation: OWNER.generation + 1 },
    )

    expect(fixture.coordinator.destinations(OWNER, fixture.scope)).toEqual([
      expect.objectContaining({
        terminalId: supported.id,
        title: 'Ready',
        providerName: 'Claude Code',
        attention: 'idle',
        capability: 'insert',
      }),
      expect.objectContaining({
        terminalId: 'copy',
        title: 'Shell',
        providerName: 'Shell',
        lifecycle: 'live',
        connection: 'connected',
        capability: 'copy-only',
      }),
    ])
  })

  it('previews an exact Copy payload without terminals or host connectivity', () => {
    const fixture = deliveryFixture()
    fixture.connection.value = 'disconnected'

    const payload = fixture.coordinator.preview(OWNER, {
      ...fixture.scope,
      selection: { kind: 'batch', batchId: 'active-review' },
    })

    expect(payload).toEqual({
      body:
        'docs/review.md:2\nQuote:\nTarget statement\nComment:\nPlease tighten this.',
      byteLength: new TextEncoder().encode(payload.body).byteLength,
      commentIds: ['comment-1'],
    })
    expect(fixture.coordinator.destinations(OWNER, fixture.scope)).toEqual([])
    expect(fixture.writes).toEqual([])
  })

  it('keeps the exact terminal instance bound across real presentation mutations', () => {
    const fixture = deliveryFixture()
    const selected = fixture.addTerminal('chosen', 'codex', 'Chosen terminal')
    fixture.addTerminal('focused-later', 'claude-code', 'Focused later')
    const prepared = fixture.coordinator.prepare(OWNER, {
      ...fixture.scope,
      selection: { kind: 'batch', batchId: 'active-review' },
      terminalId: selected.id,
    })

    expect(prepared.destination).toMatchObject({
      terminalId: 'chosen',
      title: 'Chosen terminal',
      providerName: 'Codex',
      capability: 'insert',
    })
    expect(prepared.payload.body).toBe(
      'docs/review.md:2\nQuote:\nTarget statement\nComment:\nPlease tighten this.',
    )

    fixture.presentations.set('chosen', {
      ...fixture.presentations.get('chosen')!,
      title: 'Renamed after preview',
      attention: 'bell',
      active: false,
      position: 9,
      updatedAt: 2,
    })
    fixture.presentations.set('focused-later', {
      ...fixture.presentations.get('focused-later')!,
      attention: 'working',
      active: true,
      position: 0,
      updatedAt: 2,
    })

    expect(fixture.coordinator.insert(OWNER, prepared.id)).toEqual({
      outcome: 'inserted',
    })
    expect(fixture.writes).toEqual([
      {
        id: 'chosen',
        instanceId: selected.instanceId,
        ownerId: OWNER.id,
        ownerGeneration: OWNER.generation,
        data: `\x1b[200~${prepared.payload.body}\x1b[201~`,
      },
    ])
    expect(fixture.model.comments[0]?.lifecycle).toBe('draft')
    expect(() => fixture.coordinator.insert(OWNER, prepared.id)).toThrow(/stale/)
  })

  it('fails closed for disconnect and preserves the prepared record for exact retry', () => {
    const fixture = deliveryFixture()
    fixture.addTerminal('target', 'claude-code', 'Target')
    const prepared = fixture.coordinator.prepare(OWNER, {
      ...fixture.scope,
      selection: { kind: 'comment', commentId: 'comment-1' },
      terminalId: 'target',
    })
    fixture.connection.value = 'disconnected'
    expect(() => fixture.coordinator.insert(OWNER, prepared.id)).toThrow(/disconnected/)
    expect(fixture.writes).toEqual([])
    expect(fixture.model.comments[0]?.lifecycle).toBe('draft')

    fixture.connection.value = 'connected'
    expect(fixture.coordinator.insert(OWNER, prepared.id)).toEqual({
      outcome: 'inserted',
    })
    expect(fixture.writes).toHaveLength(1)
  })

  it('rejects exit, instance replacement, owner generation, provider drift, and review edits', () => {
    const cases = [
      (fixture: ReturnType<typeof deliveryFixture>, terminal: ManagedPty) =>
        fixture.terminals.delete(terminal.id),
      (fixture: ReturnType<typeof deliveryFixture>, terminal: ManagedPty) =>
        fixture.terminals.set(terminal.id, { ...terminal, instanceId: 'replacement' }),
      (fixture: ReturnType<typeof deliveryFixture>, terminal: ManagedPty) =>
        fixture.terminals.set(terminal.id, {
          ...terminal,
          providerId: asHarnessProviderId('claude-code'),
        }),
      (fixture: ReturnType<typeof deliveryFixture>) => {
        fixture.revision.value += 1
      },
    ]
    for (const change of cases) {
      const fixture = deliveryFixture()
      const terminal = fixture.addTerminal('target', 'codex', 'Target')
      const prepared = fixture.coordinator.prepare(OWNER, {
        ...fixture.scope,
        selection: { kind: 'comment', commentId: 'comment-1' },
        terminalId: terminal.id,
      })
      change(fixture, terminal)
      expect(() => fixture.coordinator.insert(OWNER, prepared.id)).toThrow()
      expect(fixture.writes).toEqual([])
      expect(fixture.model.comments[0]?.lifecycle).toBe('draft')
    }

    const fixture = deliveryFixture()
    fixture.addTerminal('target', 'codex', 'Target')
    const prepared = fixture.coordinator.prepare(OWNER, {
      ...fixture.scope,
      selection: { kind: 'comment', commentId: 'comment-1' },
      terminalId: 'target',
    })
    expect(() =>
      fixture.coordinator.insert(
        { id: OWNER.id, generation: OWNER.generation + 1 },
        prepared.id,
      ),
    ).toThrow(/stale/)
    expect(fixture.writes).toEqual([])
  })

  it('keeps Copy-only destinations visible without granting insertion authority', () => {
    const fixture = deliveryFixture()
    fixture.addTerminal('shell', 'plain-shell', 'Shell')
    expect(fixture.coordinator.destinations(OWNER, fixture.scope)).toEqual([
      expect.objectContaining({ terminalId: 'shell', capability: 'copy-only' }),
    ])
    expect(() =>
      fixture.coordinator.prepare(OWNER, {
        ...fixture.scope,
        selection: { kind: 'comment', commentId: 'comment-1' },
        terminalId: 'shell',
      }),
    ).toThrow(/Copy-only/)
    expect(fixture.writes).toEqual([])
    expect(fixture.model.comments[0]?.lifecycle).toBe('draft')
  })

  it.each(['workspace', 'renderer'] as const)(
    'removes prepared authority on %s resource revocation',
    async (lifetime) => {
      const fixture = deliveryFixture()
      fixture.addTerminal('target', 'codex', 'Target')
      const prepared = fixture.coordinator.prepare(OWNER, {
        ...fixture.scope,
        selection: { kind: 'comment', commentId: 'comment-1' },
        terminalId: 'target',
      })

      const cleanup =
        lifetime === 'workspace'
          ? fixture.resources.revokeWorkspace(fixture.scope.workspace.root)
          : fixture.resources.revokeOwner(OWNER.id)

      expect(() => fixture.coordinator.insert(OWNER, prepared.id)).toThrow(/stale/)
      expect(fixture.writes).toEqual([])
      await cleanup
    },
  )
})

function deliveryFixture(
  workspace: ReviewWorkspaceIdentity = {
    id: 'workspace-local',
    root: localPath('/repo'),
  },
) {
  const connection: { value: HostConnectionState } = { value: 'connected' }
  const host = {
    get connectionState() {
      return connection.value
    },
  } as ProjectHost
  const revision = { value: 3 }
  const model = reviewModel(workspace)
  const terminals = new Map<string, ManagedPty>()
  const presentations = new Map<string, OwnedTerminalSession>()
  const resources = new RendererResourceScopes()
  expect(resources.activateOwner(OWNER.id)).toEqual(OWNER)
  const writes: Array<{
    id: string
    instanceId: string
    ownerId: number
    ownerGeneration?: number
    data: string
  }> = []
  const coordinator = new DocumentReviewDeliveryCoordinator({
    workspace: {
      deliverySnapshot: (owner, request) => {
        if (
          owner.id !== OWNER.id ||
          owner.generation !== OWNER.generation ||
          request.workspaceGeneration !== 5 ||
          request.workspace.id !== workspace.id
        ) {
          throw new Error('Document review renderer or workspace generation is stale')
        }
        return {
          workspaceGeneration: 5,
          revision: revision.value,
          model,
          host,
        }
      },
    },
    ptys: {
      get: (id) => terminals.get(id),
      list: () => [...terminals.values()],
      write: (id, ownerId, data, ownerGeneration) => {
        const terminal = terminals.get(id)
        if (
          !terminal ||
          terminal.ownerId !== ownerId ||
          terminal.ownerGeneration !== ownerGeneration
        ) {
          throw new Error('PTY is no longer owned')
        }
        writes.push({
          id,
          instanceId: terminal.instanceId,
          ownerId,
          ownerGeneration,
          data,
        })
      },
    },
    sessions: { get: (id) => presentations.get(id) },
    providers: harnessProviders,
    resources,
  })

  return {
    coordinator,
    connection,
    model,
    revision,
    terminals,
    presentations,
    resources,
    writes,
    scope: { workspace, workspaceGeneration: 5 },
    addTerminal: (
      id: string,
      providerId: string,
      title: string,
      root = workspace.root,
      owner = OWNER,
    ): ManagedPty => {
      const provider = harnessProviders.get(providerId)
      const terminal: ManagedPty = {
        id,
        instanceId: `${id}-instance`,
        ownerId: owner.id,
        ownerGeneration: owner.generation,
        hostId: root.hostId,
        workspaceRoot: root,
        cwd: root,
        providerId: provider.manifest.id,
        capabilities: {
          sessionIdentity: provider.sessionIdentity,
          exactResume: provider.supportsResume,
          contextPresentation: provider.manifest.contextPresentation,
          reviewInsertContractRevision: provider.documentReviewInsert?.revision,
        },
        pid: 1,
        startedAt: 1,
        resumed: false,
        identityStatus: 'none',
      }
      terminals.set(id, terminal)
      presentations.set(id, {
        id,
        providerId: provider.manifest.id,
        profileId: asHarnessProfileId(`${id}-profile`),
        launchRevision: 1,
        recoverySkipCount: 0,
        hostId: root.hostId,
        workspaceRoot: root,
        cwd: root,
        title,
        position: presentations.size,
        active: false,
        attention: 'idle',
        updatedAt: 1,
      })
      return terminal
    },
  }
}

function reviewModel(workspace: ReviewWorkspaceIdentity): DocumentReviewModel {
  const document = hostPath(workspace.root.hostId, `${workspace.root.path}/docs/review.md`)
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
    batches: [
      { id: 'active-review', workspace, commentIds: ['comment-1'] },
    ],
  }
}
