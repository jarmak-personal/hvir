import type { BrowserWindow } from 'electron'

import {
  asHarnessProfileId,
  type HarnessProviderId,
  type HostPath,
  type ProjectState,
  type SessionsObservationSnapshot,
  type TerminalRecoverySession,
} from '../../shared'
import { SessionsProjectionCoordinator } from '../../renderer/src/sessions/sessions-projection-coordinator'
import type { SessionsRendererSession } from '../../renderer/src/sessions/sessions-renderer-observation'
import type { RendererOwner, RendererResourceScopes } from '../renderer-resource-scopes'

export async function verifySessionsProjectionSmoke(options: {
  readonly win: BrowserWindow
  readonly initialOwner: RendererOwner
  readonly resources: RendererResourceScopes
  readonly replacementReady: Promise<RendererOwner>
  readonly state: ProjectState
  readonly publishState: (state: ProjectState) => void
  readonly providerId: HarnessProviderId
  readonly roots: readonly [HostPath, HostPath, HostPath]
  readonly addRetained: (root: HostPath, session: TerminalRecoverySession) => void
}): Promise<string> {
  const {
    win,
    initialOwner,
    resources,
    replacementReady,
    state,
    publishState,
    providerId,
    roots,
    addRetained,
  } = options
  publishState(state)
  roots.forEach((root, index) =>
    addRetained(root, recovery(`smoke-sessions-${index + 1}`, root, providerId)),
  )

  const initial = (await win.webContents.executeJavaScript(`
    window.__hvirSessionsChangeCount = 0;
    window.__hvirSessionsStop = window.hvir.on('sessions:changed', () => {
      window.__hvirSessionsChangeCount += 1;
    });
    window.hvir.invoke('sessions:observe', { demandGeneration: 1 });
  `)) as unknown
  const initialSnapshot = assertSnapshot(initial, 3)
  assertContentFree(initial, [...roots, state.root])
  await assertRendererJoin(initialSnapshot)

  const reloaded = new Promise<void>((resolve) =>
    win.webContents.once('did-finish-load', () => resolve()),
  )
  win.webContents.reload()
  const [, replacement] = await Promise.all([reloaded, replacementReady])
  if (
    replacement.id !== initialOwner.id ||
    replacement.generation <= initialOwner.generation ||
    !resources.isCurrent(replacement)
  ) {
    throw new Error('Sessions projection renderer generation did not roll forward')
  }

  const staleDemand = (await win.webContents.executeJavaScript(`
    window.hvir.invoke('sessions:snapshot', { demandGeneration: 1 }).then(
      () => 'accepted',
      () => 'rejected'
    );
  `)) as string
  if (staleDemand !== 'rejected') {
    throw new Error('Sessions projection retained a stale renderer demand')
  }

  addRetained(roots[0], recovery('smoke-sessions-after-rollover', roots[0], providerId))
  const reopened = (await win.webContents.executeJavaScript(`
    window.__hvirSessionsChangeCount = 0;
    window.__hvirSessionsStop = window.hvir.on('sessions:changed', () => {
      window.__hvirSessionsChangeCount += 1;
    });
    window.hvir.invoke('sessions:observe', { demandGeneration: 2 });
  `)) as unknown
  assertSnapshot(reopened, 4)
  assertContentFree(reopened, [...roots, state.root])

  await win.webContents.executeJavaScript(
    `window.hvir.invoke('sessions:release', { demandGeneration: 2 })`,
  )
  addRetained(roots[1], recovery('smoke-sessions-after-release', roots[1], providerId))
  const quiet = (await win.webContents.executeJavaScript(`
    Promise.all([
      Promise.resolve(window.__hvirSessionsChangeCount),
      window.hvir.invoke('sessions:snapshot', { demandGeneration: 2 }).then(
        () => 'accepted',
        () => 'rejected'
      )
    ]).then(([changes, stale]) => {
      window.__hvirSessionsStop?.();
      delete window.__hvirSessionsStop;
      delete window.__hvirSessionsChangeCount;
      return { changes, stale };
    });
  `)) as { changes: number; stale: string }
  if (quiet.changes !== 0 || quiet.stale !== 'rejected') {
    throw new Error('Sessions projection continued work after its last consumer released')
  }
  return 'cross-project/worktree + disconnected SSH + renderer rollover + quiet release'
}

