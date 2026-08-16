import {
  calculateHarnessUsageDelta,
  isHarnessUsageSnapshot,
  type HarnessUsageSnapshot,
} from '../src/main/harness/agent-work-usage'
import { harnessProvider } from '../src/main/harness/harness-provider'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared'

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
  if (!isHarnessUsageSnapshot(parsed)) {
    throw new Error('The start snapshot does not use the supported schema.')
  }
  return parsed
}
