import { randomUUID } from 'node:crypto'

import {
  asHarnessProfileId,
  hostPathEquals,
  isHarnessBindingName,
  isHarnessEnvironmentName,
  isHarnessProfileId,
  isHarnessProviderId,
  type HarnessArgumentPart,
  type HarnessEnvironmentBinding,
  type HarnessPathBinding,
  type HarnessPathGrant,
  type HarnessProfile,
  type HarnessProfileArgument,
  type HarnessProfileExecutable,
  type HarnessProfileId,
  type HarnessProfileInput,
  type HarnessProfileScope,
  type HostPath,
} from '../../shared'
import type { ProjectHost } from '../project-host'
import {
  harnessProvider,
  harnessProviders,
  type HarnessProvider,
} from './harness-provider'

const FILE_VERSION = 1
const MAX_PROFILES = 200
const MAX_ARGUMENTS = 128
const MAX_ARGUMENT_PARTS = 32
const MAX_ENVIRONMENT_BINDINGS = 128
const MAX_PATH_BINDINGS = 64
const MAX_TEXT = 4_096
const MAX_NAME = 120
const MAX_PROFILE_BYTES = 256 * 1024
const MAX_PATH_BYTES = 16 * 1024

interface StoredFile {
  readonly version: typeof FILE_VERSION
  readonly profiles: readonly HarnessProfile[]
  readonly pathGrants: readonly HarnessPathGrant[]
}

export interface SaveHarnessProfile {
  readonly id?: HarnessProfileId
  readonly expectedLaunchRevision?: number
  readonly expectedMetadataRevision?: number
  readonly input: HarnessProfileInput
}

export interface HarnessRecoveryProfileReference {
  readonly providerId: HarnessProfile['providerId']
  readonly profileId: HarnessProfileId
  readonly launchRevision: number
}

export interface HarnessProfileStoreContract {
  list(projectRoot?: HostPath): readonly HarnessProfile[]
  get(id: HarnessProfileId): HarnessProfile | undefined
  prepare(request: SaveHarnessProfile): HarnessProfile
  save(request: SaveHarnessProfile): Promise<HarnessProfile>
  materializeTemplates(
    providerIds: readonly HarnessProfile['providerId'][],
  ): Promise<readonly HarnessProfile[]>
  acknowledgeRisk(id: HarnessProfileId, launchRevision: number): Promise<HarnessProfile>
  duplicate(id: HarnessProfileId): Promise<HarnessProfile>
  delete(id: HarnessProfileId): Promise<void>
  authorizePath(path: HostPath): Promise<HarnessPathGrant>
  hasPathGrant(id: string, path: HostPath): boolean
  flush(): Promise<void>
}

export class HarnessProfileStore implements HarnessProfileStoreContract {
  private readonly userProfiles = new Map<HarnessProfileId, HarnessProfile>()
  private readonly pathGrants = new Map<string, HostPath>()
  private pendingWrite: Promise<void> = Promise.resolve()

  private constructor(
    private readonly host: ProjectHost,
    private readonly file: HostPath,
    profiles: readonly HarnessProfile[],
    grants: readonly HarnessPathGrant[],
  ) {
    for (const profile of profiles.slice(-MAX_PROFILES)) {
      this.userProfiles.set(profile.id, refreshProviderContract(profile))
    }
    for (const grant of grants.slice(-MAX_PATH_BINDINGS * MAX_PROFILES)) {
      this.pathGrants.set(grant.id, grant.path)
    }
  }

  static async load(host: ProjectHost, file: HostPath): Promise<HarnessProfileStore> {
    let profiles: HarnessProfile[] = []
    let grants: HarnessPathGrant[] = []
    try {
      const value: unknown = JSON.parse(await host.readTextFile(file))
      if (isRecord(value) && value['version'] === FILE_VERSION) {
        const rawProfiles = value['profiles']
        if (Array.isArray(rawProfiles)) {
          profiles = rawProfiles
            .map(parseStoredProfile)
            .filter((profile): profile is HarnessProfile => profile !== undefined)
        }
        const rawGrants = value['pathGrants']
        if (Array.isArray(rawGrants)) {
          grants = rawGrants
            .map(parsePathGrant)
            .filter((grant): grant is HarnessPathGrant => grant !== undefined)
        }
      }
    } catch {
      profiles = []
    }
    const store = new HarnessProfileStore(host, file, profiles, grants)
    if (profiles.some((profile) => store.userProfiles.get(profile.id) !== profile)) {
      await store
        .persist()
        .catch((error) =>
          console.warn(
            '[harness] provider-contract profile migration write failed',
            error,
          ),
        )
    }
    return store
  }

