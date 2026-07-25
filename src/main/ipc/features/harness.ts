import { hostPathEquals } from '../../../shared'
import { commandPreview, resolveHarnessLaunch } from '../../harness/harness-launch'
import {
  configureHarnessComposerSubmit,
  harnessProviderCatalog,
} from '../../harness/harness-provider'
import { providerTemplateProfiles } from '../../harness/harness-profile-store'
import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type HarnessIpcDeps = Pick<
  IpcDeps,
  'getProject' | 'getHost' | 'connectedHosts' | 'harnessProfiles' | 'harnessProbes'
>

export function registerHarnessIpc(ipc: IpcRegistrar, deps: HarnessIpcDeps): void {
  ipc.handle('harness:catalog', () => harnessProviderCatalog())
  ipc.handle('harness:profiles', (req) => {
    const workspaceRoot = ipc.authority.workspaceRoot(req.root)
    return deps.harnessProfiles.list(ipc.authority.projectRoot(workspaceRoot))
  })
  ipc.handle('harness:probe-snapshot', (req) => {
    const workspaceRoot = ipc.authority.workspaceRoot(req.root)
    const projectRoot = ipc.authority.projectRoot(workspaceRoot)
    const { host } = deps.getProject()
    return deps.harnessProbes.snapshotProfiles({
      host,
      projectRoot,
      workspaceRoot,
      profiles: deps.harnessProfiles.list(projectRoot),
    })
  })
  ipc.handle('harness:probe-profiles', async (req) => {
    const root = ipc.authority.workspaceRoot(req.root)
    const projectRoot = ipc.authority.projectRoot(root)
    const { host } = deps.getProject()
    const requested = new Set(req.profileIds ?? [])
    if (requested.size > 200) throw new Error('Too many harness profiles to probe')
    const profiles = deps.harnessProfiles
      .list(projectRoot)
      .filter((profile) => requested.size === 0 || requested.has(profile.id))
    return deps.harnessProbes.probeProfiles({
      host,
      projectRoot,
      workspaceRoot: root,
      profiles,
      store: deps.harnessProfiles,
      force: req.force === true,
    })
  })
  ipc.handle('harness:probe-templates', async (req) => {
    const root = ipc.authority.workspaceRoot(req.root)
    const projectRoot = ipc.authority.projectRoot(root)
    const { host } = deps.getProject()
    const requested = new Set(req.providerIds ?? [])
    if (requested.size > 200) throw new Error('Too many harness templates to probe')
    const profiles = providerTemplateProfiles().filter(
      (profile) => requested.size === 0 || requested.has(profile.providerId),
    )
    return deps.harnessProbes.probeProfiles({
      host,
      projectRoot,
      workspaceRoot: root,
      profiles,
      store: deps.harnessProfiles,
      force: req.force === true,
    })
  })
  ipc.handle('harness:profile-materialize', (req) => {
    ipc.authority.workspaceRoot(req.root)
    if (req.providerIds.length > 200) throw new Error('Too many harness templates')
    return deps.harnessProfiles.materializeTemplates(req.providerIds)
  })
  ipc.handle('harness:profile-save', (req) => {
    const workspaceRoot = ipc.authority.workspaceRoot(req.root)
    const projectRoot = ipc.authority.projectRoot(workspaceRoot)
    if (
      req.input.scope.kind === 'project' &&
      !hostPathEquals(req.input.scope.projectRoot, projectRoot)
    ) {
      throw new Error('Harness profile scope must match the active registered project')
    }
    return deps.harnessProfiles.save({
      id: req.id,
      expectedLaunchRevision: req.expectedLaunchRevision,
      expectedMetadataRevision: req.expectedMetadataRevision,
      input: req.input,
    })
  })
  ipc.handle('harness:profile-duplicate', (req) => deps.harnessProfiles.duplicate(req.id))
  ipc.handle('harness:profile-delete', (req) => deps.harnessProfiles.delete(req.id))
  ipc.handle('harness:acknowledge-risk', (req) => {
    const workspaceRoot = ipc.authority.workspaceRoot(req.root)
    const projectRoot = ipc.authority.projectRoot(workspaceRoot)
    const profile = deps.harnessProfiles.get(req.id)
    if (!profile) throw new Error(`Unknown harness profile '${req.id}'`)
    if (
      profile.scope.kind === 'project' &&
      !hostPathEquals(profile.scope.projectRoot, projectRoot)
    ) {
      throw new Error('Harness profile is scoped to another project')
    }
    return deps.harnessProfiles.acknowledgeRisk(req.id, req.launchRevision)
  })
  ipc.handle('harness:preview', async (req) => {
    const root = ipc.authority.workspaceRoot(req.root)
    const projectRoot = ipc.authority.projectRoot(root)
    const { host } = deps.getProject()
    const cwd = await ipc.authority.projectPath(req.cwd, root, host)
    const profile = req.input
      ? deps.harnessProfiles.prepare({ id: req.profileId, input: req.input })
      : deps.harnessProfiles.get(req.profileId)
    if (!profile) throw new Error(`Unknown harness profile '${req.profileId}'`)
    const sessionId = isHarnessSessionId(req.harnessSessionId)
      ? req.harnessSessionId
      : '00000000-0000-4000-8000-000000000000'
    const resolved = await resolveHarnessLaunch({
      profile,
      expectedLaunchRevision: profile.launchRevision,
      projectRoot,
      workspaceRoot: cwd,
      host,
      store: deps.harnessProfiles,
      mode: req.mode,
      context: {
        sessionId,
        cwd,
        defaultShell: await host.defaultShell(),
      },
    })
    return commandPreview(resolved, req.mode)
  })
  ipc.handle('harness:authorize-path', async (req) => {
    const root = ipc.authority.workspaceRoot(req.root)
    const { host } = deps.getProject()
    const canonical = await ipc.authority.canonicalHostPath(req.path, root.hostId, host)
    return deps.harnessProfiles.authorizePath(canonical)
  })
  ipc.handle('harness:configure-composer-submit', async (req) => {
    if (req.mode !== 'enter' && req.mode !== 'ctrl-enter') {
      throw new Error('Invalid composer submit mode')
    }
    if (req.scope === 'host') {
      if (
        typeof req.hostId !== 'string' ||
        req.hostId.length === 0 ||
        req.hostId.length > 240 ||
        /[\0\r\n]/.test(req.hostId)
      ) {
        throw new Error('Invalid host id')
      }
      const host = deps.getHost(req.hostId)
      if (!host || host.connectionState !== 'connected') {
        throw new Error(`Host '${req.hostId}' is not connected`)
      }
      await configureHarnessComposerSubmit(host, req.mode)
      return
    }
    if (
      req.scope !== 'all-connected' ||
      (req.previousMode !== 'enter' && req.previousMode !== 'ctrl-enter')
    ) {
      throw new Error('Invalid composer submit scope')
    }
    const configured = []
    let currentHostId: string | undefined
    try {
      for (const host of deps.connectedHosts()) {
        currentHostId = host.hostId
        await configureHarnessComposerSubmit(host, req.mode)
        configured.push(host)
      }
    } catch (reason) {
      await Promise.allSettled(
        configured.map((host) => configureHarnessComposerSubmit(host, req.previousMode)),
      )
      const detail = reason instanceof Error ? reason.message : String(reason)
      throw new Error(
        `Could not configure message submission on host '${currentHostId ?? 'unknown'}': ${detail}`,
        { cause: reason },
      )
    }
  })
}

function isHarnessSessionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !/\s/.test(value) &&
    !hasControlCharacter(value)
  )
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}
