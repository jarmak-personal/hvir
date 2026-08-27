import type { BrowserWindow } from 'electron'

import {
  asHarnessProfileId,
  type HarnessProviderId,
  type HostPath,
  type ProjectState,
  type TerminalRecoverySession,
} from '../../shared'
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
  assertSnapshot(initial, 3)
  assertContentFree(initial, roots)

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
  assertContentFree(reopened, roots)

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

function assertSnapshot(value: unknown, expectedRows: number): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Sessions projection preload returned no snapshot')
  }
  const snapshot = value as { rows?: unknown; sessions?: unknown }
  const rows = Array.isArray(snapshot.sessions)
    ? snapshot.sessions
    : Array.isArray(snapshot.rows)
      ? snapshot.rows
      : undefined
  if (rows?.length !== expectedRows) {
    throw new Error(
      `Sessions projection expected ${expectedRows} rows, received ${rows?.length ?? 0}`,
    )
  }
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