  async importLegacyDefaults(
    references: readonly HarnessRecoveryProfileReference[],
  ): Promise<readonly HarnessProfile[]> {
    const grouped = new Map<
      HarnessProfileId,
      { providerId: HarnessProfile['providerId']; revisions: Set<number> }
    >()
    for (const reference of references) {
      const current = grouped.get(reference.profileId)
      if (current) {
        if (current.providerId !== reference.providerId) current.revisions.add(-1)
        current.revisions.add(reference.launchRevision)
      } else {
        grouped.set(reference.profileId, {
          providerId: reference.providerId,
          revisions: new Set([reference.launchRevision]),
        })
      }
    }

    const imported: HarnessProfile[] = []
    for (const [profileId, reference] of grouped) {
      if (this.get(profileId) || reference.revisions.size !== 1) continue
      const [launchRevision] = reference.revisions
      if (!launchRevision || launchRevision < 1) continue
      let provider: HarnessProvider
      try {
        provider = harnessProvider(reference.providerId)
      } catch {
        continue
      }
      const template = provider.profile.defaultProfile
      if (
        provider.manifest.default ||
        !template ||
        template.id !== profileId ||
        provider.profile.version !== launchRevision ||
        this.userProfiles.size + imported.length >= MAX_PROFILES
      ) {
        continue
      }
      const input = templateInput(provider, nextProfileOrder(this.userProfiles, imported))
      imported.push({
        ...input,
        id: profileId,
        launchRevision,
        metadataRevision: 1,
        providerContractVersion: provider.profile.version,
        builtIn: false,
        risk: classifyProfileRisk(provider, input),
      })
    }
    if (imported.length === 0) return imported
    for (const profile of imported) this.userProfiles.set(profile.id, profile)
    try {
      await this.persist()
      return imported
    } catch (reason) {
      for (const profile of imported) {
        if (this.userProfiles.get(profile.id) === profile) {
          this.userProfiles.delete(profile.id)
        }
      }
      throw reason
    }
  }

  list(projectRoot?: HostPath): readonly HarnessProfile[] {
    return [...builtInProfiles(), ...this.userProfiles.values()]
      .filter(
        (profile) =>
          profile.scope.kind === 'global' ||
          (projectRoot !== undefined &&
            hostPathEquals(profile.scope.projectRoot, projectRoot)),
      )
      .sort(
        (left, right) =>
          Number(right.builtIn) - Number(left.builtIn) ||
          left.order - right.order ||
          left.displayName.localeCompare(right.displayName) ||
          left.id.localeCompare(right.id),
      )
  }

  get(id: HarnessProfileId): HarnessProfile | undefined {
    return (
      builtInProfiles().find((profile) => profile.id === id) ?? this.userProfiles.get(id)
    )
  }

  save(request: SaveHarnessProfile): Promise<HarnessProfile> {
    const profile = this.prepare(request)
    if (
      request.id &&
      (request.expectedLaunchRevision === undefined ||
        request.expectedMetadataRevision === undefined)
    ) {
      throw new Error('Editing a harness profile requires both expected revisions')
    }
    const previous = this.userProfiles.get(profile.id)
    this.userProfiles.set(profile.id, profile)
    return this.persist().then(
      () => profile,
      (reason) => {
        if (this.userProfiles.get(profile.id) === profile) {
          if (previous) this.userProfiles.set(profile.id, previous)
          else this.userProfiles.delete(profile.id)
        }
        throw reason
      },
    )
  }

