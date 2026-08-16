import {
  calculateHarnessUsageDelta,
  nonNegativeUsageCounter,
  type HarnessUsageSnapshot,
} from '../src/main/harness/agent-work-usage'
import { harnessProvider } from '../src/main/harness/harness-provider'
import { LocalHost } from '../src/main/project-host/local-host'
import {
  AGENT_WORK_TOKEN_COUNTER_NAMES,
  HARNESS_USAGE_UNAVAILABLE_REASONS,
  localPath,
} from '../src/shared'

const STDIN_BYTE_LIMIT = 64 * 1024

export async function runHarnessUsageProof(args: readonly string[]): Promise<number> {
  const [mode, providerId] = args
  if (
    !mode ||
    !['snapshot', 'delta'].includes(mode) ||
    !providerId ||
    !['codex', 'claude-code'].includes(providerId)
  ) {
    throw new Error('Usage: prove-harness-usage <snapshot|delta> <provider>')
  }
  const provider = harnessProvider(providerId)
  if (!provider.usageSnapshots) {
    throw new Error('The selected provider does not expose usage snapshots.')
  }
  const sessionId = requiredEnvironment('HVIR_USAGE_SESSION_ID')
  const cwd = requiredEnvironment('HVIR_USAGE_CWD')
  const artifactEnvironment =
    providerId === 'codex'
      ? selectedEnvironment('CODEX_HOME')
      : providerId === 'claude-code'
        ? selectedEnvironment('CLAUDE_CONFIG_DIR')
        : {}
  const host = new LocalHost()
  await host.connect()
  try {
    const end = await provider.usageSnapshots.snapshot(host, {
      sessionId,
      cwd: localPath(cwd),
      artifact: {
        identity: 'agent-work-live-proof',
        environment: artifactEnvironment,
        unsetEnvironment: [],
      },
      signal: new AbortController().signal,
    })
    if (mode === 'snapshot') {
      process.stdout.write(`${JSON.stringify(end, null, 2)}\n`)
      return end.status === 'available' ? 0 : 2
    }
    const start = parseSnapshot(await readBoundedStdin())
    const delta = calculateHarnessUsageDelta(start, end)
    process.stdout.write(`${JSON.stringify(delta, null, 2)}\n`)
    return delta.status === 'unavailable' ? 2 : 0
  } finally {
    await host.dispose()
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required ${name} environment.`)
  return value
}

function selectedEnvironment(name: string): Record<string, string> {
  const value = process.env[name]
  return value ? { [name]: value } : {}
}

async function readBoundedStdin(): Promise<string> {
  process.stdin.setEncoding('utf8')
  let input = ''
  let bytes = 0
  for await (const chunk of process.stdin) {
    if (typeof chunk !== 'string') {
      throw new Error('The start snapshot is not UTF-8 text.')
    }
    bytes += Buffer.byteLength(chunk)
    if (bytes > STDIN_BYTE_LIMIT) {
      throw new Error('The start snapshot exceeds the proof input bound.')
    }
    input += chunk
  }
  return input
}

function parseSnapshot(value: string): HarnessUsageSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('The start snapshot is not valid JSON.')
  }
  if (!isProofHarnessUsageSnapshot(parsed)) {
    throw new Error('The start snapshot does not use the supported schema.')
  }
  return parsed
}

export function isProofHarnessUsageSnapshot(
  value: unknown,
): value is HarnessUsageSnapshot {
  if (!isRecord(value) || value.version !== 1) return false
  if (
    typeof value.providerId !== 'string' ||
    value.providerId.length < 1 ||
    value.providerId.length > 64 ||
    nonNegativeUsageCounter(value.observedAt) === undefined
  ) {
    return false
  }
  if (value.status === 'unavailable') {
    return (
      exactKeys(value, ['version', 'status', 'providerId', 'observedAt', 'reason']) &&
      HARNESS_USAGE_UNAVAILABLE_REASONS.some((reason) => reason === value.reason)
    )
  }
  if (
    value.status !== 'available' ||
    !isRecord(value.route) ||
    !isRecord(value.counters) ||
    !isRecord(value.timing)
  ) {
    return false
  }
  const route = value.route
  const counters = value.counters
  const timing = value.timing
  if (
    !exactKeys(value, [
      'version',
      'status',
      'providerId',
      'observedAt',
      'route',
      'counters',
      'timing',
    ])
  ) {
    return false
  }
  if (
    !exactKeys(route, ['modelId', 'reasoningEffort'], true) ||
    !optionalBoundedString(route.modelId, 160) ||
    !optionalBoundedString(route.reasoningEffort, 64)
  ) {
    return false
  }
  if (!exactKeys(counters, AGENT_WORK_TOKEN_COUNTER_NAMES, true)) return false
  if (
    !exactKeys(timing, ['modelOrApiMilliseconds'], true) ||
    (timing.modelOrApiMilliseconds !== undefined &&
      nonNegativeUsageCounter(timing.modelOrApiMilliseconds) === undefined)
  ) {
    return false
  }
  return AGENT_WORK_TOKEN_COUNTER_NAMES.every(
    (name) =>
      counters[name] === undefined ||
      nonNegativeUsageCounter(counters[name]) !== undefined,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  allowMissing = false,
): boolean {
  const keys = Object.keys(value)
  return (
    keys.every((key) => allowed.includes(key)) &&
    (allowMissing || allowed.every((key) => keys.includes(key)))
  )
}

function optionalBoundedString(value: unknown, maxLength: number): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length > 0 && value.length <= maxLength)
  )
}
