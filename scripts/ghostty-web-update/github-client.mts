const API_ROOT = 'https://api.github.com'
const MAX_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 15_000

export type FetchImplementation = typeof fetch

export class BoundedGitHubClient {
  readonly #fetch: FetchImplementation
  readonly #token?: string
  readonly #wait: (milliseconds: number) => Promise<void>

  constructor(
    options: {
      readonly fetchImplementation?: FetchImplementation
      readonly token?: string
      readonly wait?: (milliseconds: number) => Promise<void>
    } = {},
  ) {
    this.#fetch = options.fetchImplementation ?? fetch
    this.#token = options.token
    this.#wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async json(path: string, init: RequestInit = {}, maximumBytes = 4 * 1024 * 1024) {
    const bytes = await this.bytes(path, init, maximumBytes)
    try {
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown
    } catch {
      throw new Error('GitHub returned invalid JSON.')
    }
  }

  async bytes(
    path: string,
    init: RequestInit = {},
    maximumBytes = 4 * 1024 * 1024,
  ): Promise<Uint8Array> {
    const url = githubApiUrl(path)
    let lastFailure: unknown
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const headers = new Headers(init.headers)
        headers.set('Accept', headers.get('Accept') ?? 'application/vnd.github+json')
        headers.set('User-Agent', 'hvir-ghostty-web-updater')
        headers.set('X-GitHub-Api-Version', '2022-11-28')
        if (this.#token) headers.set('Authorization', `Bearer ${this.#token}`)
        const response = await this.#fetch(url, {
          ...init,
          headers,
          redirect: 'follow',
          signal: controller.signal,
        })
        if (shouldRetry(response.status) && attempt < MAX_ATTEMPTS) {
          await response.body?.cancel()
          lastFailure = new Error(`GitHub temporarily returned HTTP ${response.status}.`)
        } else {
          if (!response.ok) {
            throw new Error(`GitHub request failed with HTTP ${response.status}.`)
          }
          requireAllowedResponseUrl(response.url)
          return await readBoundedBody(response, maximumBytes)
        }
      } catch (error) {
        lastFailure = error
        if (attempt === MAX_ATTEMPTS || !isRetryableError(error))
          throw safeGitHubError(error)
      } finally {
        clearTimeout(timeout)
      }
      await this.#wait(250 * 2 ** (attempt - 1))
    }
    throw safeGitHubError(lastFailure)
  }
}

function githubApiUrl(path: string): URL {
  if (!path.startsWith('/')) throw new Error('GitHub API paths must be absolute.')
  const url = new URL(path, API_ROOT)
  if (url.origin !== API_ROOT)
    throw new Error('GitHub API path escaped its fixed origin.')
  return url
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error('GitHub response bound is invalid.')
  }
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && Number(declaredLength) > maximumBytes) {
    throw new Error('GitHub response exceeds its bounded size.')
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maximumBytes) {
      await reader.cancel()
      throw new Error('GitHub response exceeds its bounded size.')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function requireAllowedResponseUrl(value: string): void {
  const url = new URL(value)
  const allowedHost =
    url.hostname === 'api.github.com' ||
    url.hostname === 'github.com' ||
    url.hostname.endsWith('.githubusercontent.com')
  if (url.protocol !== 'https:' || !allowedHost) {
    throw new Error('GitHub redirected to an unexpected download origin.')
  }
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500
}

function isRetryableError(error: unknown): boolean {
  return (
    !(error instanceof Error) ||
    error.name === 'AbortError' ||
    error instanceof TypeError ||
    error.message.startsWith('GitHub temporarily returned')
  )
}

function safeGitHubError(error: unknown): Error {
  if (error instanceof Error && error.name === 'AbortError') {
    return new Error('GitHub request timed out after bounded attempts.')
  }
  if (error instanceof Error && !error.message.includes('Bearer ')) return error
  return new Error('GitHub request failed after bounded attempts.')
}
