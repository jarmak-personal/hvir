const GRAPHQL_URL = 'https://api.github.com/graphql'
const REST_URL = 'https://api.github.com'
const MAX_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 15_000

export type FetchImplementation = typeof fetch

export interface GitHubClientOptions {
  token: string
  purpose: string
  fetchImplementation?: FetchImplementation
  wait?: (milliseconds: number) => Promise<void>
}

interface GraphqlEnvelope<T> {
  data?: T
  errors?: Array<{ message?: string; type?: string }>
}

export class GitHubClient {
  readonly #token: string
  readonly #fetch: FetchImplementation
  readonly #wait: (milliseconds: number) => Promise<void>

  constructor(options: GitHubClientOptions) {
    this.#token = requireToken(options.token, options.purpose)
    this.#fetch = options.fetchImplementation ?? fetch
    this.#wait =
      options.wait ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async graphql<T>(query: string, variables: object): Promise<T> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await this.request(GRAPHQL_URL, {
        method: 'POST',
        body: JSON.stringify({ query, variables }),
      })
      if (!response.ok) {
        throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}.`)
      }
      const envelope = (await response.json()) as GraphqlEnvelope<T>
      if (envelope.errors !== undefined && envelope.errors.length > 0) {
        if (hasRateLimitError(envelope.errors) && attempt < MAX_ATTEMPTS) {
          await this.#wait(250 * 2 ** (attempt - 1))
          continue
        }
        const messages = envelope.errors.map((error) =>
          redactToken(error.message ?? error.type ?? 'unknown error', this.#token),
        )
        throw new Error(`GitHub GraphQL request failed: ${messages.join('; ')}`)
      }
      if (envelope.data === undefined) {
        throw new Error('GitHub GraphQL returned no data.')
      }
      return envelope.data
    }
    throw new Error(`GitHub GraphQL rate limit persisted after ${MAX_ATTEMPTS} attempts.`)
  }

  async rest(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.requestRest(path, init)
    if (!response.ok) {
      throw new Error(`GitHub REST request failed with HTTP ${response.status}.`)
    }
    if (response.status === 204) return undefined
    return response.json()
  }

  requestRest(path: string, init: RequestInit): Promise<Response> {
    return this.request(`${REST_URL}${path}`, init)
  }

  async request(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await this.#fetch(url, {
          ...init,
          signal: controller.signal,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${this.#token}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...init.headers,
          },
        })
        if (!shouldRetry(response) || attempt === MAX_ATTEMPTS) {
          return response
        }
        lastError = new Error(`GitHub temporarily returned HTTP ${response.status}.`)
      } catch (error) {
        lastError = error
        if (attempt === MAX_ATTEMPTS) break
      } finally {
        clearTimeout(timeout)
      }
      await this.#wait(250 * 2 ** (attempt - 1))
    }

    const reason =
      lastError instanceof Error && lastError.name === 'AbortError'
        ? 'timed out'
        : 'failed'
    throw new Error(`GitHub request ${reason} after ${MAX_ATTEMPTS} bounded attempts.`)
  }
}

function hasRateLimitError(errors: Array<{ message?: string; type?: string }>): boolean {
  return errors.some(
    (error) =>
      error.type === 'RATE_LIMITED' ||
      error.message?.toLowerCase().includes('rate limit') === true,
  )
}

function shouldRetry(response: Response): boolean {
  return (
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
  )
}

function requireToken(value: string, purpose: string): string {
  if (value.trim() === '') {
    throw new Error(`A ${purpose} token is required.`)
  }
  return value
}

function redactToken(message: string, token: string): string {
  return token === '' ? message : message.split(token).join('[REDACTED]')
}
