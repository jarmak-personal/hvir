import { hostPathEquals, localPath } from '../../shared/host-path'
import { SKILLAGER_ACCEPTED_TRUST } from '../../shared/skillager'
import type { SkillagerContentSelection } from '../../shared/skillager-content'
import { SkillagerError } from './skillager-port'

/** Compare the ordinary read with the public CLI's selected accepted body, without hashing. */
export function validateSkillagerDocumentBody(
  payload: unknown,
  selected: SkillagerContentSelection,
  bytes: Uint8Array,
): void {
  const raw = payload as { skill?: Record<string, unknown>; content?: unknown } | null
  const skill = raw?.skill
  const source = skill?.source as Record<string, unknown> | undefined
  let text: string | undefined
  try {
    // Public show uses Python UTF-8 read_text: preserve BOM and normalize universal newlines.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(bytes)
      .replace(/\r\n?/g, '\n')
  } catch {
    /* Refuse an unrepresentable accepted text comparison. */
  }
  if (
    !selected.expectedHash ||
    !skill ||
    skill.id !== selected.skillId ||
    skill.content_hash !== selected.expectedHash ||
    !SKILLAGER_ACCEPTED_TRUST.some((trust) => trust === skill.trust) ||
    typeof skill.root !== 'string' ||
    typeof skill.entrypoint !== 'string' ||
    !hostPathEquals(localPath(skill.root), selected.root) ||
    !hostPathEquals(localPath(skill.entrypoint), selected.path) ||
    (selected.kind === 'library' && source?.library_id !== selected.libraryId) ||
    typeof raw?.content !== 'string' ||
    text === undefined ||
    raw.content !== text
  )
    throw new SkillagerError(
      'stale-review',
      'The selected accepted search source changed or resolved to another file. Refresh search, or explicitly open its current file.',
    )
}
