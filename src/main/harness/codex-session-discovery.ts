/**
 * Codex persisted-session identification.
 *
 * Codex can resume an exact session id but does not accept a launch-time id.
 * Its rollout record is therefore treated as a version-sensitive adapter
 * detail. Discovery is deliberately fail-closed: hvir only accepts one new
 * session_meta record matching the launch window, cwd, originator, and filename
 * UUID. The PTY supervisor serializes hvir-owned snapshot/launch handoffs
 * separately; bounded identification never blocks a later PTY from starting.
 */

import { hostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { HarnessArtifactContext } from './harness-provider'

const LIST_SESSION_FILES_SCRIPT = `
root="\${CODEX_HOME:-\${HOME}/.codex}/sessions"
printf 'hvir-clock:%s\\0' "$(date +%s)"
[ -d "$root" ] || exit 0
cd "$root" || exit 0
find "$PWD" -type f -name 'rollout-*.jsonl' -print0
`.trim()
const SESSION_ID_IN_FILENAME =
  /(?:^|\/)(?:rollout-[^/]*-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const LIST_MAX_BUFFER = 2 * 1024 * 1024
const META_MAX_BUFFER = 512 * 1024
const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_INITIAL_POLL_MS = 75
const DEFAULT_MAX_POLL_MS = 5_000
const DEFAULT_SETTLE_MS = 250
const LAUNCH_CLOCK_SLOP_MS = 2_000
const MAX_NEW_CANDIDATES = 32
const DEFAULT_ARTIFACT: HarnessArtifactContext = {
  identity: 'codex-default',
  environment: {},
  unsetEnvironment: [],
}

interface CodexSessionSnapshot {
  readonly paths: readonly string[]
  readonly hostCapturedAtMs: number
  readonly localCapturedAtMs: number
}

interface SessionFileScan {
  readonly paths: readonly string[]
  readonly hostNowMs: number
}

interface SessionMetaEnvelope {
  readonly type?: unknown
  readonly payload?: {
    readonly id?: unknown
    readonly timestamp?: unknown
    readonly cwd?: unknown
    readonly originator?: unknown
  }
}

export interface CodexSessionDiscoveryOptions {
  readonly timeoutMs?: number
  readonly initialPollMs?: number
  readonly maxPollMs?: number
  readonly settleMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export function createCodexSessionDiscovery(options: CodexSessionDiscoveryOptions = {}): {
  snapshot(host: ProjectHost, artifact?: HarnessArtifactContext): Promise<unknown>
  identify(
    host: ProjectHost,
    snapshot: unknown,
    context: {
      readonly cwd: HostPath
      readonly launchedAtMs: number
      readonly discoveryStartedAtMs?: number
      readonly signal: AbortSignal
      readonly artifact?: HarnessArtifactContext
    },
  ): Promise<
    | {
        readonly status: 'identified'
        readonly sessionId: string
        readonly sessionData: { readonly rolloutPath: HostPath }
      }
    | { readonly status: 'ambiguous' }
    | { readonly status: 'unavailable' }
  >
} {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const initialPollMs = options.initialPollMs ?? DEFAULT_INITIAL_POLL_MS
  const maxPollMs = options.maxPollMs ?? DEFAULT_MAX_POLL_MS
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? abortableSleep

  return {
    async snapshot(host, artifact): Promise<CodexSessionSnapshot> {
      const localBeforeMs = now()
      const scan = await listSessionFiles(host, undefined, artifact ?? DEFAULT_ARTIFACT)
      const localAfterMs = now()
      return {
        paths: scan.paths,
        hostCapturedAtMs: scan.hostNowMs,
        localCapturedAtMs: localBeforeMs + (localAfterMs - localBeforeMs) / 2,
      }
    },

    async identify(host, rawSnapshot, context) {
      if (!isSnapshot(rawSnapshot)) return { status: 'unavailable' }
      const baseline = new Set(rawSnapshot.paths)
      const deadline = (context.discoveryStartedAtMs ?? context.launchedAtMs) + timeoutMs
      const launchedAtHostMs =
        rawSnapshot.hostCapturedAtMs +
        (context.launchedAtMs - rawSnapshot.localCapturedAtMs)
      let firstMatchAt: number | undefined
      let firstMatch: MatchedSession | undefined
      let pollMs = Math.max(1, initialPollMs)

      while (!context.signal.aborted) {
        const currentTime = now()
        const scan = await listSessionFiles(
          host,
          context.signal,
          context.artifact ?? DEFAULT_ARTIFACT,
        )
        const newPaths = scan.paths.filter((path) => !baseline.has(path))
        if (newPaths.length > MAX_NEW_CANDIDATES) return { status: 'ambiguous' }

        const matches = await matchingSessions(
          host,
          newPaths,
          context.cwd,
          launchedAtHostMs,
          scan.hostNowMs,
          context.signal,
        )
        if (matches.length > 1) return { status: 'ambiguous' }

        const match = matches[0]
        if (match) {
          if (
            firstMatch &&
            (firstMatch.sessionId !== match.sessionId ||
              firstMatch.rolloutPath.path !== match.rolloutPath.path)
          ) {
            return { status: 'ambiguous' }
          }
          firstMatch = match
          firstMatchAt ??= currentTime
          if (currentTime - firstMatchAt >= settleMs) {
            return {
              status: 'identified',
              sessionId: match.sessionId,
              sessionData: { rolloutPath: match.rolloutPath },
            }
          }
        }

        if (currentTime >= deadline) return { status: 'unavailable' }
        const remaining = deadline - currentTime
        const settleRemaining = firstMatchAt
          ? Math.max(1, settleMs - (currentTime - firstMatchAt))
          : remaining
        await sleep(Math.min(pollMs, remaining, settleRemaining), context.signal)
        pollMs = Math.min(maxPollMs, pollMs * 2)
      }

      return { status: 'unavailable' }
    },
  }
}

export const codexSessionDiscovery = createCodexSessionDiscovery()

async function listSessionFiles(
  host: ProjectHost,
  signal?: AbortSignal,
  artifact?: HarnessArtifactContext,
): Promise<SessionFileScan> {
  const result = await host.exec('sh', ['-c', LIST_SESSION_FILES_SCRIPT], {
    signal,
    maxBuffer: LIST_MAX_BUFFER,
    env: artifact?.environment,
    unsetEnv: artifact?.unsetEnvironment,
  })
  if (result.code !== 0) {
    throw new Error(
      `Codex session scan failed (${result.code ?? result.signal ?? 'exit'})`,
    )
  }
  const [clock = '', ...paths] = result.stdout.split('\0').filter(Boolean)
  const hostSeconds = Number(clock.startsWith('hvir-clock:') ? clock.slice(11) : NaN)
  if (!Number.isFinite(hostSeconds)) {
    throw new Error('Codex session scan did not report the project host clock')
  }
  return { paths, hostNowMs: hostSeconds * 1_000 }
}

async function matchingSessions(
  host: ProjectHost,
  paths: readonly string[],
  cwd: HostPath,
  launchedAtHostMs: number,
  hostNowMs: number,
  signal: AbortSignal,
): Promise<MatchedSession[]> {
  const matches: MatchedSession[] = []
  for (const path of paths) {
    if (signal.aborted) break
    const filenameId = SESSION_ID_IN_FILENAME.exec(path)?.[1]
    if (!filenameId) continue
    const result = await host.exec('head', ['-n', '1', '--', path], {
      signal,
      maxBuffer: META_MAX_BUFFER,
    })
    if (result.code !== 0) continue
    const record = parseSessionMeta(result.stdout)
    if (!record) continue
    if (record.id.toLowerCase() !== filenameId.toLowerCase()) continue
    if (record.cwd !== cwd.path || record.originator !== 'codex-tui') continue
    if (
      record.timestampMs < launchedAtHostMs - LAUNCH_CLOCK_SLOP_MS ||
      record.timestampMs > hostNowMs + LAUNCH_CLOCK_SLOP_MS
    ) {
      continue
    }
    matches.push({
      sessionId: record.id,
      rolloutPath: hostPath(host.hostId, path),
    })
  }
  return matches
}

interface MatchedSession {
  readonly sessionId: string
  readonly rolloutPath: HostPath
}

function parseSessionMeta(value: string): {
  readonly id: string
  readonly cwd: string
  readonly originator: string
  readonly timestampMs: number
} | null {
  try {
    const envelope = JSON.parse(value) as SessionMetaEnvelope
    const payload = envelope.payload
    const timestampMs =
      typeof payload?.timestamp === 'string' ? Date.parse(payload.timestamp) : NaN
    if (
      envelope.type !== 'session_meta' ||
      typeof payload?.id !== 'string' ||
      typeof payload.cwd !== 'string' ||
      typeof payload.originator !== 'string' ||
      !Number.isFinite(timestampMs)
    ) {
      return null
    }
    return {
      id: payload.id,
      cwd: payload.cwd,
      originator: payload.originator,
      timestampMs,
    }
  } catch {
    return null
  }
}

function isSnapshot(value: unknown): value is CodexSessionSnapshot {
  if (!value || typeof value !== 'object') return false
  const paths = (value as { paths?: unknown }).paths
  const hostCapturedAtMs = (value as { hostCapturedAtMs?: unknown }).hostCapturedAtMs
  const localCapturedAtMs = (value as { localCapturedAtMs?: unknown }).localCapturedAtMs
  return (
    Array.isArray(paths) &&
    paths.every((path) => typeof path === 'string') &&
    typeof hostCapturedAtMs === 'number' &&
    Number.isFinite(hostCapturedAtMs) &&
    typeof localCapturedAtMs === 'number' &&
    Number.isFinite(localCapturedAtMs)
  )
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    const abort = (): void => finish()
    function finish(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve()
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
