/** Bounded artifact reads and scalar admission shared only by bundled providers. */

import type { HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

export const HARNESS_USAGE_ARTIFACT_BYTE_LIMIT = 8 * 1024 * 1024
export const HARNESS_USAGE_RECORD_BYTE_LIMIT = 256 * 1024

type HarnessUsageArtifactUnavailableReason = 'artifact-unavailable' | 'artifact-too-large'

export type HarnessUsageArtifactResult =
  | { readonly status: 'available' }
  | {
      readonly status: 'unavailable'
      readonly reason: HarnessUsageArtifactUnavailableReason
    }

export async function readHarnessUsageArtifact(
  host: ProjectHost,
  path: HostPath,
  signal: AbortSignal,
): Promise<
  | { readonly status: 'available'; readonly content: string }
  | {
      readonly status: 'unavailable'
      readonly reason: HarnessUsageArtifactUnavailableReason
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

/** Incrementally visits complete JSONL records without retaining the whole artifact. */
export async function scanHarnessUsageArtifactLines(
  host: ProjectHost,
  path: HostPath,
  signal: AbortSignal,
  handlers: {
    readonly visit: (line: string) => void
    readonly oversized: () => void
  },
  maxRecordBytes = HARNESS_USAGE_RECORD_BYTE_LIMIT,
): Promise<HarnessUsageArtifactResult> {
  const transfer = host.fileTransfer
  if (!transfer) return { status: 'unavailable', reason: 'artifact-unavailable' }

  let parts: Buffer[] = []
  let lineBytes = 0
  let discarding = false
  const visitRetainedLine = (): void => {
    if (lineBytes === 0) return
    handlers.visit(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)))
  }
  try {
    for await (const chunk of transfer.readFileChunks(path, { signal })) {
      signal.throwIfAborted()
      const value = Buffer.from(chunk)
      let offset = 0
      while (offset < value.byteLength) {
        const newline = value.indexOf(0x0a, offset)
        const end = newline === -1 ? value.byteLength : newline
        const part = value.subarray(offset, end)
        if (!discarding) {
          if (lineBytes + part.byteLength <= maxRecordBytes) {
            if (part.byteLength > 0) {
              parts.push(Buffer.from(part))
              lineBytes += part.byteLength
            }
          } else {
            parts = []
            lineBytes = 0
            discarding = true
            handlers.oversized()
          }
        }
        if (newline === -1) break
        if (!discarding) visitRetainedLine()
        parts = []
        lineBytes = 0
        discarding = false
        offset = newline + 1
      }
    }
    signal.throwIfAborted()
    if (!discarding) visitRetainedLine()
    return { status: 'available' }
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
