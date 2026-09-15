import type { HostPath, Stat } from '../../shared'
import { SKILLAGER_REVIEW_FILE_BYTES } from '../../shared/skillager-review'
import { SkillagerError } from './skillager-port'

interface SkillagerFileReadPort {
  stat(path: HostPath): Promise<Stat>
  readFileChunks(path: HostPath, signal: AbortSignal): AsyncIterable<Uint8Array>
}

/** Stable bounded file bytes only; callers own confinement and any tree/approval proof. */
export async function readSkillagerFileBytes(
  host: SkillagerFileReadPort,
  path: HostPath,
  signal: AbortSignal,
  options: { readonly expectedSize?: number; readonly assertCurrent?: () => void } = {},
): Promise<Uint8Array> {
  const current = () => {
    signal.throwIfAborted()
    options.assertCurrent?.()
  }
  const stale = () =>
    new SkillagerError(
      'stale-review',
      'The skill file changed while it was read. Open it again.',
    )
  current()
  const before = await host.stat(path)
  current()
  if (before.type !== 'file') throw stale()
  if (before.size > SKILLAGER_REVIEW_FILE_BYTES)
    throw new SkillagerError('output-limit', 'Skill files must be at most 8 MiB.')
  const expected = options.expectedSize ?? before.size
  if (before.size !== expected) throw stale()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of host.readFileChunks(path, signal)) {
    current()
    size += chunk.byteLength
    if (size > expected || size > SKILLAGER_REVIEW_FILE_BYTES)
      throw new SkillagerError('output-limit', 'The skill file changed or exceeds 8 MiB.')
    chunks.push(Uint8Array.from(chunk))
  }
  const after = await host.stat(path)
  current()
  if (
    size !== expected ||
    after.type !== 'file' ||
    after.size !== before.size ||
    after.mode !== before.mode ||
    after.mtimeMs !== before.mtimeMs
  )
    throw stale()
  return Buffer.concat(chunks)
}
