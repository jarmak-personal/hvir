import type { ProjectHost } from '../project-host'
import type {
  HarnessResumeAvailability,
  HarnessResumeValidationContext,
} from './harness-provider'

const CLAUDE_RESUME_AVAILABILITY_SCRIPT = `
root=\${CLAUDE_CONFIG_DIR:-\${HOME}/.claude}/projects
session_id=$1
count=0
if [ ! -d "$root" ] || [ ! -r "$root" ] || [ ! -x "$root" ]; then
  printf unknown
  exit 0
fi
for candidate in "$root"/*/"$session_id.jsonl"; do
  [ -s "$candidate" ] || continue
  count=$((count + 1))
done
case "$count" in
  0) printf missing ;;
  1) printf available ;;
  *) printf ambiguous ;;
esac
`.trim()

const RESUME_CHECK_TIMEOUT_MS = 3_000

/**
 * Claude accepts a caller-supplied UUID before it has persisted any turns.
 * Resume is valid only after exactly one non-empty transcript exists for that
 * UUID in the profile-qualified artifact tree.
 */
export async function claudeResumeAvailability(
  host: ProjectHost,
  context: HarnessResumeValidationContext,
): Promise<HarnessResumeAvailability> {
  try {
    const result = await host.exec(
      'sh',
      [
        '-c',
        CLAUDE_RESUME_AVAILABILITY_SCRIPT,
        'hvir-claude-resume-check',
        context.sessionId,
      ],
      {
        env: context.artifact.environment,
        unsetEnv: context.artifact.unsetEnvironment,
        signal: AbortSignal.timeout(RESUME_CHECK_TIMEOUT_MS),
        maxBuffer: 4 * 1024,
      },
    )
    if (result.code !== 0) return 'unknown'
    return result.stdout === 'available'
      ? 'available'
      : result.stdout === 'missing'
        ? 'missing'
        : 'unknown'
  } catch {
    return 'unknown'
  }
}
