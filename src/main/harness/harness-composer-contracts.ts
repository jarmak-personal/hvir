import type {
  HarnessProvider,
  HarnessRemoteImagePasteContract,
  HarnessDocumentReviewInsertLaunch,
  HarnessDocumentReviewInsertContract,
} from './harness-provider-contract'
import { hasControlCharacter } from './harness-text-validation'

export function pathImagePasteContract(): HarnessRemoteImagePasteContract {
  return {
    revision: 1,
    terminalInput: (path) => {
      if (
        !path.path.startsWith('/') ||
        hasControlCharacter(path.path) ||
        !/^[A-Za-z0-9_./-]+$/.test(path.path)
      ) {
        throw new Error('Remote image paste requires a safe absolute path')
      }
      return `\x1b[200~${path.path}\x1b[201~`
    },
  }
}

export function documentReviewInsertContract(
  resolveProvider: () => HarnessProvider,
  supportsProfile: (
    profile: HarnessDocumentReviewInsertLaunch['profile'],
  ) => boolean = supportsDefaultDocumentReviewProfile,
): HarnessDocumentReviewInsertContract {
  const revision = 1
  const supportsLaunch = (launch: HarnessDocumentReviewInsertLaunch): boolean => {
    const provider = resolveProvider()
    return (
      launch.profile.providerId === provider.manifest.id &&
      launch.profile.providerContractVersion === provider.profile.version &&
      launch.profile.executable.kind === 'provider-default' &&
      supportsProfile(launch.profile) &&
      launch.effectiveCapabilities.reviewInsertContractRevision === revision
    )
  }
  return {
    revision,
    supportsLaunch,
    terminalInput: (body) => {
      if (body.length === 0 || hasUnsafeReviewBodyCharacter(body)) {
        throw new Error('Document review insertion requires safe human-readable text')
      }
      return `\x1b[200~${body}\x1b[201~`
    },
  }
}

function supportsDefaultDocumentReviewProfile(
  profile: HarnessDocumentReviewInsertLaunch['profile'],
): boolean {
  return (
    profile.args.length === 0 &&
    profile.environment.length === 0 &&
    profile.pathBindings.length === 0
  )
}

function hasUnsafeReviewBodyCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!
    return (code < 32 && character !== '\n' && character !== '\t') || code === 127
  })
}
