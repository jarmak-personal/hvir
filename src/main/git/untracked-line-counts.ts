import { DIFF_INPUT_BYTE_LIMIT, type HostPath, type TextWorkload } from '../../shared'
import type { GitCommandContext } from './git-command-context'
import { projectFilePath, type GitFileStats, type ParsedStatus } from './git-parsers'

const UNTRACKED_LINE_COUNT_REQUEST_BYTE_LIMIT = 16 * 1024 * 1024
const UNTRACKED_BINARY_PROBE_BYTES = 8_000
const UNTRACKED_LINE_COUNT_CONCURRENCY = 8

interface CountCandidate {
  readonly file: ParsedStatus
  readonly path: HostPath
  readonly size: number
}

/** Add bounded decorative line counts without spawning one Git process per row. */
export async function addUntrackedLineCounts(
  projectRoot: HostPath,
  repositoryPrefix: string,
  files: readonly ParsedStatus[],
  stats: GitFileStats,
  context: GitCommandContext,
): Promise<void> {
  const untracked = files.filter((file) => file.untracked && !stats.has(file.path))
  const inspected: CountCandidate[] = []
  for (
    let index = 0;
    index < untracked.length;
    index += UNTRACKED_LINE_COUNT_CONCURRENCY
  ) {
    const batch = await Promise.all(
      untracked
        .slice(index, index + UNTRACKED_LINE_COUNT_CONCURRENCY)
        .map(async (file) =>
          inspectCandidate(file, projectRoot, repositoryPrefix, context),
        ),
    )
    inspected.push(
      ...batch.filter((candidate): candidate is CountCandidate => Boolean(candidate)),
    )
  }

  let availableBytes = UNTRACKED_LINE_COUNT_REQUEST_BYTE_LIMIT
  const selected: CountCandidate[] = []
  for (const candidate of inspected) {
    if (candidate.size === 0) {
      stats.set(candidate.file.path, { additions: 0, deletions: 0 })
      continue
    }
    const reservedBytes = maximumReadBytes(candidate.size)
    if (reservedBytes > availableBytes) continue
    availableBytes -= reservedBytes
    selected.push(candidate)
  }

  for (
    let index = 0;
    index < selected.length;
    index += UNTRACKED_LINE_COUNT_CONCURRENCY
  ) {
    await Promise.all(
      selected
        .slice(index, index + UNTRACKED_LINE_COUNT_CONCURRENCY)
        .map(async (candidate) => {
          const additions = await countTextLines(candidate, context)
          if (additions !== undefined) {
            stats.set(candidate.file.path, { additions, deletions: 0 })
          }
        }),
    )
  }
}

async function inspectCandidate(
  file: ParsedStatus,
  projectRoot: HostPath,
  repositoryPrefix: string,
  context: GitCommandContext,
): Promise<CountCandidate | undefined> {
  const path = projectFilePath(projectRoot, repositoryPrefix, file.path)
  try {
    const metadata = await context.host.stat(path)
    if (
      metadata.type !== 'file' ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      metadata.size > DIFF_INPUT_BYTE_LIMIT
    ) {
      return undefined
    }
    return { file, path, size: metadata.size }
  } catch {
    // Status and the live worktree may race; an unavailable count is truthful.
    return undefined
  }
}

async function countTextLines(
  candidate: CountCandidate,
  context: GitCommandContext,
): Promise<number | undefined> {
  try {
    const probe = await context.host.readTextFilePrefix(
      candidate.path,
      Math.min(candidate.size, UNTRACKED_BINARY_PROBE_BYTES),
    )
    if (!isCountableText(probe)) return undefined
    if (probe.complete) return addedLineCount(probe.content)
    if (candidate.size <= UNTRACKED_BINARY_PROBE_BYTES) return undefined

    const content = await context.host.readTextFilePrefix(candidate.path, candidate.size)
    return content.complete && isCountableText(content)
      ? addedLineCount(content.content)
      : undefined
  } catch {
    // Deletion, replacement, or transport failure after status omits only this count.
    return undefined
  }
}

function maximumReadBytes(size: number): number {
  return size <= UNTRACKED_BINARY_PROBE_BYTES
    ? size + 1
    : size + UNTRACKED_BINARY_PROBE_BYTES + 2
}

function isCountableText(workload: TextWorkload): boolean {
  return workload.validUtf8 === true && !workload.content.includes('\0')
}

function addedLineCount(content: string): number {
  if (!content) return 0
  let lines = content.endsWith('\n') ? 0 : 1
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1
  }
  return lines
}
