import { join } from 'node:path'
import type { ProjectHost } from '../project-host/project-host'
import { canonicalExecutablePath } from './connector-approval'

/** Passive local metadata only; canonical aliases denote a single installed program. */
export async function discoverConnectorExecutables(
  host: Pick<ProjectHost, 'hostId' | 'realpath' | 'stat'>,
  executable: string,
  folders: readonly string[],
  current: () => void,
): Promise<readonly string[]> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(executable))
    throw new Error('Invalid declared executable basename')
  const candidates = new Set<string>()
  for (const folder of [...new Set(folders)].slice(0, 32)) {
    current()
    if (!folder.startsWith('/') || folder.includes('\0') || folder.length > 4096) continue
    let canonical: string
    try {
      canonical = await canonicalExecutablePath(host, join(folder, executable))
    } catch (reason) {
      current()
      if (
        !['ENOENT', 'ENOTDIR', 'NOT_EXECUTABLE'].includes(
          String((reason as { code?: unknown }).code),
        )
      )
        throw reason
      continue
    }
    current()
    candidates.add(canonical)
  }
  return [...candidates]
}
