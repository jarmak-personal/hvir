import type {
  HarnessProfile,
  HarnessProfileInput,
  HarnessProviderDescriptor,
  HarnessProviderId,
} from '../../../shared'

import {
  parseHarnessArguments,
  serializeHarnessArguments,
} from './harness-argument-editor'

export interface HarnessProfileDraft {
  readonly id?: HarnessProfile['id']
  readonly launchRevision?: number
  readonly metadataRevision?: number
  readonly builtIn: boolean
  readonly input: HarnessProfileInput
  readonly argvText: string
}

export function harnessProfileDraft(profile: HarnessProfile): HarnessProfileDraft {
  return {
    id: profile.id,
    launchRevision: profile.launchRevision,
    metadataRevision: profile.metadataRevision,
    builtIn: profile.builtIn,
    input: {
      displayName: profile.displayName,
      description: profile.description,
      providerId: profile.providerId,
      scope: profile.scope,
      executable: profile.executable,
      args: profile.args,
      environment: profile.environment,
      pathBindings: profile.pathBindings,
      order: profile.order,
    },
    argvText: serializeHarnessArguments(profile.args),
  }
}

export function newHarnessProfileDraft(
  providers: readonly HarnessProviderDescriptor[],
  profiles: readonly HarnessProfile[],
  preferredProviderId?: HarnessProviderId,
): HarnessProfileDraft | undefined {
  const provider =
    providers.find((candidate) => candidate.id === preferredProviderId) ??
    providers.find((candidate) => candidate.default) ??
    providers[0]
  if (!provider) return undefined
  return {
    builtIn: false,
    input: {
      displayName: provider.default
        ? 'Additional shell'
        : !provider.profileTemplate
          ? 'Custom command'
          : `${provider.displayName} profile`,
      providerId: provider.id,
      scope: { kind: 'global' },
      executable: provider.profileTemplate
        ? { kind: 'provider-default' }
        : { kind: 'command', command: '' },
      args: [],
      environment: [],
      pathBindings: [],
      order: Math.min(199, Math.max(0, ...profiles.map((profile) => profile.order + 1))),
    },
    argvText: '',
  }
}

export function serializeHarnessProfileDraft(
  draft: HarnessProfileDraft,
): HarnessProfileInput {
  if (draft.builtIn) throw new Error('Built-in harness profiles are immutable')
  if (
    draft.id &&
    (draft.launchRevision === undefined || draft.metadataRevision === undefined)
  ) {
    throw new Error('Harness profile revision is unavailable; reopen it')
  }
  return { ...draft.input, args: parseHarnessArguments(draft.argvText) }
}

export function harnessProfileSaveRevision(draft: HarnessProfileDraft):
  | {
      readonly kind: 'create'
      readonly input: HarnessProfileInput
    }
  | {
      readonly kind: 'update'
      readonly id: HarnessProfile['id']
      readonly expectedLaunchRevision: number
      readonly expectedMetadataRevision: number
      readonly input: HarnessProfileInput
    } {
  const input = serializeHarnessProfileDraft(draft)
  if (!draft.id) return { kind: 'create', input }
  return {
    kind: 'update',
    id: draft.id,
    expectedLaunchRevision: draft.launchRevision!,
    expectedMetadataRevision: draft.metadataRevision!,
    input,
  }
}

/**
 * Compare the launch-profile meaning rather than the editor's formatting. This keeps
 * equivalent one-line and one-value-per-line argv text from producing a false dirty state.
 */
export function isHarnessProfileDraftDirty(
  profile: HarnessProfile | undefined,
  input: HarnessProfileInput,
  argvText: string,
): boolean {
  if (!profile) return true

  let args: HarnessProfileInput['args']
  try {
    args = parseHarnessArguments(argvText)
  } catch {
    return true
  }

  return (
    input.displayName !== profile.displayName ||
    input.description !== profile.description ||
    input.providerId !== profile.providerId ||
    !same(input.scope, profile.scope) ||
    !same(input.executable, profile.executable) ||
    !same(args, profile.args) ||
    !same(input.environment, profile.environment) ||
    !same(input.pathBindings, profile.pathBindings) ||
    input.order !== profile.order
  )
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
