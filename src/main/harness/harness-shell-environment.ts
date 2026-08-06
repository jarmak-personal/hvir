/**
 * Run harness discovery and launches through the owning host's login-interactive
 * shell environment. GUI-launched desktop processes do not inherit the path a
 * user's login startup establishes (for example Homebrew in ~/.zprofile).
 */
const HARNESS_PROBE_OUTPUT_MARKER = '\x1ehvir-provider-output-v1\x1f'

export function harnessShellProbeArgs(executable: string): readonly string[] {
  return ['-lic', `command -v ${shellQuote(executable)} >/dev/null 2>&1`]
}

export function harnessShellCommandArgs(
  executable: string,
  args: readonly string[],
): readonly string[] {
  const command = [executable, ...args].map(shellQuote).join(' ')
  return ['-lic', `exec ${command}`]
}

/**
 * Bound provider-owned output after login startup, excluding diagnostics and
 * banners emitted before the detached shell reaches the command.
 */
export function harnessShellProbeCommandArgs(
  executable: string,
  args: readonly string[],
): readonly string[] {
  const command = [executable, ...args].map(shellQuote).join(' ')
  return ['-lic', `printf '\\036hvir-provider-output-v1\\037'; exec ${command} 2>&1`]
}

export function harnessShellProbeOutput(output: string): string | undefined {
  const boundary = output.indexOf(HARNESS_PROBE_OUTPUT_MARKER)
  return boundary === -1
    ? undefined
    : output.slice(boundary + HARNESS_PROBE_OUTPUT_MARKER.length)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
