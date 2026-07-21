/** Claude Code's cwd-qualified transcript location, behind the provider seam. */

import { hostPath, joinHostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'
import type { HarnessArtifactContext } from './harness-provider'

const CLAUDE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_RESOLVED_PATH_CHARACTERS = 16_384
const MAX_RESOLUTION_OUTPUT_BYTES = 32 * 1024
const MAX_PROJECT_DIRECTORY_CHARACTERS = 200

const RESOLVE_CLAUDE_ROOTS_SCRIPT = `
if [ -n "\${CLAUDE_CONFIG_DIR:-}" ]; then
  config_root=$CLAUDE_CONFIG_DIR
elif [ -n "\${HOME:-}" ]; then
  config_root=$HOME/.claude
else
  exit 1
fi
case "$config_root" in
  /*) ;;
  *) exit 1 ;;
esac
pwd -P || exit 1
printf '\\0%s' "$config_root"
`.trim()

export interface ClaudeSessionArtifactContext {
  readonly cwd: HostPath
  readonly sessionId: string
  readonly artifact: HarnessArtifactContext
}

export interface ClaudeSessionArtifactLocation {
  readonly projectsRoot: HostPath
  readonly projectDirectory: HostPath
  readonly transcript: HostPath
}

/**
 * Match Claude Code 2.1.216's project-directory derivation exactly.
 * The hash intentionally iterates JavaScript UTF-16 code units.
 */
export function claudeProjectDirectoryName(canonicalCwd: string): string {
  const sanitized = canonicalCwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_PROJECT_DIRECTORY_CHARACTERS) return sanitized
  const suffix = Math.abs(javaStringHash(canonicalCwd)).toString(36)
  return `${sanitized.slice(0, MAX_PROJECT_DIRECTORY_CHARACTERS)}-${suffix}`
}

/** Resolve exactly one profile- and cwd-qualified Claude transcript path. */
export async function resolveClaudeSessionArtifact(
  host: ProjectHost,
  context: ClaudeSessionArtifactContext,
  signal: AbortSignal,
): Promise<ClaudeSessionArtifactLocation | undefined> {
  if (
    signal.aborted ||
    context.cwd.hostId !== host.hostId ||
    !isBoundedAbsolutePath(context.cwd.path) ||
    !CLAUDE_SESSION_ID.test(context.sessionId)
  ) {
    return undefined
  }

  try {
    const result = await host.exec(
      'sh',
      ['-c', RESOLVE_CLAUDE_ROOTS_SCRIPT, 'hvir-claude-artifact-location'],
      {
        cwd: context.cwd,
        env: context.artifact.environment,
        unsetEnv: context.artifact.unsetEnvironment,
        signal,
        maxBuffer: MAX_RESOLUTION_OUTPUT_BYTES,
      },
    )
    if (signal.aborted || result.code !== 0 || result.outputTruncated) return undefined

    const separator = result.stdout.indexOf('\0')
    if (separator <= 0 || result.stdout.indexOf('\0', separator + 1) !== -1) {
      return undefined
    }
    const physicalCwdOutput = result.stdout.slice(0, separator)
    if (!physicalCwdOutput.endsWith('\n')) return undefined
    const canonicalCwd = physicalCwdOutput.slice(0, -1)
    const configRoot = result.stdout.slice(separator + 1)
    if (!isBoundedAbsolutePath(canonicalCwd) || !isBoundedAbsolutePath(configRoot)) {
      return undefined
    }

    const projectsRoot = joinHostPath(hostPath(host.hostId, configRoot), 'projects')
    const projectDirectory = joinHostPath(
      projectsRoot,
      claudeProjectDirectoryName(canonicalCwd),
    )
    return {
      projectsRoot,
      projectDirectory,
      transcript: joinHostPath(projectDirectory, `${context.sessionId}.jsonl`),
    }
  } catch {
    return undefined
  }
}

function javaStringHash(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return hash
}

function isBoundedAbsolutePath(value: string): boolean {
  return (
    value.startsWith('/') &&
    value.length <= MAX_RESOLVED_PATH_CHARACTERS &&
    !/[\0\r\n]/.test(value)
  )
}
