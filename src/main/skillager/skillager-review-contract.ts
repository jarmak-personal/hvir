import {
  hostPathEquals,
  joinHostPath,
  localPath,
  type HostPath,
} from '../../shared/host-path'
import type {
  SkillagerAcceptance,
  SkillagerHistory,
  SkillagerReviewDiff,
} from '../../shared/skillager-review'
import type { SkillagerLibrary } from '../../shared/skillager'
import { SkillagerError } from './skillager-port'

export function reviewObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed()
  return value as Record<string, unknown>
}
export function reviewText(value: unknown, max = 1024): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0'))
    return malformed()
  return value
}
export function reviewHash(value: unknown): string {
  const hash = reviewText(value, 64)
  if (!/^[0-9a-f]{64}$/.test(hash)) return malformed()
  return hash
}
export function reviewSkillRoot(library: SkillagerLibrary, id: string): HostPath {
  if (!/^lib\/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u.test(id) || id.length > 68)
    throw new SkillagerError('invalid-request', 'Select an owned personal-library skill.')
  return joinHostPath(library.skillsRoot, id.slice(4))
}
function skillIdentity(value: unknown, id: string, root: HostPath) {
  const skill = reviewObject(value)
  if (skill.id !== id || !hostPathEquals(localPath(reviewText(skill.path, 16384)), root))
    malformed()
  return skill
}
export function parseAcceptancePreview(value: unknown, id: string, root: HostPath) {
  const data = reviewObject(value)
  if (data.schema !== 'skillager.library-accept.v1' || data.status !== 'preview')
    malformed()
  const skill = skillIdentity(data.skill, id, root)
  const hash = reviewHash(skill.working_hash)
  const lint = reviewObject(data.lint),
    scan = reviewObject(data.scan),
    git = reviewObject(data.git)
  if (typeof data.requires_override !== 'boolean' || !Array.isArray(git.conflicts))
    malformed()
  const scanRisk = reviewText(scan.risk, 32),
    lintStatus = reviewText(lint.status, 32)
  const refusal = data.requires_override
    ? 'Scanner or lint findings require review in your local terminal. Hvir does not apply overrides.'
    : git.conflicts.length || git.operation
      ? 'Resolve the library Git conflict or operation in your local terminal before accepting.'
      : undefined
  let confirmationToken: string | undefined
  if (!refusal) {
    if (!Array.isArray(data.next_command_argv)) malformed()
    const argv = data.next_command_argv.map((item) => reviewText(item, 1024))
    if (
      argv.length !== 8 ||
      argv[0] !== 'skillager' ||
      argv[1] !== 'library' ||
      argv[2] !== 'accept' ||
      argv[3] !== id ||
      argv[4] !== '--json' ||
      argv[5] !== '--yes' ||
      argv[6] !== '--confirmation-token'
    )
      malformed()
    confirmationToken = reviewText(argv[7], 256)
    if (!/^[a-zA-Z0-9._:-]+$/.test(confirmationToken)) malformed()
  }
  const findings = [lint, scan].flatMap((report) => {
    if (!Array.isArray(report.findings) || report.findings.length > 512)
      return malformed()
    return report.findings.map((item) => {
      const finding = reviewObject(item)
      return `${reviewText(finding.severity ?? 'finding', 32)} · ${reviewText(finding.code, 128)}`
    })
  })
  return {
    hash,
    scanRisk,
    lintStatus,
    findings,
    refusal,
    confirmationToken,
    canAccept:
      !refusal && !['reviewed', 'trusted', 'pinned'].includes(String(skill.trust)),
  }
}
export function verifySnapshotLibrary(value: unknown, root: HostPath): void {
  const data = reviewObject(value),
    library = reviewObject(data.library)
  if (
    data.schema !== 'skillager.library-init.v1' ||
    data.status !== 'initialized' ||
    data.created !== true ||
    data.git_repository_created !== false ||
    data.commit !== null ||
    data.indexed !== 0 ||
    reviewObject(data.git).mode !== 'disabled' ||
    reviewObject(data.history).available !== false ||
    !Array.isArray(data.errors) ||
    data.errors.length ||
    library.namespace !== 'lib' ||
    library.registration !== 'valid' ||
    !hostPathEquals(localPath(reviewText(library.root, 16384)), root) ||
    !hostPathEquals(
      localPath(reviewText(library.skills_path, 16384)),
      joinHostPath(root, 'skills'),
    )
  )
    malformed()
}
export function verifySnapshotPreview(
  value: unknown,
  id: string,
  root: HostPath,
  hash: string,
): void {
  const data = reviewObject(value)
  const preview = parseAcceptancePreview(value, id, root)
  const skill = reviewObject(data.skill)
  if (
    !['discovered', 'lint_blocked'].includes(String(skill.trust)) ||
    reviewObject(data.git).mode !== 'disabled' ||
    data.approval !== undefined
  )
    malformed()
  if (preview.hash !== hash)
    throw new SkillagerError(
      'stale-review',
      'The captured skill differs from its acceptance preview. Review it again.',
    )
}
export function parseReviewHistory(
  value: unknown,
  id: string,
  root: HostPath,
): SkillagerHistory {
  const data = reviewObject(value)
  if (
    data.schema !== 'skillager.library-history.v1' ||
    typeof data.available !== 'boolean' ||
    !Array.isArray(data.versions) ||
    data.versions.length > 512
  )
    malformed()
  skillIdentity(data.skill, id, root)
  return {
    available: data.available,
    reason: data.reason == null ? undefined : reviewText(data.reason, 128),
    versions: data.versions.map((item) => {
      const version = reviewObject(item)
      if (typeof version.accepted !== 'boolean' || typeof version.current !== 'boolean')
        malformed()
      return {
        hash: reviewHash(version.content_hash),
        committedAt: reviewText(version.committed_at, 128),
        accepted: version.accepted,
        current: version.current,
      }
    }),
  }
}
export function parseReviewDiff(
  value: unknown,
  id: string,
  root: HostPath,
  hash: string,
): SkillagerReviewDiff {
  const data = reviewObject(value)
  if (
    data.schema !== 'skillager.library-diff.v1' ||
    data.status !== 'ready' ||
    data.content_bearing !== true
  )
    malformed()
  skillIdentity(data.skill, id, root)
  const to = reviewHash(reviewObject(data.to).content_hash)
  if (to !== hash)
    throw new SkillagerError(
      'stale-review',
      'The library changed. Review the new version.',
    )
  const from = reviewObject(data.from).content_hash
  return {
    fromHash: from == null ? undefined : reviewHash(from),
    toHash: to,
    text: reviewText(data.diff, 8 * 1024 * 1024),
  }
}
export function parseReviewAccepted(
  value: unknown,
  id: string,
  root: HostPath,
  hash: string,
): SkillagerAcceptance {
  const data = reviewObject(value)
  if (data.schema !== 'skillager.library-accept.v1' || data.status !== 'accepted')
    malformed()
  const skill = skillIdentity(data.skill, id, root),
    approval = reviewObject(data.approval)
  if (
    reviewHash(approval.content_hash) !== hash ||
    reviewHash(skill.working_hash) !== hash ||
    approval.state !== 'reviewed'
  )
    malformed()
  return { status: 'accepted', hash }
}
function malformed(): never {
  throw new SkillagerError(
    'malformed-result',
    'Skillager returned an unsupported review result.',
  )
}
