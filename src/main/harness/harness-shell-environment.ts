/**
 * Run harness discovery and launches through the owning host's login-interactive
 * shell environment. GUI-launched desktop processes do not inherit the path a
 * user's login startup establishes (for example Homebrew in ~/.zprofile).
 */
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
