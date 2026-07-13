import {
  hostPath,
  type ExecResult,
  type HostPath,
  type WorkerHostCall,
} from '../../shared'
import type { ProjectHost } from '../project-host'

const canonicalRoots = new WeakMap<ProjectHost, Map<string, Promise<HostPath>>>()
const MAX_ARGUMENTS = 256
const MAX_ARGUMENT_LENGTH = 16_384
const SAFE_GIT_CONFIG = ['-c', 'core.fsmonitor=false'] as const

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
    call.args.length > MAX_ARGUMENTS ||
    call.args.some(
      (arg) =>
        typeof arg !== 'string' || arg.length > MAX_ARGUMENT_LENGTH || arg.includes('\0'),
    ) ||
    call.args[0] !== '-C' ||
    typeof call.args[1] !== 'string'
  ) {
    throw new Error('git worker supplied an invalid command')
  }
  validateGitInvocation(call.args)
  if (call.cwd || !isAllowedGitInput(call.args, call.input)) {
    throw new Error('git worker supplied unsupported execution options')
  }
  const commandRoot = hostPath(root.hostId, call.args[1])
  await assertProjectPath(commandRoot, root, host)
  const maxBuffer = call.maxBuffer ?? 10 * 1024 * 1024
  if (
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer < 1 ||
    maxBuffer > 128 * 1024 * 1024
  ) {
    throw new Error('git worker supplied an invalid maxBuffer')
  }
  const controller = new AbortController()
  return withTimeout(
    host.exec('git', [...SAFE_GIT_CONFIG, ...call.args], {
      cwd: root,
      ...(call.input !== undefined ? { input: call.input } : {}),
      maxBuffer,
      signal: controller.signal,
    }),
    120_000,
    controller,
  )
}

/** Validate the exact read-only command grammar emitted by GitEngine. */
function validateGitInvocation(args: readonly string[]): void {
  const [dashC, commandRoot, subcommand, ...rest] = args
  if (dashC !== '-C' || !commandRoot || !subcommand) invalidGitInvocation()
  if (
    rest.some(
      (arg) =>
        arg === '-C' ||
        arg === '-c' ||
        arg.startsWith('-c') ||
        arg === '--git-dir' ||
        arg.startsWith('--git-dir=') ||
        arg === '--work-tree' ||
        arg.startsWith('--work-tree=') ||
        arg === '--exec-path' ||
        arg.startsWith('--exec-path=') ||
        arg === '--config-env' ||
        arg.startsWith('--config-env='),
    )
  ) {
    invalidGitInvocation()
  }

  switch (subcommand) {
    case 'rev-parse':
      if (
        sameArgs(rest, ['--show-toplevel']) ||
        sameArgs(rest, ['--show-prefix']) ||
        sameArgs(rest, ['--verify', 'HEAD'])
      )
        return
      break
    case 'for-each-ref':
      if (
        sameArgs(rest, [
          '--format=%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)',
        ])
      )
        return
      break
    case 'symbolic-ref':
      if (sameArgs(rest, ['--quiet', '--short', 'refs/remotes/origin/HEAD'])) return
      break
    case 'show-ref':
      if (
        rest.length === 3 &&
        rest[0] === '--verify' &&
        rest[1] === '--quiet' &&
        isAllowedDefaultBranch(rest[2] ?? '')
      )
        return
      break
    case 'merge-base':
      if (rest.length === 2 && rest[0] === 'HEAD' && isSafeRevisionOrRef(rest[1] ?? ''))
        return
      break
    case 'status':
      if (sameArgs(rest, ['--porcelain=v2', '-z', '--untracked-files=all', '--', '.']))
        return
      break
    case 'diff':
      if (isAllowedNumstatDiff(rest)) return
      break
    case 'show':
      if (isAllowedBlobShow(rest) || isAllowedCommitDetail(rest)) return
      break
    case 'log':
      if (isAllowedLog(rest)) return
      break
    case 'blame':
      if (
        rest.length === 3 &&
        rest[0] === '--line-porcelain' &&
        rest[1] === '--' &&
        isRepositoryPath(rest[2] ?? '')
      )
        return
      break
    case 'ls-files':
      if (
        rest.length === 4 &&
        rest[0] === '--deleted' &&
        rest[1] === '--error-unmatch' &&
        rest[2] === '--' &&
        isRepositoryPath(rest[3] ?? '')
      )
        return
      break
  }
  invalidGitInvocation()
}