  async materializeTemplates(
    providerIds: readonly HarnessProfile['providerId'][],
  ): Promise<readonly HarnessProfile[]> {
    const requested = new Set(providerIds)
    if (requested.size !== providerIds.length) {
      throw new Error('Duplicate harness provider template')
    }
    const providers = harnessProviders
      .all()
      .filter(
        (provider) =>
          requested.has(provider.manifest.id) &&
          !provider.manifest.default &&
          provider.profile.defaultProfile !== undefined,
      )
    if (providers.length !== requested.size) {
      throw new Error('Unknown or non-materializable harness provider template')
    }
    if (this.userProfiles.size + providers.length > MAX_PROFILES) {
      throw new Error(`Harness profiles are limited to ${MAX_PROFILES}`)
    }
    const created: HarnessProfile[] = []
    try {
      for (const provider of providers) {
        const input = templateInput(
          provider,
          nextProfileOrder(this.userProfiles, created),
        )
        const profile = this.prepare({ input })
        this.userProfiles.set(profile.id, profile)
        created.push(profile)
      }
      await this.persist()
      return created
    } catch (reason) {
      for (const profile of created) {
        if (this.userProfiles.get(profile.id) === profile) {
          this.userProfiles.delete(profile.id)
        }
      }
      throw reason
    }
  }

  prepare(request: SaveHarnessProfile): HarnessProfile {
    if (!request.id && this.userProfiles.size >= MAX_PROFILES) {
      throw new Error(`Harness profiles are limited to ${MAX_PROFILES}`)
    }
    if (Buffer.byteLength(JSON.stringify(request.input), 'utf8') > MAX_PROFILE_BYTES) {
      throw new Error('Harness profile is too large')
    }
    const input = validateProfileInput(request.input)
    const provider = harnessProvider(input.providerId)
    validateProviderProfile(provider, input)
    const current = request.id ? this.get(request.id) : undefined
    if (request.id && !current) {
      throw new Error('Harness profile was deleted while it was being edited')
    }
    if (current?.builtIn) throw new Error('Built-in harness profiles are immutable')
    if (
      current &&
      request.expectedMetadataRevision !== undefined &&
      current.metadataRevision !== request.expectedMetadataRevision
    ) {
      throw new Error('Harness profile changed while it was being edited')
    }
    if (
      current &&
      request.expectedLaunchRevision !== undefined &&
      current.launchRevision !== request.expectedLaunchRevision
    ) {
      throw new Error('Harness profile launch settings changed while it was being edited')
    }
    const id = current?.id ?? asHarnessProfileId(randomUUID())
    const launchChanged =
      current === undefined ||
      launchIdentity(current) !==
        launchIdentity({
          ...input,
          providerContractVersion: provider.profile.version,
          risk: classifyProfileRisk(provider, input),
        })
    const metadataChanged =
      current === undefined || metadataIdentity(current) !== metadataIdentity(input)
    const profile: HarnessProfile = {
      ...input,
      id,
      builtIn: false,
      providerContractVersion: provider.profile.version,
      risk: classifyProfileRisk(provider, input),
      launchRevision:
        current === undefined ? 1 : current.launchRevision + (launchChanged ? 1 : 0),
      metadataRevision:
        current === undefined ? 1 : current.metadataRevision + (metadataChanged ? 1 : 0),
      riskAcknowledgedRevision: launchChanged
        ? undefined
        : current?.riskAcknowledgedRevision,
    }
    return profile
  }

  acknowledgeRisk(id: HarnessProfileId, launchRevision: number): Promise<HarnessProfile> {
    const current = this.get(id)
    if (!current) throw new Error(`Unknown harness profile '${id}'`)
    if (current.launchRevision !== launchRevision) {
      throw new Error('Harness profile launch configuration changed')
    }
    if (
      current.risk === 'standard' ||
      current.riskAcknowledgedRevision === launchRevision
    ) {
      return Promise.resolve(current)
    }
    if (current.builtIn) {
      throw new Error('Built-in harness profile risk cannot be acknowledged')
    }
    const acknowledged = { ...current, riskAcknowledgedRevision: launchRevision }
    this.userProfiles.set(id, acknowledged)
    return this.persist().then(
      () => acknowledged,
      (reason) => {
        if (this.userProfiles.get(id) === acknowledged) this.userProfiles.set(id, current)
        throw reason
      },
    )
  }

