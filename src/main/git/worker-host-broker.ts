import {
  hostPath,
  type ExecResult,
  type HostPath,
  type WorkerHostCall,
} from '../../shared'
import type { ProjectHost } from '../project-host'

const canonicalRoots = new WeakMap<ProjectHost, Map<string, Promise<HostPath>>>()

/** Main-side enforcement for the untrusted Git utility-process transport. */
export async function dispatchWorkerHostCall(
  call: WorkerHostCall,
  project: { readonly host: ProjectHost; readonly root: HostPath } | null,
): Promise<ExecResult | string> {
  if (!project || call.hostId !== project.host.hostId) {
    throw new Error('git worker requested an inactive host')
  }
  const { host, root } = project
  if (call.operation === 'readTextFile') {
    await assertProjectPath(call.path, root, host)
    return host.readTextFile(call.path)
  }
  if (call.command !== 'git') throw new Error('git worker may execute only git')
  if (
    call.args.length < 3 ||
    call.args.length > 256 ||
    call.args.some((arg) => typeof arg !== 'string' || arg.length > 16_384) ||
    call.args[0] !== '-C' ||
    typeof call.args[1] !== 'string'
  ) {
    throw new Error('git worker supplied an invalid command')
  }
  const commandRoot = hostPath(root.hostId, call.args[1])
  await assertProjectPath(commandRoot, root, host)
  if (call.cwd) await assertProjectPath(call.cwd, root, host)
  const maxBuffer = call.maxBuffer ?? 10 * 1024 * 1024
  if (
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer < 1 ||
    maxBuffer > 128 * 1024 * 1024
  ) {
    throw new Error('git worker supplied an invalid maxBuffer')
  }
  return withTimeout(
    host.exec('git', call.args, {
      cwd: root,
      input: call.input,
      maxBuffer,
    }),
    120_000,
  )
}

async function assertProjectPath(
  candidate: HostPath,
  root: HostPath,
  host: ProjectHost,
): Promise<void> {
  if (
    !candidate ||
    candidate.hostId !== root.hostId ||
    typeof candidate.path !== 'string'
  ) {
    throw new Error('git worker path belongs to another host')
  }
  const prefix = root.path === '/' ? '/' : `${root.path}/`
  if (candidate.path !== root.path && !candidate.path.startsWith(prefix)) {
    throw new Error('git worker path escapes the active project')
  }
  const canonicalRootPromise = canonicalProjectRoot(host, root)
  const [canonicalRoot, canonicalPath] = await Promise.all([
    canonicalRootPromise,
    candidate.path === root.path ? canonicalRootPromise : host.realpath(candidate),
  ])
  const canonicalPrefix = canonicalRoot.path === '/' ? '/' : `${canonicalRoot.path}/`
  if (
    canonicalPath.path !== canonicalRoot.path &&
    !canonicalPath.path.startsWith(canonicalPrefix)
  ) {
    throw new Error('git worker path escapes the active project through a symlink')
  }
}

function canonicalProjectRoot(host: ProjectHost, root: HostPath): Promise<HostPath> {
  let roots = canonicalRoots.get(host)
  if (!roots) {
    roots = new Map()
    canonicalRoots.set(host, roots)
  }
  const key = `${root.hostId}:${root.path}`
  let pending = roots.get(key)
  if (!pending) {
    pending = host.realpath(root)
    roots.set(key, pending)
    void pending.catch(() => roots?.delete(key))
  }
  return pending
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('git host operation timed out')),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
