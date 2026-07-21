import type { ProjectHost } from '../project-host'
import type {
  HarnessResumeAvailability,
  HarnessResumeValidationContext,
} from './harness-provider'
import { resolveClaudeSessionArtifact } from './claude-session-artifact'

const CLAUDE_RESUME_AVAILABILITY_SCRIPT = `
root=$1
project_dir=$2
transcript=$3
if [ ! -d "$root" ] || [ ! -r "$root" ] || [ ! -x "$root" ]; then
  printf unknown
elif [ ! -e "$project_dir" ]; then
  printf missing
elif [ ! -d "$project_dir" ] || [ ! -r "$project_dir" ] || [ ! -x "$project_dir" ]; then
  printf unknown
elif [ ! -e "$transcript" ]; then
  printf missing
elif [ ! -f "$transcript" ] || [ ! -r "$transcript" ]; then
  printf unknown
elif [ -s "$transcript" ]; then
  printf available
else
  printf missing
fi
`.trim()

const RESUME_CHECK_TIMEOUT_MS = 3_000

/**
 * Claude accepts a caller-supplied UUID before it has persisted any turns.
 * Resume is valid only after a non-empty transcript exists at the exact path
 * Claude derives from this profile and physical launch cwd.
 */
export async function claudeResumeAvailability(
  host: ProjectHost,
  context: HarnessResumeValidationContext,
): Promise<HarnessResumeAvailability> {
  const signal = AbortSignal.timeout(RESUME_CHECK_TIMEOUT_MS)
  try {
    const location = await resolveClaudeSessionArtifact(host, context, signal)
    if (!location) return 'unknown'
    const result = await host.exec(
      'sh',
      [
        '-c',
        CLAUDE_RESUME_AVAILABILITY_SCRIPT,
        'hvir-claude-resume-check',
        location.projectsRoot.path,
        location.projectDirectory.path,
        location.transcript.path,
      ],
      {
        signal,
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