  duplicate(id: HarnessProfileId): Promise<HarnessProfile> {
    const source = this.get(id)
    if (!source) throw new Error(`Unknown harness profile '${id}'`)
    return this.save({
      input: {
        displayName: `${source.displayName} copy`.slice(0, MAX_NAME),
        description: source.description,
        providerId: source.providerId,
        scope: source.scope,
        executable: source.executable,
        args: source.args,
        environment: source.environment,
        pathBindings: source.pathBindings,
        order: source.order + 1,
      },
    })
  }

  delete(id: HarnessProfileId): Promise<void> {
    const current = this.get(id)
    if (current?.builtIn) throw new Error('Built-in harness profiles cannot be deleted')
    const deleted = this.userProfiles.get(id)
    if (!deleted || !this.userProfiles.delete(id)) return Promise.resolve()
    return this.persist().catch((reason) => {
      if (!this.userProfiles.has(id)) this.userProfiles.set(id, deleted)
      throw reason
    })
  }

  authorizePath(path: HostPath): Promise<HarnessPathGrant> {
    if (!isHostPath(path)) throw new Error('Invalid host-qualified path grant')
    const current = [...this.pathGrants].find(([, granted]) =>
      hostPathEquals(granted, path),
    )
    if (current) return Promise.resolve({ id: current[0], path: current[1] })
    const grant = { id: randomUUID(), path }
    this.pathGrants.set(grant.id, grant.path)
    return this.persist().then(() => grant)
  }

  hasPathGrant(id: string, path: HostPath): boolean {
    const granted = this.pathGrants.get(id)
    return granted !== undefined && hostPathEquals(granted, path)
  }

  flush(): Promise<void> {
    return this.pendingWrite
  }

  private persist(): Promise<void> {
    const snapshot: StoredFile = {
      version: FILE_VERSION,
      profiles: [...this.userProfiles.values()].slice(-MAX_PROFILES),
      pathGrants: [...this.pathGrants].map(([id, path]) => ({ id, path })),
    }
    const write = this.pendingWrite
      .catch(() => undefined)
      .then(() => this.host.writeFile(this.file, JSON.stringify(snapshot, null, 2)))
    this.pendingWrite = write
    return write
  }
}

function parsePathGrant(value: unknown): HarnessPathGrant | undefined {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value['id']) ||
    !isHostPath(value['path'])
  ) {
    return undefined
  }
  return { id: value['id'], path: value['path'] }
}

export function builtInProfiles(): readonly HarnessProfile[] {
  const provider = harnessProviders.all().find(({ manifest }) => manifest.default)
  if (!provider?.profile.defaultProfile) return []
  const input = templateInput(provider, 0)
  return [
    {
      ...input,
      id: provider.profile.defaultProfile.id,
      launchRevision: provider.profile.version,
      metadataRevision: 1,
      providerContractVersion: provider.profile.version,
      builtIn: true,
      risk: classifyProfileRisk(provider, input),
    },
  ]
}

/** Ephemeral provider-owned defaults used only for detection and migration. */
export function providerTemplateProfiles(): readonly HarnessProfile[] {
  return harnessProviders.all().flatMap((provider, order) => {
    const template = provider.profile.defaultProfile
    if (!template || provider.manifest.default) return []
    const input = templateInput(provider, order)
    return [
      {
        ...input,
        id: template.id,
        launchRevision: provider.profile.version,
        metadataRevision: 1,
        providerContractVersion: provider.profile.version,
        builtIn: true,
        risk: classifyProfileRisk(provider, input),
      },
    ]
  })
}

function templateInput(provider: HarnessProvider, order: number): HarnessProfileInput {
  const template = provider.profile.defaultProfile
  if (!template)
    throw new Error(`Harness provider '${provider.manifest.id}' has no template`)
  return {
    displayName: template.displayName,
    description: template.description,
    providerId: provider.manifest.id,
    scope: { kind: 'global' },
    executable: { kind: 'provider-default' },
    args: [],
    environment: [],
    pathBindings: [],
    order,
  }
}

function nextProfileOrder(
  profiles: ReadonlyMap<HarnessProfileId, HarnessProfile>,
  pending: readonly HarnessProfile[],
): number {
  return Math.min(
    MAX_PROFILES - 1,
    Math.max(0, ...[...profiles.values(), ...pending].map(({ order }) => order + 1)),
  )
}