function recovery(
  id: string,
  root: HostPath,
  providerId: HarnessProviderId,
): TerminalRecoverySession {
  return {
    id,
    providerId,
    profileId: asHarnessProfileId('plain-shell-default'),
    launchRevision: 1,
    recoverySkipCount: 0,
    hostId: root.hostId,
    cwd: root,
    title: 'Retained smoke session',
    position: 0,
    active: true,
    updatedAt: Date.now(),
  }
}

function assertSnapshot(
  value: unknown,
  expectedRows: number,
): SessionsObservationSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sessions projection preload returned no snapshot')
  }
  const snapshot = value as Record<string, unknown>
  const keys = Object.keys(snapshot).sort()
  const expectedKeys = [
    'demandGeneration',
    'providers',
    'revision',
    'sessions',
    'version',
    'workspaces',
  ]
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(
      `Sessions projection returned unexpected IPC keys: ${keys.join(', ')}`,
    )
  }
  if (!Array.isArray(snapshot.sessions) || snapshot.sessions.length !== expectedRows) {
    throw new Error(
      `Sessions projection expected ${expectedRows} sessions, received ${Array.isArray(snapshot.sessions) ? snapshot.sessions.length : 0}`,
    )
  }
  if (!Array.isArray(snapshot.workspaces) || !Array.isArray(snapshot.providers)) {
    throw new Error('Sessions projection omitted production workspace/provider catalogs')
  }
  for (const workspace of snapshot.workspaces as Array<Record<string, unknown>>) {
    if (
      typeof workspace.projectId !== 'string' ||
      !workspace.projectId.startsWith('sessions-project-') ||
      typeof workspace.workspaceId !== 'string' ||
      !workspace.workspaceId.startsWith('sessions-workspace-') ||
      typeof workspace.qualifier !== 'string'
    ) {
      throw new Error('Sessions projection returned a non-opaque workspace identity')
    }
  }
  return value as SessionsObservationSnapshot
}

async function assertRendererJoin(snapshot: SessionsObservationSnapshot): Promise<void> {
  const observed = snapshot.sessions[0]
  const workspace = snapshot.workspaces.find(
    (candidate) => candidate.workspaceId === observed?.workspaceId,
  )
  if (!observed || !workspace || observed.profile.status !== 'available') {
    throw new Error('Sessions projection smoke lacked one joinable retained session')
  }
  const rendererSession: SessionsRendererSession = {
    handle: observed.handle,
    workspaceQualifier: workspace.qualifier,
    providerId: observed.providerId,
    profileId: observed.profile.value.id,
    title: 'Renderer joined smoke session',
    dormant: false,
    resumeOnStart: false,
    exited: false,
    recoveryUnavailable: false,
    attention: 'bell',
  }
  let released = false
  const coordinator = new SessionsProjectionCoordinator(
    {
      observe: (demandGeneration) => Promise.resolve({ ...snapshot, demandGeneration }),
      snapshot: (demandGeneration) => Promise.resolve({ ...snapshot, demandGeneration }),
      release: () => {
        released = true
        return Promise.resolve()
      },
      subscribe: () => () => undefined,
    },
    {
      snapshot: () => [rendererSession],
      subscribe: () => () => undefined,
    },
  )
  const release = coordinator.acquire()
  await Promise.resolve()
  await Promise.resolve()
  const joined = coordinator.snapshot()
  const row = joined.rows.find((candidate) => candidate.handle === observed.handle)
  if (
    joined.status !== 'available' ||
    row?.title !== rendererSession.title ||
    row.attention.status !== 'available' ||
    row.attention.value !== 'bell' ||
    row.workspace.id !== workspace.workspaceId
  ) {
    throw new Error('Sessions projection coordinator did not join the renderer row')
  }
  release()
  await Promise.resolve()
  coordinator.dispose()
  if (!released) throw new Error('Sessions projection coordinator did not release demand')
}

function assertContentFree(value: unknown, roots: readonly HostPath[]): void {
  const serialized = JSON.stringify(value)
  if (
    roots.some((root) => serialized.includes(root.path)) ||
    serialized.includes('costUsd') ||
    serialized.includes('harnessSessionId')
  ) {
    throw new Error('Sessions projection crossed a private path, identity, or cost field')
  }
}
