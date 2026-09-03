import { hostPathEquals } from '../../../shared'
import { resolveHarnessLaunch } from '../../harness/harness-launch'
import { harnessProvider, selectHarnessLaunch } from '../../harness/harness-provider'
import {
  attachRendererPty,
  canAttachRetainedRendererPty,
  registerRendererPty,
  rendererPtyQualifier,
} from '../../terminal/renderer-pty-lifecycle'
import {
  isAuthorizedTerminalFork,
  isHarnessSessionId,
  isTerminalId,
  terminalLaunchMode,
} from '../../terminal/terminal-launch-admission'
import { terminalStartedResponse } from '../../terminal/terminal-start-response'
import { PtyStartUnavailableError } from '../../pty/pty-supervisor'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'
import { operationResult } from '../operation-result'
type TerminalIpcDeps = Pick<
  IpcDeps,
  | 'getProject'
  | 'terminalSessions'
  | 'harnessProfiles'
  | 'harnessProbes'
  | 'rendererResources'
  | 'ptySupervisor'
  | 'terminalMoves'
>

export function registerTerminalIpc(ipc: IpcRegistrar, deps: TerminalIpcDeps): void {
  ipc.handle('terminal:recovery', (req) => {
    const root = ipc.authority.workspaceRoot(req.root)
    return deps.terminalSessions.list(root)
  })

  ipc.handle('terminal:record-recovery-decision', async (req, context) => {
    const root = ipc.authority.workspaceRoot(req.root)
    const restoredIds = recoveryDecisionIds(req.restoredIds)
    const skippedIds = recoveryDecisionIds(req.skippedIds)
    if (restoredIds.length + skippedIds.length > 500) {
      throw new Error('Invalid terminal recovery decision')
    }
    const decided = new Set(restoredIds)
    if (skippedIds.some((id) => decided.has(id))) {
      throw new Error('Invalid terminal recovery decision')
    }
    await deps.terminalSessions.recordRecoveryDecision(root, {
      restoredIds,
      skippedIds,
    })
    const owner = context.owner()
    for (const id of skippedIds) {
      const qualifier = rendererPtyQualifier(root, id)
      if (deps.rendererResources.hasTransferredResource(owner, qualifier)) {
        await deps.rendererResources.disposeResource(owner, 'pty-session', id)
      }
    }
  })
  ipc.handle('terminal:update-layout', async (req) => {
    const root = ipc.authority.workspaceRoot(req.root)
    const rawSessions: unknown = req.sessions
    if (!Array.isArray(rawSessions) || rawSessions.length > 500) {
      throw new Error('Invalid terminal layout')
    }
    const sessions = rawSessions.map((value: unknown) => {
      if (!isUnknownRecord(value)) throw new Error('Invalid terminal layout entry')
      const id = value['id']
      const title = value['title']
      const position = value['position']
      const active = value['active']
      const attention = value['attention']
      if (
        !isTerminalId(id) ||
        !isTerminalTitle(title) ||
        !Number.isSafeInteger(position) ||
        typeof position !== 'number' ||
        position < 0 ||
        position >= 500 ||
        typeof active !== 'boolean' ||
        (attention !== undefined && !isTerminalAttention(attention))
      ) {
        throw new Error('Invalid terminal layout entry')
      }
      return { id, title, position, active, attention }
    })
    await deps.terminalSessions.updateLayout(root, sessions)
  })
  ipc.handle('terminal:forget', async (req) => {
    const root = ipc.authority.workspaceRoot(req.root)
    if (!isTerminalId(req.id)) throw new Error('Invalid terminal session id')
    await deps.terminalSessions.forget(root, req.id)
  })
  ipc.handle('terminal:plan-move', (req, context) =>
    operationResult(() => Promise.resolve(deps.terminalMoves.plan(req, context.owner()))),
  )

  ipc.handle('terminal:move', (req, context) =>
    operationResult(() => deps.terminalMoves.move(req, context.owner())),
  )

  ipc.handle('terminal:rebind-profile', async (req) => {
    const root = ipc.authority.workspaceRoot(req.root)
    const projectRoot = ipc.authority.projectRoot(root)
    if (!isTerminalId(req.id)) throw new Error('Invalid terminal session id')
    const profile = deps.harnessProfiles.get(req.profileId)
    if (!profile || profile.launchRevision !== req.launchRevision) {
      throw new Error('Harness profile launch configuration changed')
    }
    if (
      profile.scope.kind === 'project' &&
      !hostPathEquals(profile.scope.projectRoot, projectRoot)
    ) {
      throw new Error('Harness profile is scoped to another project')
    }
    return deps.terminalSessions.rebindProfile({
      id: req.id,
      providerId: profile.providerId,
      profileId: profile.id,
      launchRevision: profile.launchRevision,
      workspaceRoot: root,
    })
  })

  ipc.handle('pty:start', async (req, context) => {
    if (!isTerminalId(req.sessionId)) throw new Error('Invalid PTY session id')
    const requestedMode = terminalLaunchMode(req)
    if (
      req.replacesSessionId !== undefined &&
      (!isTerminalId(req.replacesSessionId) ||
        req.replacesSessionId === req.sessionId ||
        requestedMode !== 'fresh')
    ) {
      throw new Error('Invalid terminal replacement request')
    }
    const owner = context.owner()
    const { root, host } = deps.getProject()
    const projectRoot = ipc.authority.projectRoot(root)
    const cwd = ipc.authority.workspaceRoot(req.cwd)
    if (
      cwd.hostId !== root.hostId ||
      !hostPathEquals(ipc.authority.projectRoot(cwd), projectRoot)
    ) {
      throw new Error('Terminal launch context belongs to another project')
    }
    const cols = terminalDimension(req.cols)
    const rows = terminalDimension(req.rows)
    const profile = deps.harnessProfiles.get(req.profileId)
    if (!profile) throw new Error(`Unknown harness profile '${req.profileId}'`)
    if (
      !Number.isSafeInteger(req.launchRevision) ||
      req.launchRevision <= 0 ||
      profile.launchRevision !== req.launchRevision
    ) {
      throw new Error('Harness profile launch configuration changed')
    }
    const provider = harnessProvider(profile.providerId)
    if (
      !isTerminalTitle(req.title) ||
      !Number.isSafeInteger(req.position) ||
      req.position < 0 ||
      req.position >= 500 ||
      typeof req.active !== 'boolean' ||
      (req.composerSubmitMode !== 'enter' && req.composerSubmitMode !== 'ctrl-enter') ||
      (req.admission !== undefined &&
        req.admission !== 'interactive' &&
        req.admission !== 'bulk') ||
      (req.resume !== undefined && typeof req.resume !== 'boolean')
    ) {
      throw new Error('Invalid PTY session metadata')
    }
    if (
      profile.scope.kind === 'project' &&
      !hostPathEquals(profile.scope.projectRoot, projectRoot)
    ) {
      throw new Error('Harness profile is scoped to another project')
    }
    const availabilityRequest = {
      host,
      projectRoot,
      workspaceRoot: cwd,
      profiles: [profile],
      store: deps.harnessProfiles,
    } as const
    const effectiveCapabilities = deps.harnessProbes.effectiveLaunchCapabilities(
      availabilityRequest,
      profile,
      req.composerSubmitMode,
    )
    if (requestedMode === 'resume') {
      if (
        !effectiveCapabilities.exactResume ||
        !isHarnessSessionId(req.harnessSessionId) ||
        !deps.terminalSessions.authorizeResume({
          id: req.sessionId,
          providerId: profile.providerId,
          profileId: profile.id,
          launchRevision: profile.launchRevision,
          harnessSessionId: req.harnessSessionId,
          workspaceRoot: root,
          cwd,
        })
      ) {
        throw new Error('Terminal resume is not authorized for this project')
      }
    }
    if (requestedMode === 'fork') {
      if (!isAuthorizedTerminalFork({
        request: req,
        capabilities: effectiveCapabilities,
        providerSupportsFork: provider.fork !== undefined,
        source: isTerminalId(req.forkSourceSessionId)
          ? deps.ptySupervisor.get(req.forkSourceSessionId)
          : undefined,
        profile,
        sessions: deps.terminalSessions,
        workspaceRoot: root,
        cwd,
      })) {
        throw new Error('Terminal fork is not authorized for this project')
      }
    } else if (
      req.forkSourceSessionId !== undefined ||
      req.parentHarnessSessionId !== undefined
    ) {
      throw new Error('Invalid terminal fork request')
    }
    if (
      req.replacesSessionId &&
      (!effectiveCapabilities.exactResume ||
        !deps.terminalSessions.authorizeReplacement({
          replacedId: req.replacesSessionId,
          replacementId: req.sessionId,
          providerId: profile.providerId,
          profileId: profile.id,
          launchRevision: profile.launchRevision,
          workspaceRoot: root,
          cwd,
        }))
    ) {
      throw new Error('Terminal replacement is not authorized for this project')
    }
    const qualifier = rendererPtyQualifier(root, req.sessionId)
    if (deps.rendererResources.hasTransferredResource(owner, qualifier)) {
      if (
        !deps.terminalSessions.authorizeReattach({
          id: req.sessionId,
          providerId: profile.providerId,
          profileId: profile.id,
          launchRevision: profile.launchRevision,
          harnessSessionId: req.harnessSessionId,
          workspaceRoot: root,
          cwd,
        })
      ) {
        throw new Error('Terminal reattachment is not authorized for this project')
      }
      const retained = deps.ptySupervisor.get(req.sessionId)
      if (retained) {
        if (
          !canAttachRetainedRendererPty(deps, retained, {
            owner,
            root,
            cwd,
            profile,
            request: req,
          })
        ) {
          throw new Error('Retained terminal identity changed during reattachment')
        }
        const ptyLease = deps.rendererResources.claimTransferredResource(owner, qualifier)
        if (!ptyLease) throw new Error('Retained terminal was already reattached')
        deps.rendererResources.assertCurrent(owner)
        // If a concurrent rollover has already transferred this lease again,
        // attachment fails closed without disposing the newer owner's PTY.
        attachRendererPty(deps, retained, ptyLease, owner, context.sender)
        return terminalStartedResponse(retained, true)
      }
      // The PTY exited after rollover but before recovery was accepted. Retire
      // its transferred lease and continue through the existing exact-resume path.
      const ptyLease = deps.rendererResources.claimTransferredResource(owner, qualifier)
      if (!ptyLease) throw new Error('Retained terminal was already reattached')
      ptyLease.release()
    }
    const defaultShell = await host.defaultShell()
    const resolved = await resolveHarnessLaunch({
      profile,
      expectedLaunchRevision: req.launchRevision,
      projectRoot,
      workspaceRoot: cwd,
      host,
      store: deps.harnessProfiles,
      mode: requestedMode,
      context: {
        sessionId: requestedMode === 'resume' ? req.harnessSessionId! : req.sessionId,
        parentSessionId:
          requestedMode === 'fork' ? req.parentHarnessSessionId : undefined,
        cwd,
        cols,
        rows,
        defaultShell,
        composerSubmitMode: req.composerSubmitMode,
        effectiveCapabilities,
      },
    })
    const launchDecision = await selectHarnessLaunch(host, provider, requestedMode, {
      sessionId:
        requestedMode === 'fork'
          ? req.parentHarnessSessionId!
          : requestedMode === 'resume'
            ? req.harnessSessionId!
            : req.sessionId,
      cwd,
      artifact: resolved.artifact,
    }, effectiveCapabilities)
    if (launchDecision.outcome === 'resume-unavailable') {
      return { outcome: 'resume-unavailable', reason: launchDecision.reason }
    }
    const launchMode = launchDecision.mode
    const refreshAfterClassifiedLaunchFailure = (): void =>
      deps.harnessProbes.refreshProfile(availabilityRequest, profile)
    const ptyLease = registerRendererPty(deps, owner, root, req.sessionId)
    let managed
    try {
      managed = await deps.ptySupervisor.spawn({
        host,
        provider,
        launchSpec: resolved.spec,
        unsetEnvironment: resolved.unsetEnvironment,
        artifact: resolved.artifact,
        effectiveCapabilities,
        profileId: profile.id,
        launchRevision: profile.launchRevision,
        providerContractVersion: profile.providerContractVersion,
        composerSubmitMode: req.composerSubmitMode,
        cwd,
        workspaceRoot: root,
        ownerId: owner.id,
        ownerGeneration: owner.generation,
        sessionId: req.sessionId,
        harnessSessionId: launchMode === 'resume' ? req.harnessSessionId : undefined,
        launchMode,
        parentHarnessSessionId:
          launchMode === 'fork' ? req.parentHarnessSessionId : undefined,
        resume: launchMode === 'resume',
        admission: req.admission,
        cols,
        rows,
        onClassifiedLaunchFailure: refreshAfterClassifiedLaunchFailure,
      })
    } catch (reason) {
      await ptyLease.dispose()
      if (reason instanceof PtyStartUnavailableError)
        return {
          outcome: 'launch-unavailable',
          reason: reason.reason,
          retryable: reason.retryable,
        }
      if (isClassifiedHarnessLaunchFailure(reason)) {
        refreshAfterClassifiedLaunchFailure()
      }
      throw reason
    }
    deps.harnessProbes.recordSuccessfulLaunch(
      availabilityRequest,
      profile,
      managed.capabilities,
    )
    try {
      deps.rendererResources.assertCurrent(owner)
    } catch (error) {
      await ptyLease.dispose()
      throw error
    }
    const spawnRecord = {
      id: managed.id,
      providerId: profile.providerId,
      profileId: profile.id,
      launchRevision: profile.launchRevision,
      artifactIdentity: resolved.artifactIdentity,
      harnessSessionId: managed.harnessSessionId,
      workspaceRoot: root,
      cwd,
      title: req.title,
      position: req.position,
      active: req.active,
    }
    let detach: () => void | Promise<void> = () => undefined
    try {
      detach = attachRendererPty(deps, managed, ptyLease, owner, context.sender)
      if (req.replacesSessionId) {
        await deps.terminalSessions.recordReplacement({
          replacedId: req.replacesSessionId,
          spawn: spawnRecord,
        })
      } else {
        void deps.terminalSessions
          .recordSpawn(spawnRecord)
          .catch((error) => console.error('[terminal] session persistence failed', error))
      }
    } catch (error) {
      await detach()
      await ptyLease.dispose()
      throw error
    }
    return terminalStartedResponse(managed, false)
  })

  ipc.handleSend('pty:write', ({ id, data }, context) => {
    const owner = context.owner()
    if (deps.ptySupervisor.isOwnedBy(id, owner.id, owner.generation)) {
      deps.ptySupervisor.write(id, owner.id, data, owner.generation)
    }
  })
  ipc.handleSend('pty:resize', ({ id, cols, rows }, context) => {
    const owner = context.owner()
    if (deps.ptySupervisor.isOwnedBy(id, owner.id, owner.generation)) {
      deps.ptySupervisor.resize(
        id,
        owner.id,
        terminalDimension(cols),
        terminalDimension(rows),
        owner.generation,
      )
    }
  })
  ipc.handleSend('pty:kill', ({ id }, context) => {
    const owner = context.owner()
    if (deps.ptySupervisor.isOwnedBy(id, owner.id, owner.generation)) {
      deps.ptySupervisor.kill(id, owner.id, undefined, owner.generation)
    }
  })
}

function recoveryDecisionIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 500) {
    throw new Error('Invalid terminal recovery decision')
  }
  const ids = value.filter(isTerminalId)
  if (ids.length !== value.length || new Set(ids).size !== ids.length) {
    throw new Error('Invalid terminal recovery decision')
  }
  return ids
}

function isTerminalTitle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !hasControlCharacter(value)
  )
}

function isTerminalAttention(value: unknown): value is 'working' | 'bell' | 'idle' {
  return value === 'working' || value === 'bell' || value === 'idle'
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function isClassifiedHarnessLaunchFailure(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason)
  return /\bENOENT\b|command not found|unknown option|unrecognized option|unsupported option/i.test(
    message,
  )
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function terminalDimension(value: number): number {
  if (!Number.isFinite(value)) return 80
  return Math.max(2, Math.min(1000, Math.floor(value)))
}