export function validateProfileInput(value: HarnessProfileInput): HarnessProfileInput {
  if (!isRecord(value)) throw new Error('Invalid harness profile')
  const displayName = cleanRequiredText(value.displayName, MAX_NAME, 'profile name')
  const description = cleanOptionalText(value.description, MAX_TEXT, 'description')
  if (!isHarnessProviderId(value.providerId)) throw new Error('Invalid provider id')
  const scope = validateScope(value.scope)
  const executable = validateExecutable(value.executable, scope)
  if (!Array.isArray(value.args) || value.args.length > MAX_ARGUMENTS) {
    throw new Error('Invalid profile arguments')
  }
  const args = value.args.map(validateArgument)
  if (
    !Array.isArray(value.environment) ||
    value.environment.length > MAX_ENVIRONMENT_BINDINGS
  ) {
    throw new Error('Invalid profile environment')
  }
  const environment = value.environment.map(validateEnvironmentBinding)
  const environmentNames = new Set<string>()
  for (const binding of environment) {
    if (environmentNames.has(binding.name)) {
      throw new Error(`Duplicate environment binding '${binding.name}'`)
    }
    environmentNames.add(binding.name)
  }
  if (
    !Array.isArray(value.pathBindings) ||
    value.pathBindings.length > MAX_PATH_BINDINGS
  ) {
    throw new Error('Invalid profile path bindings')
  }
  const pathBindings = value.pathBindings.map((binding) =>
    validatePathBinding(binding, scope),
  )
  const pathNames = new Set<string>()
  for (const binding of pathBindings) {
    if (pathNames.has(binding.name)) {
      throw new Error(`Duplicate path binding '${binding.name}'`)
    }
    pathNames.add(binding.name)
  }
  for (const argument of args) {
    for (const part of argument.parts) {
      if (
        part.kind === 'path' &&
        part.source === 'binding' &&
        (!part.binding || !pathNames.has(part.binding))
      ) {
        throw new Error(`Unknown path binding '${part.binding ?? ''}'`)
      }
    }
  }
  if (
    !Number.isSafeInteger(value.order) ||
    value.order < 0 ||
    value.order >= MAX_PROFILES
  ) {
    throw new Error('Invalid profile order')
  }
  return {
    displayName,
    description,
    providerId: value.providerId,
    scope,
    executable,
    args,
    environment,
    pathBindings,
    order: value.order,
  }
}

function validateProviderProfile(
  provider: HarnessProvider,
  input: HarnessProfileInput,
): void {
  if (provider.manifest.id === 'custom' && input.executable.kind === 'provider-default') {
    throw new Error('Custom profiles require an executable')
  }
  const tokens = profileRiskTokens(input.args)
  for (const reserved of provider.profile.reservedArguments) {
    if (tokens.some((token) => token === reserved || token.startsWith(`${reserved}=`))) {
      throw new Error(`Argument '${reserved}' is owned by the harness provider`)
    }
  }
}

function classifyProfileRisk(
  provider: HarnessProvider,
  input: HarnessProfileInput,
): HarnessProfile['risk'] {
  return provider.profile.classifyRisk({
    args: profileRiskTokens(input.args),
    environment: input.environment,
    executableOverridden: input.executable.kind !== 'provider-default',
  })
}

function profileRiskTokens(args: readonly HarnessProfileArgument[]): readonly string[] {
  return args.map((argument) =>
    argument.parts
      .map((part) => (part.kind === 'literal' ? part.value : '<host-path>'))
      .join(''),
  )
}

function refreshProviderContract(profile: HarnessProfile): HarnessProfile {
  let provider: HarnessProvider
  try {
    provider = harnessProvider(profile.providerId)
  } catch {
    return profile
  }
  const risk = classifyProfileRisk(provider, profile)
  if (
    profile.providerContractVersion === provider.profile.version &&
    profile.risk === risk
  ) {
    return profile
  }
  return {
    ...profile,
    providerContractVersion: provider.profile.version,
    risk,
    launchRevision: profile.launchRevision + 1,
    riskAcknowledgedRevision: undefined,
  }
}

