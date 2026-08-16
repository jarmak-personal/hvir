/** Bounded artifact reads and scalar admission shared only by bundled providers. */

import type { HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

export const HARNESS_USAGE_ARTIFACT_BYTE_LIMIT = 8 * 1024 * 1024

export async function readHarnessUsageArtifact(
  host: ProjectHost,
  path: HostPath,
  signal: AbortSignal,
): Promise<
  | { readonly status: 'available'; readonly content: string }
  | {
      readonly status: 'unavailable'
      readonly reason: 'artifact-unavailable' | 'artifact-too-large'
    }
> {
  try {
    const workload = await host.readTextFilePrefix(
      path,
      HARNESS_USAGE_ARTIFACT_BYTE_LIMIT,
      { signal },
    )
    if (!workload.complete) {
      return { status: 'unavailable', reason: 'artifact-too-large' }
    }
    if (workload.validUtf8 === false) {
      return { status: 'unavailable', reason: 'artifact-unavailable' }
    }
    return { status: 'available', content: workload.content }
  } catch {
    return { status: 'unavailable', reason: 'artifact-unavailable' }
  }
}

export function boundedHarnessUsageString(
  value: unknown,
  maxLength = 160,
): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    ? value
    : undefined
}

export function nonNegativeUsageCounter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}
