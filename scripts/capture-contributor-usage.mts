import { harnessProvider } from '../src/main/harness/harness-provider'
import { normalizedHarnessUsageTotal } from '../src/main/harness/harness-usage'
import { LocalHost } from '../src/main/project-host/local-host'
import { localPath } from '../src/shared'

/** Exact identity is supplied privately by the calling harness, never discovered from neighbors. */
export async function captureContributorUsage(input: {
  provider: 'codex' | 'claude-code'
  session: string
  cwd: string
  artifactEnvironment: Record<string, string>
}): Promise<{ tokens: number } | { unavailable: string }> {
  const provider = harnessProvider(input.provider)
  if (!provider.usageSnapshots) return { unavailable: 'unsupported-telemetry' }
  const host = new LocalHost()
  const signal = AbortSignal.timeout(30_000)
  try {
    await host.connect()
    const snapshot = await provider.usageSnapshots.snapshot(host, {
      sessionId: input.session,
      cwd: localPath(input.cwd),
      signal,
      purpose: 'contributor',
      artifact: {
        identity: 'contributor-status',
        environment: input.artifactEnvironment,
        unsetEnvironment: [],
      },
    })
    if (signal.aborted) return { unavailable: 'artifact-unavailable' }
    if (snapshot.status === 'unavailable') return { unavailable: snapshot.reason }
    const tokens = normalizedHarnessUsageTotal(snapshot.counters)
    return tokens === undefined ? { unavailable: 'usage-unavailable' } : { tokens }
  } catch {
    return { unavailable: 'artifact-unavailable' }
  } finally {
    await host.dispose()
  }
}