function launchIdentity(
  value: Pick<
    HarnessProfile,
    | 'providerId'
    | 'scope'
    | 'executable'
    | 'args'
    | 'environment'
    | 'pathBindings'
    | 'providerContractVersion'
    | 'risk'
  >,
): string {
  return JSON.stringify({
    providerId: value.providerId,
    providerContractVersion: value.providerContractVersion,
    scope: value.scope,
    executable: value.executable,
    args: value.args,
    environment: value.environment,
    pathBindings: value.pathBindings,
    risk: value.risk,
  })
}

function metadataIdentity(
  value: Pick<HarnessProfileInput, 'displayName' | 'description' | 'order'>,
): string {
  return JSON.stringify({
    displayName: value.displayName,
    description: value.description,
    order: value.order,
  })
}

function parseStoredProfile(value: unknown): HarnessProfile | undefined {
  if (!isRecord(value) || !isHarnessProfileId(value['id'])) return undefined
  try {
    const input = validateProfileInput(value as unknown as HarnessProfileInput)
    const launchRevision = positiveInteger(value['launchRevision'])
    const metadataRevision = positiveInteger(value['metadataRevision'])
    const providerContractVersion = positiveInteger(value['providerContractVersion'])
    const risk = value['risk']
    const riskAcknowledgedRevision = positiveInteger(value['riskAcknowledgedRevision'])
    if (
      launchRevision === undefined ||
      metadataRevision === undefined ||
      providerContractVersion === undefined ||
      (value['riskAcknowledgedRevision'] !== undefined &&
        riskAcknowledgedRevision === undefined) ||
      (risk !== 'standard' && risk !== 'elevated' && risk !== 'unclassified')
    ) {
      return undefined
    }
    return {
      ...input,
      id: value['id'],
      launchRevision,
      metadataRevision,
      providerContractVersion,
      builtIn: false,
      risk,
      riskAcknowledgedRevision,
    }
  } catch {
    return undefined
  }
}

function validateScope(value: unknown): HarnessProfileScope {
  if (!isRecord(value)) throw new Error('Invalid profile scope')
  if (value['kind'] === 'global') return { kind: 'global' }
  if (value['kind'] === 'project' && isHostPath(value['projectRoot'])) {
    return { kind: 'project', projectRoot: value['projectRoot'] }
  }
  throw new Error('Invalid profile scope')
}

function validateExecutable(
  value: unknown,
  scope: HarnessProfileScope,
): HarnessProfileExecutable {
  if (!isRecord(value)) throw new Error('Invalid profile executable')
  if (value['kind'] === 'provider-default') return { kind: 'provider-default' }
  if (value['kind'] === 'command') {
    const command = cleanRequiredText(value['command'], 512, 'executable command')
    if (/[/\\\s]/.test(command) || hasControlCharacter(command)) {
      throw new Error('Executable command must be a command name, not a path')
    }
    return { kind: 'command', command }
  }
  if (value['kind'] === 'path' && isHostPath(value['path'])) {
    if (scope.kind === 'project' && value['path'].hostId !== scope.projectRoot.hostId) {
      throw new Error('Executable path belongs to another host')
    }
    if (
      value['grantId'] !== undefined &&
      (typeof value['grantId'] !== 'string' || value['grantId'].length > 128)
    ) {
      throw new Error('Invalid executable path grant')
    }
    return { kind: 'path', path: value['path'], grantId: value['grantId'] }
  }
  throw new Error('Invalid profile executable')
}

function validateArgument(value: unknown): HarnessProfileArgument {
  if (!isRecord(value) || !Array.isArray(value['parts'])) {
    throw new Error('Invalid profile argument')
  }
  if (value['parts'].length === 0 || value['parts'].length > MAX_ARGUMENT_PARTS) {
    throw new Error('Invalid profile argument parts')
  }
  const parts = value['parts'].map(validateArgumentPart)
  const size = parts.reduce(
    (total, part) =>
      total + (part.kind === 'literal' ? Buffer.byteLength(part.value, 'utf8') : 64),
    0,
  )
  if (size > MAX_TEXT) throw new Error('Profile argument is too large')
  return { parts }
}