function isAllowedNumstatDiff(args: readonly string[]): boolean {
  if (
    args.length === 8 &&
    args[0] === '--no-ext-diff' &&
    args[1] === '--no-textconv' &&
    args[2] === '--no-index' &&
    args[3] === '--numstat' &&
    args[4] === '-z' &&
    args[5] === '--' &&
    args[6] === '/dev/null' &&
    isRepositoryPath(args[7] ?? '')
  ) {
    return true
  }
  if (
    !sameArgs(args.slice(0, 4), ['--no-ext-diff', '--no-textconv', '--numstat', '-z'])
  ) {
    return false
  }
  const tail = args.slice(4)
  return (
    sameArgs(tail, ['HEAD', '--', '.']) ||
    sameArgs(tail, ['--cached', '--', '.']) ||
    sameArgs(tail, ['--', '.']) ||
    (tail.length === 4 &&
      isObjectId(tail[0] ?? '') &&
      tail[1] === 'HEAD' &&
      tail[2] === '--' &&
      tail[3] === '.')
  )
}

function isAllowedBlobShow(args: readonly string[]): boolean {
  if (args.length !== 1) return false
  const spec = args[0] ?? ''
  const separator = spec.indexOf(':')
  if (separator < 0) return false
  const revision = spec.slice(0, separator)
  const path = spec.slice(separator + 1)
  return (
    (revision === '' ||
      revision === 'HEAD' ||
      revision === 'HEAD^' ||
      /^[0-9a-f]{7,64}(?:\^)?$/i.test(revision)) &&
    isRepositoryPath(path)
  )
}

function isAllowedCommitDetail(args: readonly string[]): boolean {
  return (
    args.length === 10 &&
    args[0] === '--no-renames' &&
    args[1] === '--no-ext-diff' &&
    args[2] === '--no-textconv' &&
    args[3] === '--diff-merges=first-parent' &&
    args[4] === '--format=%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%B%x1e' &&
    args[5] === '--numstat' &&
    args[6] === '-z' &&
    isObjectId(args[7] ?? '') &&
    args[8] === '--' &&
    args[9] === '.'
  )
}

function isAllowedLog(args: readonly string[]): boolean {
  return (
    args.length === 8 &&
    args[0] === '--topo-order' &&
    args[1] === '--parents' &&
    args[2] === '--boundary' &&
    /^-n(?:[1-9]\d{0,2})$/.test(args[3] ?? '') &&
    args[4] === '--format=%m%x1f%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s%x1f%D%x1e' &&
    args[5] === '--stdin' &&
    args[6] === '--' &&
    isRepositoryPath(args[7] ?? '')
  )
}

function isAllowedGitInput(args: readonly string[], input: string | undefined): boolean {
  const isHistory = args[2] === 'log'
  if (!isHistory) return input === undefined
  if (!input || input.length > 128 * 1024 || !input.endsWith('\n')) return false
  const revisions = input.slice(0, -1).split('\n')
  return (
    revisions.length > 0 &&
    revisions.length <= 2_048 &&
    revisions.every(
      (revision) =>
        revision === 'HEAD' || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision),
    ) &&
    new Set(revisions).size === revisions.length
  )
}

function isAllowedDefaultBranch(ref: string): boolean {
  return [
    'refs/remotes/origin/main',
    'refs/heads/main',
    'refs/remotes/origin/master',
    'refs/heads/master',
  ].includes(ref)
}

function isSafeRevisionOrRef(value: string): boolean {
  return (
    isObjectId(value) ||
    (/^(?:refs\/(?:heads|remotes)\/)?[A-Za-z0-9][A-Za-z0-9._/+@-]*$/.test(value) &&
      !value.includes('..') &&
      !value.includes('@{'))
  )
}

function isObjectId(value: string): boolean {
  return /^[0-9a-f]{7,64}$/i.test(value)
}

function isRepositoryPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('/') &&
    !value.includes('\0') &&
    !value.split('/').includes('..')
  )
}

function sameArgs(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((arg, index) => arg === expected[index])
  )
}

function invalidGitInvocation(): never {
  throw new Error('git worker supplied a forbidden git invocation')
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('git host operation timed out'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
