import { hostPath, type HostPath } from '../../shared'
import type { ProjectHost } from '../project-host'

const MAX_COMMAND_OUTPUT = 4 * 1024
const CONTROL_TIMEOUT_MS = 8_000

export interface RemoteImagePasteStoragePort {
  stage(host: ProjectHost, bytes: Uint8Array, signal: AbortSignal): Promise<HostPath>
  remove(host: ProjectHost, path: HostPath): Promise<void>
}

/** Private, collision-safe remote materialization behind ProjectHost. */
export class RemoteImagePasteStorage implements RemoteImagePasteStoragePort {
  private readonly reconciledHosts = new Set<string>()

  async stage(
    host: ProjectHost,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<HostPath> {
    if (!this.reconciledHosts.has(host.hostId)) {
      const reconciled = await boundedExec(host, RECONCILE_SCRIPT, [], signal)
      if (reconciled.code !== 0) throw new Error('Remote image cleanup unavailable')
      this.reconciledHosts.add(host.hostId)
    }
    const created = await boundedExec(host, CREATE_SCRIPT, [], signal)
    if (created.code !== 0) throw new Error('Remote image staging unavailable')
    const rawPath = created.stdout.trim()
    if (!safeStagedPath(rawPath)) throw new Error('Remote image staging returned no path')
    const path = hostPath(host.hostId, rawPath)
    try {
      await host.writeFile(path, bytes, { signal })
      signal.throwIfAborted()
      const stat = await host.stat(path)
      signal.throwIfAborted()
      if (
        stat.type !== 'file' ||
        stat.size !== bytes.byteLength ||
        (stat.mode & 0o777) !== 0o600
      ) {
        throw new Error('Remote image staging verification failed')
      }
      return path
    } catch (error) {
      await this.remove(host, path).catch(() => undefined)
      throw error
    }
  }

  async remove(host: ProjectHost, path: HostPath): Promise<void> {
    if (path.hostId !== host.hostId || !safeStagedPath(path.path)) return
    await host.removeFile(path, { ignoreMissing: true })
    const result = await boundedExec(host, CLEANUP_SCRIPT, [path.path])
    if (result.code !== 0) throw new Error('Remote image cleanup failed')
  }
}

function safeStagedPath(path: string): boolean {
  return (
    path.startsWith('/') &&
    !hasControl(path) &&
    /^[A-Za-z0-9_./-]+$/.test(path) &&
    /\/image-paste\/paste\.[A-Za-z0-9]+\/image\.png$/.test(path)
  )
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
}

async function boundedExec(
  host: ProjectHost,
  script: string,
  args: readonly string[],
  parentSignal?: AbortSignal,
): Promise<Awaited<ReturnType<ProjectHost['exec']>>> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (parentSignal?.aborted) abort()
  else parentSignal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS)
  try {
    return await host.exec('sh', ['-c', script, 'hvir-image-paste', ...args], {
      signal: controller.signal,
      maxBuffer: MAX_COMMAND_OUTPUT,
    })
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abort)
  }
}

const ROOT_SCRIPT = `
uid=$(id -u)
safe_parent() {
  candidate=$1
  case "$candidate" in /*) ;; *) return 1 ;; esac
  case "$candidate" in *[!A-Za-z0-9_./-]*) return 1 ;; esac
  return 0
}
runtime=\${XDG_RUNTIME_DIR-}
if safe_parent "$runtime"; then
  parent=$runtime
  base=$parent/hvir
else
  parent=\${TMPDIR:-/tmp}
  safe_parent "$parent" || parent=/tmp
  base=$parent/hvir-$uid
fi
root=$base/image-paste
`

const CREATE_SCRIPT = String.raw`set -eu
umask 077
${ROOT_SCRIPT}
[ -d "$parent" ] || exit 70
private_dir() {
  dir=$1
  if [ -e "$dir" ]; then
    [ -d "$dir" ] && [ ! -L "$dir" ] || exit 71
  else
    mkdir "$dir"
  fi
  owner=$(stat -c %u "$dir" 2>/dev/null || stat -f %u "$dir")
  [ "$owner" = "$uid" ] || exit 72
  chmod 700 "$dir"
}
private_dir "$base"
private_dir "$root"
leaf=$(mktemp -d "$root/paste.XXXXXXXX")
chmod 700 "$leaf"
image=$leaf/image.png
: > "$image"
chmod 600 "$image"
printf '%s\n' "$image"
`

const RECONCILE_SCRIPT = String.raw`set -eu
${ROOT_SCRIPT}
[ -e "$root" ] || exit 0
for dir in "$base" "$root"; do
  [ -d "$dir" ] && [ ! -L "$dir" ] || exit 71
  owner=$(stat -c %u "$dir" 2>/dev/null || stat -f %u "$dir")
  [ "$owner" = "$uid" ] || exit 72
done
find "$root" -type f -name image.png -path "$root/paste.*/image.png" -mtime +0 -exec rm -f {} \;
find "$root" -type d -name 'paste.*' -empty -exec rmdir {} \;
`

const CLEANUP_SCRIPT = `set -eu
file=$1
case "$file" in
  /*/image-paste/paste.*/image.png) ;;
  *) exit 64 ;;
esac
dir=\${file%/image.png}
rmdir "$dir" 2>/dev/null || true
`
