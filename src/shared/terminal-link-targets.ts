import { fileUriPath } from './file-uri'
import { hostPath, joinHostPath, type HostPath } from './host-path'
import { parseLoopbackHttpTarget } from './web-pane'

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
const TRAILING_PUNCTUATION = /[.),;:!?}\]]+$/
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
    if (isFileUri(target) || (parsed && isPlainPathCandidate(parsed.path))) {
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
    const path = fileUriPath(target)
    if (!path) return undefined
    target = path
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

/** Keep the terminal host; main separately validates document reads. */
export function resolveTerminalFileTarget(
  rawTarget: string,
  workspaceRoot: HostPath,
): ResolvedTerminalFileTarget | undefined {
  const parsed = parseTerminalFileTarget(rawTarget)
  if (!parsed) return undefined
  const candidate = parsed.path.startsWith('/')
    ? hostPath(workspaceRoot.hostId, parsed.path)
    : joinHostPath(workspaceRoot, parsed.path)
  const resolved = {
    path: candidate,
    ...(parsed.line === undefined ? {} : { line: parsed.line }),
    ...(parsed.column === undefined ? {} : { column: parsed.column }),
  }
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
    // Schemed lookalikes are still claimed so Ghostty's built-in provider
    // cannot send malformed or userinfo-bearing loopback URLs to window.open.
    // Scheme-less output has no competing provider, so surface it only when
    // activation can produce an authorized URL.
    if (
      target &&
      (/^http:\/\//i.test(target) || normalizeTerminalWebTarget(target) !== undefined)
    ) {
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

/**
 * Plain URL provider and default target policy adapted from ghostty-web
 * hvir-v0.4.0-20 (g18fc0d2bddb0), dist/ghostty-web.js:2199-2210,2342-2401.
 * https://github.com/jarmak-personal/ghostty-web/releases/download/hvir-v0.4.0-20/ghostty-web-0.4.0-hvir-g18fc0d2bddb0.tgz
 * Source SHA256: d22e9af08b6c40600ddb8903aebbcba5101476e1c820123572e84bf2e1792d8b
 *
 * MIT License
 *
 * Copyright (c) 2025 Coder
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:'])
const BLOCKED_EXTERNAL_PROTOCOLS = new Set([
  'blob:',
  'data:',
  'filesystem:',
  'javascript:',
  'vbscript:',
])
// eslint-disable-next-line no-control-regex -- Pinned licensed policy intentionally excludes control characters.
const EXTERNAL_CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/
const EXTERNAL_URL =
  // eslint-disable-next-line no-useless-escape -- Preserve the exact licensed pinned URL pattern.
  /(?:https?:\/\/|mailto:|ftp:\/\/|ssh:\/\/|git:\/\/|tel:|magnet:|gemini:\/\/|gopher:\/\/|news:)[\w\-.~:\/?#@!$&*+,;=%]+/gi
const EXTERNAL_TRAILING_PUNCTUATION = /[.,;!?)\]]+$/

/** The mature default OSC8 policy; explicit links do not use the plain-text length guard. */
export function isTerminalExternalTarget(target: string): boolean {
  if (
    typeof target !== 'string' ||
    target.length === 0 ||
    EXTERNAL_CONTROL_OR_SPACE.test(target)
  )
    return false
  let parsed: URL
  try {
    parsed = new URL(target)
  } catch {
    return false
  }
  return BLOCKED_EXTERNAL_PROTOCOLS.has(parsed.protocol)
    ? false
    : EXTERNAL_URL_PROTOCOLS.has(parsed.protocol)
}

/** Pinned plain URL detection, with inclusive UTF16 string offsets. */
export function detectTerminalExternalLinks(text: string): readonly TerminalWebLink[] {
  const links: TerminalWebLink[] = []
  EXTERNAL_URL.lastIndex = 0
  let match = EXTERNAL_URL.exec(text)
  while (match) {
    let target = match[0]
    const start = match.index
    let end = start + target.length - 1
    const stripped = target.replace(EXTERNAL_TRAILING_PUNCTUATION, '')
    if (stripped.length < target.length) {
      target = stripped
      end = start + target.length - 1
    }
    if (target.length > 8 && isTerminalExternalTarget(target))
      links.push({ target, start, end })
    match = EXTERNAL_URL.exec(text)
  }
  return links
}
