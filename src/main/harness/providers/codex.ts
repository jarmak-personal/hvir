import {
  asHarnessProviderId,
  asHarnessProfileId,
  type HarnessLaunchMode,
} from '../../../shared'
import type {
  HarnessProvider,
  HarnessLaunchContext,
  HarnessLaunchSpec,
  HarnessDocumentReviewInsertContract,
  HarnessDocumentReviewInsertLaunch,
  HarnessDocumentReviewSendNowContract,
  HarnessDocumentReviewSendNowLaunch,
} from '../harness-provider-contract'
import {
  observeCodexContext,
  observeCodexUsage,
  snapshotCodexUsage,
} from '../codex-context-telemetry'
import { codexSessionDiscovery } from '../codex-session-discovery'
import { versionProbe } from '../harness-provider-probes'
import {
  pathImagePasteContract,
  documentReviewInsertContract,
} from '../harness-composer-contracts'

const CODEX_THREAD_TITLE_CONFIG = 'tui.terminal_title=["thread-title"]'

const CODEX_SUBCOMMAND_BY_LAUNCH_MODE: Readonly<
  Partial<Record<HarnessLaunchMode, 'resume' | 'fork'>>
> = {
  resume: 'resume',
  fork: 'fork',
}

const codexReviewInsert = documentReviewInsertContract(
  () => codexProvider,
  supportsCodexDocumentReviewProfile,
)

const codexReviewSendNow = codexDocumentReviewSendNowContract(codexReviewInsert)

export const codexProvider: HarnessProvider = {
  manifest: {
    id: asHarnessProviderId('codex'),
    displayName: 'Codex',
    sessionKind: 'agent',
    contextPresentation: 'pressure',
    modifiedKeyProtocol: 'csi-u',
    metaEnterAliasesControl: true,
  },
  profile: {
    version: 2,
    defaultProfile: {
      id: asHarnessProfileId('codex-default'),
      displayName: 'Codex',
      description: 'Codex with exact rollout discovery and recovery.',
    },
    reservedArguments: ['resume', 'fork'],
    reservedEnvironmentKeys: ['CODEX_HOME'],
    artifactEnvironmentKeys: ['CODEX_HOME'],
    artifactExecutable: true,
    artifactPathBindings: [],
    applyArgs: (mode, providerArgs, profileArgs) => {
      const subcommand = CODEX_SUBCOMMAND_BY_LAUNCH_MODE[mode]
      if (!subcommand) return [...providerArgs, ...profileArgs]
      const subcommandAt = providerArgs.indexOf(subcommand)
      return subcommandAt < 0
        ? [...providerArgs, ...profileArgs]
        : [
            ...providerArgs.slice(0, subcommandAt),
            ...profileArgs,
            ...providerArgs.slice(subcommandAt),
          ]
    },
  },
  supportsResume: true,
  sessionIdentity: 'discovered',
  sessionDiscovery: codexSessionDiscovery,
  telemetry: { observe: observeCodexContext },
  usageTelemetry: { observe: observeCodexUsage },
  usageSnapshots: { snapshot: snapshotCodexUsage },
  probe: versionProbe('discovered', true, 'pressure', {
    reviewInsert: codexReviewInsert,
    reviewSendNow: codexReviewSendNow,
    supportsReviewSendNowVersion: supportsCodexReviewSendNowVersion,
    supportsExactForkVersion: supportsCodexExactForkVersion,
  }),
  remoteImagePaste: pathImagePasteContract(),
  documentReviewInsert: codexReviewInsert,
  documentReviewSendNow: codexReviewSendNow,

  launch(ctx): HarnessLaunchSpec {
    return {
      file: 'codex',
      args: ['--config', CODEX_THREAD_TITLE_CONFIG, ...codexComposerArgs(ctx)],
      shellEnvironment: true,
    }
  },

  resume(ctx): HarnessLaunchSpec {
    return {
      file: 'codex',
      args: [
        '--config',
        CODEX_THREAD_TITLE_CONFIG,
        ...codexComposerArgs(ctx),
        'resume',
        ctx.sessionId,
      ],
      shellEnvironment: true,
    }
  },

  fork(ctx): HarnessLaunchSpec {
    if (!ctx.parentSessionId) throw new Error('Codex fork requires an exact parent id')
    return {
      file: 'codex',
      args: [
        '--config',
        CODEX_THREAD_TITLE_CONFIG,
        ...codexComposerArgs(ctx),
        'fork',
        ctx.parentSessionId,
      ],
      shellEnvironment: true,
    }
  },
}

function codexComposerArgs(ctx: HarnessLaunchContext): readonly string[] {
  return ctx.composerSubmitMode === 'ctrl-enter'
    ? ['--config', 'tui.keymap.composer.submit=["ctrl-enter"]']
    : []
}

function codexDocumentReviewSendNowContract(
  insert: HarnessDocumentReviewInsertContract,
): HarnessDocumentReviewSendNowContract {
  const revision = 1
  const supportsLaunch = (launch: HarnessDocumentReviewSendNowLaunch): boolean =>
    launch.profile.providerId === codexProvider.manifest.id &&
    launch.profile.providerContractVersion === codexProvider.profile.version &&
    launch.profile.executable.kind === 'provider-default' &&
    supportsCodexDocumentReviewProfile(launch.profile) &&
    launch.effectiveCapabilities.reviewInsertContractRevision === insert.revision &&
    launch.effectiveCapabilities.reviewSendNowContractRevision === revision
  return {
    revision,
    supportsLaunch,
    terminalInput: (body, launch) => {
      if (!supportsLaunch(launch)) {
        throw new Error('Codex review submission is unavailable for this launch')
      }
      const submit = launch.composerSubmitMode === 'ctrl-enter' ? '\x1b[13;5u' : '\r'
      return `${insert.terminalInput(body)}${submit}`
    },
  }
}

/**
 * A live Codex process launched through the provider default remains an explicit
 * best-effort composer target. Profile customization can make the attempt fail,
 * but it must not silently retarget the provider-owned framing contract.
 */
function supportsCodexDocumentReviewProfile(
  _profile: HarnessDocumentReviewInsertLaunch['profile'],
): boolean {
  return true
}

function supportsCodexReviewSendNowVersion(version: string | undefined): boolean {
  const parts = codexVersion(version)
  if (!parts) return false
  return parts[0] > 0 || parts[1] > 146 || (parts[1] === 146 && parts[2] >= 0)
}

function supportsCodexExactForkVersion(version: string | undefined): boolean {
  const parts = codexVersion(version)
  return Boolean(
    parts && (parts[0] > 0 || parts[1] > 151 || (parts[1] === 151 && parts[2] >= 0)),
  )
}

function codexVersion(
  version: string | undefined,
): readonly [number, number, number] | undefined {
  const match = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:\b|[-+])/.exec(version ?? '')
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}
