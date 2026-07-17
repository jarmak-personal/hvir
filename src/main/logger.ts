/**
 * Minimal file-based diagnostic logger.
 *
 * hvir is normally launched by the npm launcher with the packaged binary's
 * stdio fully discarded (npm/launcher/hvir.mjs runs it with `stdio: 'ignore'`
 * unless HVIR_SMOKE is set), so console.log/console.error never reach
 * anywhere a user can see them. This file is the one durable trail a stuck
 * or crashed launch leaves behind: single timestamped lines appended
 * synchronously, so an entry survives even if the process hangs or is killed
 * immediately after writing it.
 *
 * Deliberately kept outside the ProjectHost seam (ADR-010) and given its own
 * lint exemption below: the log always belongs to the local machine hvir is
 * running on, regardless of which ProjectHost (local today, remote later) a
 * project session happens to be using, and it must keep working even before
 * any ProjectHost exists — for example a startup failure before a project is
 * opened. Routing it through LocalHost.writeFile would tie a cross-cutting
 * diagnostic concern to a per-project abstraction that may not be local, and
 * would make every log call async at exactly the moments (startup failure,
 * PTY timeout) where a synchronous best-effort write is more useful.
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

let resolvedPath: string | undefined

function logFilePath(): string | undefined {
  if (resolvedPath) return resolvedPath
  try {
    // app.getPath('userData') throws before Electron finishes bootstrapping,
    // so an early log call (e.g. before app-ready) is simply dropped — but we
    // do NOT latch that failure: a later call once the app is ready resolves
    // and caches the path, so logging recovers on its own. Optional chaining
    // also tolerates environments where `app` is absent (unit tests).
    if (!app?.isReady?.()) return undefined
    resolvedPath = join(app.getPath('userData'), 'hvir.log')
    return resolvedPath
  } catch {
    return undefined
  }
}

/**
 * Append one timestamped line to hvir.log under the app's userData
 * directory. Never throws — a logging failure must never affect app
 * behavior, so callers can treat this as fire-and-forget.
 */
export function log(scope: string, message: string, detail?: Record<string, unknown>): void {
  const path = logFilePath()
  if (!path) return
  try {
    const timestamp = new Date().toISOString()
    const detailText = detail ? ` ${stringifyDetail(detail)}` : ''
    appendFileSync(path, `${timestamp} [${scope}] ${message}${detailText}\n`)
  } catch {
    // Best-effort only (e.g. disk full, permissions). Nothing useful to do.
  }
}

function stringifyDetail(detail: Record<string, unknown>): string {
  try {
    return JSON.stringify(detail)
  } catch {
    return '"[unserializable detail]"'
  }
}
