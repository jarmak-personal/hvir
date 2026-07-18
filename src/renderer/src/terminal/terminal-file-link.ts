import {
  hostPath,
  joinHostPath,
  parseLoopbackHttpTarget,
  type HostPath,
} from '../../../shared'

export interface TerminalFileLink {
  readonly target: string
  readonly start: number
  readonly end: number
}

export interface ParsedTerminalFileTarget {
  readonly path: string
  readonly line?: number
  readonly column?: number
}

export interface ResolvedTerminalFileTarget {
  readonly path: HostPath
  readonly line?: number
  readonly column?: number
}

const TOKEN = /[^\s<>"'`|]+/g
const TRAILING_PUNCTUATION = /[.),;!?}\]]+$/
const LEADING_PUNCTUATION = /^[([{]+/
const LINE_POSITION = /:(\d+)(?::(\d+))?$/
const FILE_NAME = /(?:^|\/)[^/]+\.[a-z0-9][a-z0-9._-]*$/i

/** Detect conservative, single-line path candidates without executing or resolving them. */
export function detectTerminalFileLinks(text: string): readonly TerminalFileLink[] {
  const links: TerminalFileLink[] = []
  TOKEN.lastIndex = 0
  let match = TOKEN.exec(text)
  while (match) {
    const original = match[0]
    const leading = original.match(LEADING_PUNCTUATION)?.[0].length ?? 0
    const withoutLeading = original.slice(leading)
    const trailing = withoutLeading.match(TRAILING_PUNCTUATION)?.[0].length ?? 0
    const target = withoutLeading.slice(0, withoutLeading.length - trailing)
    if (isTerminalWebTarget(target)) {
      match = TOKEN.exec(text)
      continue
    }
    const parsed = parseTerminalFileTarget(target)
    if (parsed && isPlainPathCandidate(parsed.path)) {
      const start = match.index + leading
      links.push({ target, start, end: start + target.length - 1 })
    }
    match = TOKEN.exec(text)
  }
  return links
}

/** Parse file URI/path and optional `:line[:column]` decoration. */
export function parseTerminalFileTarget(
  rawTarget: string,
): ParsedTerminalFileTarget | undefined {
  let target = rawTarget.trim()
  if (!target) return undefined

  if (target.startsWith('file://')) {
    try {
      const uri = new URL(target)
      if (uri.protocol !== 'file:') return undefined
      target = decodeURIComponent(uri.pathname)
    } catch {
      return undefined
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !LINE_POSITION.test(target)) {
    return undefined
  }

  const position = target.match(LINE_POSITION)
  if (position?.index !== undefined) target = target.slice(0, position.index)
  if (!target || target.includes('\0') || target.startsWith('~')) return undefined

  const line = position?.[1] ? Number.parseInt(position[1], 10) : undefined
  const column = position?.[2] ? Number.parseInt(position[2], 10) : undefined
  return {
    path: target,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  }
}

/** Resolve a terminal target inside the terminal's authorized workspace only. */
export function resolveTerminalFileTarget(
  rawTarget: string,
  workspaceRoot: HostPath,
): ResolvedTerminalFileTarget | undefined {
  const parsed = parseTerminalFileTarget(rawTarget)
  if (!parsed) return undefined
  const candidate = parsed.path.startsWith('/')
    ? hostPath(workspaceRoot.hostId, parsed.path)
    : joinHostPath(workspaceRoot, parsed.path)
  const root = workspaceRoot.path
  const resolved = {
    path: candidate,
    ...(parsed.line === undefined ? {} : { line: parsed.line }),
    ...(parsed.column === undefined ? {} : { column: parsed.column }),
  }
  if (root === '/') return resolved
  if (candidate.path !== root && !candidate.path.startsWith(`${root}/`)) return undefined
  return resolved
}

export function isFileUri(target: string): boolean {
  return target.startsWith('file://')
}

// Match both forms so this provider overrides ghostty-web's global window.open
// handler for schemed loopback URLs as well as detecting scheme-less output.
const WEB_HOST_TOKEN =
  /(?:^|[\s<>"'`|([{])((?:http:\/\/(?:[^\s<>"'`|/@]+(?::[^\s<>"'`|/@]*)?@)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\])(?::\d{1,6})?|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):\d{1,6})(?:[/?#][^\s<>"'`|]*)?)/gi
const WEB_TRAILING_PUNCTUATION = /[.,;!?)\]}]+$/

export interface TerminalWebLink {
  readonly target: string
  readonly start: number
  readonly end: number
}

/** Detect loopback server links in one terminal line. */
export function detectTerminalWebLinks(text: string): readonly TerminalWebLink[] {
  const links: TerminalWebLink[] = []
  WEB_HOST_TOKEN.lastIndex = 0
  let match = WEB_HOST_TOKEN.exec(text)
  while (match) {
    const captured = match[1] ?? ''
    const target = captured.replace(WEB_TRAILING_PUNCTUATION, '')
    if (target) {
      const start = match.index + match[0].length - captured.length
      links.push({ target, start, end: start + target.length - 1 })
    }
    match = WEB_HOST_TOKEN.exec(text)
  }
  return links
}

/** Turn a clicked terminal target into an http URL when it is a loopback web link. */
export function normalizeTerminalWebTarget(rawTarget: string): string | undefined {
  const target = rawTarget.trim().replace(WEB_TRAILING_PUNCTUATION, '')
  const url = /^http:\/\//i.test(target) ? target : `http://${target}`
  return parseLoopbackHttpTarget(url)?.url
}

/** Include invalid-userinfo lookalikes so our provider overrides global window.open. */
export function isTerminalWebTarget(rawTarget: string): boolean {
  if (normalizeTerminalWebTarget(rawTarget)) return true
  try {
    const candidate = new URL(rawTarget)
    return (
      candidate.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(
        candidate.hostname.toLowerCase(),
      )
    )
  } catch {
    return false
  }
}

function isPlainPathCandidate(path: string): boolean {
  return (
    path.startsWith('/') ||
    path.startsWith('./') ||
    path.startsWith('../') ||
    path.includes('/') ||
    FILE_NAME.test(path)
  )
}