function validateArgumentPart(value: unknown): HarnessArgumentPart {
  if (!isRecord(value)) throw new Error('Invalid argument part')
  if (value['kind'] === 'literal' && typeof value['value'] === 'string') {
    if (
      Buffer.byteLength(value['value'], 'utf8') > MAX_TEXT ||
      hasControlCharacter(value['value'])
    ) {
      throw new Error('Invalid argument literal')
    }
    if (/\$|`/.test(value['value'])) {
      throw new Error('Shell interpolation is not supported in profile arguments')
    }
    if (/\{[^{}]+\}/.test(value['value'])) {
      throw new Error('Path tokens must use a structured argument part')
    }
    return { kind: 'literal', value: value['value'] }
  }
  if (
    value['kind'] === 'path' &&
    (value['source'] === 'projectRoot' ||
      value['source'] === 'workspaceRoot' ||
      value['source'] === 'binding')
  ) {
    const binding = value['binding']
    if (value['source'] === 'binding' && !isHarnessBindingName(binding)) {
      throw new Error('Invalid argument path binding')
    }
    return {
      kind: 'path',
      source: value['source'],
      binding: value['source'] === 'binding' ? (binding as string) : undefined,
    }
  }
  throw new Error('Invalid argument part')
}

function validateEnvironmentBinding(value: unknown): HarnessEnvironmentBinding {
  if (!isRecord(value) || !isHarnessEnvironmentName(value['name'])) {
    throw new Error('Invalid environment binding')
  }
  if (value['kind'] === 'unset') return { kind: 'unset', name: value['name'] }
  if (value['kind'] === 'literal' && typeof value['value'] === 'string') {
    if (
      Buffer.byteLength(value['value'], 'utf8') > MAX_TEXT ||
      hasControlCharacter(value['value'])
    ) {
      throw new Error(`Invalid environment value for '${value['name']}'`)
    }
    return { kind: 'literal', name: value['name'], value: value['value'] }
  }
  if (
    value['kind'] === 'reference' &&
    (value['source'] === 'host' || value['source'] === 'local-forward') &&
    isHarnessEnvironmentName(value['sourceName'])
  ) {
    return {
      kind: 'reference',
      name: value['name'],
      source: value['source'],
      sourceName: value['sourceName'],
    }
  }
  throw new Error(`Invalid environment binding for '${value['name']}'`)
}

function validatePathBinding(
  value: unknown,
  scope: HarnessProfileScope,
): HarnessPathBinding {
  if (
    !isRecord(value) ||
    !isHarnessBindingName(value['name']) ||
    !isHostPath(value['path']) ||
    (value['grantId'] !== undefined &&
      (typeof value['grantId'] !== 'string' || value['grantId'].length > 128))
  ) {
    throw new Error('Invalid profile path binding')
  }
  if (scope.kind === 'project' && value['path'].hostId !== scope.projectRoot.hostId) {
    throw new Error(`Path binding '${value['name']}' belongs to another host`)
  }
  return {
    name: value['name'],
    path: value['path'],
    grantId: value['grantId'],
  }
}

function isHostPath(value: unknown): value is HostPath {
  return (
    isRecord(value) &&
    typeof value['hostId'] === 'string' &&
    value['hostId'].length > 0 &&
    value['hostId'].length <= 255 &&
    !/\s/.test(value['hostId']) &&
    !hasControlCharacter(value['hostId']) &&
    typeof value['path'] === 'string' &&
    value['path'].startsWith('/') &&
    Buffer.byteLength(value['path'], 'utf8') <= MAX_PATH_BYTES &&
    !hasControlCharacter(value['path'])
  )
}

function cleanRequiredText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`)
  const cleaned = value.trim()
  if (
    cleaned.length === 0 ||
    Buffer.byteLength(cleaned, 'utf8') > max ||
    hasControlCharacter(cleaned)
  ) {
    throw new Error(`Invalid ${field}`)
  }
  return cleaned
}

function cleanOptionalText(
  value: unknown,
  max: number,
  field: string,
): string | undefined {
  if (value === undefined || value === '') return undefined
  return cleanRequiredText(value, max, field)
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
