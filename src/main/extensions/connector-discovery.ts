import { join } from 'node:path'
import type { ProjectHost } from '../project-host/project-host'
import { canonicalExecutablePath } from './connector-approval'
import { connectorExecutableBasename } from '../../shared/extensions/connectors'

/** Passive local metadata only; canonical aliases denote a single installed program. */
export async function discoverConnectorExecutables(
  host: Pick<ProjectHost, 'hostId' | 'realpath' | 'stat'>,
  executable: string,
  folders: readonly string[],
  current: () => void,
): Promise<{ readonly candidates: readonly string[]; readonly complete: boolean }> {
  connectorExecutableBasename(executable)
  const candidates = new Set<string>()
  let complete = true
  for (const folder of [...new Set(folders)].slice(0, 32)) {
    current()
    if (!folder.startsWith('/') || folder.includes('\0') || folder.length > 4096) continue
    let canonical: string
    try {
      canonical = await canonicalExecutablePath(host, join(folder, executable))
    } catch (reason) {
      current()
      if (!absentExecutableMetadata(reason)) complete = false
      continue
    }
    current()
    candidates.add(canonical)
  }
  return { candidates: [...candidates], complete }
}

/** Only specific absence is known; unreadable or unresolved metadata remains incomplete. */
export function absentExecutableMetadata(reason: unknown): boolean {
  return (
    !!reason &&
    typeof reason === 'object' &&
    'code' in reason &&
    ['ENOENT', 'ENOTDIR', 'NOT_EXECUTABLE'].includes(String(reason.code))
  )
}
