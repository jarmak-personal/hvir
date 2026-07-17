import { createHash } from 'node:crypto'

import {
  type HarnessCommandPreview,
  type HarnessCommandPreviewEnvironment,
  type HarnessEnvironmentBinding,
  type HarnessPathBinding,
  type HarnessProfile,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import type { HarnessProfileStoreContract } from './harness-profile-store'
import {
  harnessProvider,
  type HarnessLaunchContext,
  type HarnessLaunchSpec,
  type HarnessProvider,
  type HarnessArtifactContext,
} from './harness-provider'

const PROTECTED_ENVIRONMENT = new Set(['TERM', 'COLORTERM', 'TERM_PROGRAM'])

export interface ResolvedHarnessLaunch {
  readonly profile: HarnessProfile
  readonly provider: HarnessProvider
  readonly spec: HarnessLaunchSpec
  readonly unsetEnvironment: readonly string[]
  readonly previewEnvironment: readonly HarnessCommandPreviewEnvironment[]
  readonly artifactIdentity: string
  readonly artifact: HarnessArtifactContext
}

export interface ResolveHarnessLaunchRequest {
  readonly profile: HarnessProfile
  readonly expectedLaunchRevision: number
  readonly projectRoot: HostPath
  readonly workspaceRoot: HostPath
  readonly host: ProjectHost
  readonly store: HarnessProfileStoreContract
  readonly mode: 'fresh' | 'resume'
  readonly context: HarnessLaunchContext
}

export async function resolveHarnessLaunch(
  request: ResolveHarnessLaunchRequest,
): Promise<ResolvedHarnessLaunch> {
  const { profile, projectRoot, workspaceRoot, host } = request
  if (profile.launchRevision !== request.expectedLaunchRevision) {
    throw new Error('Harness profile launch configuration changed; review it again')
  }
  if (projectRoot.hostId !== host.hostId || workspaceRoot.hostId !== host.hostId) {
    throw new Error('Harness launch paths belong to another host')
  }
  if (
    profile.scope.kind === 'project' &&
    (profile.scope.projectRoot.hostId !== projectRoot.hostId ||
      profile.scope.projectRoot.path !== projectRoot.path)
  ) {
    throw new Error('Harness profile is scoped to another project')
  }
  const provider = harnessProvider(profile.providerId)
  if (provider.profile.version !== profile.providerContractVersion) {
    throw new Error('Harness provider contract changed; review this profile')
  }
  const canonicalProject = await host.realpath(projectRoot)
  const canonicalWorkspace = await host.realpath(workspaceRoot)
  const bindings = await resolvePathBindings(
    profile.pathBindings,
    canonicalProject,
    canonicalWorkspace,
    host,
    request.store,
  )
  const profileArgs = profile.args.map((argument) =>
    argument.parts
      .map((part) => {
        if (part.kind === 'literal') return part.value
        if (part.source === 'projectRoot') return canonicalProject.path
        if (part.source === 'workspaceRoot') return canonicalWorkspace.path
        const path = part.binding ? bindings.get(part.binding) : undefined
        if (!path) throw new Error(`Path binding '${part.binding ?? ''}' is unavailable`)
        return path.path
      })
      .join(''),
  )
  validateReservedArguments(provider, profileArgs)
  const base =
    request.mode === 'resume'
      ? provider.resume(request.context)
      : provider.launch(request.context)
  const executable = await resolveExecutable(
    profile,
    base.file,
    canonicalProject,
    canonicalWorkspace,
    host,
    request.store,
  )
  const environment = resolveEnvironment(profile.environment)
  const args = provider.profile.applyArgs(request.mode, base.args, profileArgs)
  const specEnvironment = { ...base.env, ...environment.values }
  for (const name of environment.inherit) delete specEnvironment[name]
  const spec: HarnessLaunchSpec = {
    ...base,
    file: executable,
    args,
    env: specEnvironment,
  }
  const artifact = deriveArtifactContext(
    provider,
    profile,
    executable,
    bindings,
    spec.env ?? {},
    environment.unset,
    host.hostId,
  )
  return {
    profile,
    provider,
    spec,
    unsetEnvironment: environment.unset,
    previewEnvironment: environment.preview,
    artifactIdentity: artifact.identity,
    artifact,
  }
}

export function commandPreview(
  resolved: ResolvedHarnessLaunch,
  mode: 'fresh' | 'resume',
): HarnessCommandPreview {
  const environment = resolved.previewEnvironment
  const prefix = environment
    .map((binding) => {
      if (binding.operation === 'unset') return `unset ${binding.name};`
      return `${binding.name}=${shellQuote(binding.displayValue ?? '<redacted>')}`
    })
    .join(' ')
  const invocation = [resolved.spec.file, ...resolved.spec.args].map(shellQuote).join(' ')
  return {
    profileId: resolved.profile.id,
    launchRevision: resolved.profile.launchRevision,
    providerId: resolved.profile.providerId,
    mode,
    executable: resolved.spec.file,
    args: resolved.spec.args,
    environment,
    command: prefix ? `${prefix} ${invocation}` : invocation,
    risk: resolved.profile.risk,
    artifactIdentity: resolved.artifactIdentity,
  }
}

async function resolvePathBindings(
  bindings: readonly HarnessPathBinding[],
  projectRoot: HostPath,
  workspaceRoot: HostPath,
  host: ProjectHost,
  store: HarnessProfileStoreContract,
): Promise<ReadonlyMap<string, HostPath>> {
  const resolved = new Map<string, HostPath>()
  for (const binding of bindings) {
    if (binding.path.hostId !== host.hostId) {
      throw new Error(`Path binding '${binding.name}' belongs to another host`)
    }
    const canonical = await host.realpath(binding.path)
    if (
      !pathWithin(canonical, projectRoot) &&
      !pathWithin(canonical, workspaceRoot) &&
      (!binding.grantId || !store.hasPathGrant(binding.grantId, canonical))
    ) {
      throw new Error(`Path binding '${binding.name}' requires an explicit launch grant`)
    }
    resolved.set(binding.name, canonical)
  }
  return resolved
}

async function resolveExecutable(
  profile: HarnessProfile,
  providerDefault: string,
  projectRoot: HostPath,
  workspaceRoot: HostPath,
  host: ProjectHost,
  store: HarnessProfileStoreContract,
): Promise<string> {
  if (profile.executable.kind === 'provider-default') return providerDefault
  if (profile.executable.kind === 'command') return profile.executable.command
  if (profile.executable.path.hostId !== host.hostId) {
    throw new Error('Harness executable belongs to another host')
  }
  const canonical = await host.realpath(profile.executable.path)
  if (
    !pathWithin(canonical, projectRoot) &&
    !pathWithin(canonical, workspaceRoot) &&
    (!profile.executable.grantId ||
      !store.hasPathGrant(profile.executable.grantId, canonical))
  ) {
    throw new Error('Harness executable requires an explicit launch grant')
  }
  return canonical.path
}

function resolveEnvironment(bindings: readonly HarnessEnvironmentBinding[]): {
  readonly values: Record<string, string>
  readonly inherit: readonly string[]
  readonly unset: readonly string[]
  readonly preview: readonly HarnessCommandPreviewEnvironment[]
} {
  const values: Record<string, string> = {}
  const inherit: string[] = []
  const unset: string[] = []
  const preview: HarnessCommandPreviewEnvironment[] = []
  for (const binding of bindings) {
    if (PROTECTED_ENVIRONMENT.has(binding.name)) {
      throw new Error(`Environment '${binding.name}' is owned by hvir`)
    }
    if (binding.kind === 'unset') {
      unset.push(binding.name)
      preview.push({
        name: binding.name,
        operation: 'unset',
        redacted: false,
      })
      continue
    }
    if (binding.kind === 'literal') {
      values[binding.name] = binding.value
      preview.push({
        name: binding.name,
        operation: 'set',
        displayValue: binding.value,
        redacted: false,
      })
      continue
    }
    if (binding.source === 'host') {
      if (binding.name !== binding.sourceName) {
        throw new Error('Host environment references cannot rename a variable')
      }
      inherit.push(binding.name)
      preview.push({
        name: binding.name,
        operation: 'reference',
        displayValue: '<host environment>',
        redacted: true,
      })
      continue
    }
    const forwarded = process.env[binding.sourceName]
    if (forwarded === undefined) {
      throw new Error(
        `Local environment reference '${binding.sourceName}' is unavailable`,
      )
    }
    values[binding.name] = forwarded
    preview.push({
      name: binding.name,
      operation: 'reference',
      displayValue: '<local environment>',
      redacted: true,
    })
  }
  return { values, inherit, unset, preview }
}

function validateReservedArguments(
  provider: HarnessProvider,
  args: readonly string[],
): void {
  for (const reserved of provider.profile.reservedArguments) {
    if (args.some((arg) => arg === reserved || arg.startsWith(`${reserved}=`))) {
      throw new Error(`Argument '${reserved}' is owned by the harness provider`)
    }
  }
}

function deriveArtifactContext(
  provider: HarnessProvider,
  profile: HarnessProfile,
  executable: string,
  bindings: ReadonlyMap<string, HostPath>,
  environment: Readonly<Record<string, string>>,
  unsetEnvironment: readonly string[],
  hostId: HostPath['hostId'],
): HarnessArtifactContext {
  const artifactPaths = provider.profile.artifactPathBindings.map((name) => [
    name,
    bindings.get(name)?.path,
  ])
  const artifactEnvironment = provider.profile.artifactEnvironmentKeys.map((name) => [
    name,
    unsetEnvironment.includes(name) ? '<unset>' : (environment[name] ?? '<inherited>'),
  ])
  const value = JSON.stringify({
    hostId,
    providerId: provider.manifest.id,
    executable: provider.profile.artifactExecutable ? executable : undefined,
    environment: artifactEnvironment,
    paths: artifactPaths,
    contract: profile.providerContractVersion,
  })
  return {
    identity: createHash('sha256').update(value).digest('hex').slice(0, 24),
    environment: Object.fromEntries(
      provider.profile.artifactEnvironmentKeys.flatMap((name) =>
        environment[name] === undefined ? [] : [[name, environment[name]]],
      ),
    ),
    unsetEnvironment: provider.profile.artifactEnvironmentKeys.filter((name) =>
      unsetEnvironment.includes(name),
    ),
  }
}

function pathWithin(path: HostPath, root: HostPath): boolean {
  if (path.hostId !== root.hostId) return false
  const prefix = root.path === '/' ? '/' : `${root.path.replace(/\/+$/, '')}/`
  return path.path === root.path || path.path.startsWith(prefix)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
