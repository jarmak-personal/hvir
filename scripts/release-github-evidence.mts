export const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/

/** Shared fail-closed decoding for the two release GitHub evidence consumers. */
export class ReleaseGitHubEvidenceReader {
  private readonly evidenceName: string

  constructor(evidenceName: string) {
    this.evidenceName = evidenceName
  }

  requiredString(value: unknown): string {
    if (typeof value !== 'string') this.incomplete()
    return value
  }

  nullableString(value: unknown): string | null {
    if (value === null) return null
    return this.requiredString(value)
  }

  requiredNumber(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) this.incomplete()
    return value
  }

  requestJson<T>(url: URL, token: string): Promise<T>
  requestJson<T>(url: URL, token: string, allowAbsent: true): Promise<T | null>
  async requestJson<T>(url: URL, token: string, allowAbsent = false): Promise<T | null> {
    let response: Response
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
    } catch {
      throw new Error(
        `${this.evidenceName} API unavailable at ${url.pathname}; restore connectivity and retry the read-only check`,
      )
    }
    if (allowAbsent && response.status === 404) return null
    if (!response.ok) {
      throw new Error(
        `${this.evidenceName} request failed (${response.status}) at ${url.pathname}; API evidence unavailable, check access/service availability and retry`,
      )
    }
    try {
      return (await response.json()) as T
    } catch {
      throw new Error(
        `${this.evidenceName} response was invalid; inspect the API metadata and retry the read-only check`,
      )
    }
  }

  incomplete(): never {
    throw new Error(
      `${this.evidenceName} response was incomplete; restore required API metadata and reverify`,
    )
  }
}

export function requireReleaseEnvironment(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const value = environment[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function requireFullCommitSha(name: string, value: string): string {
  if (!FULL_COMMIT_SHA_PATTERN.test(value)) {
    throw new Error(`${name} must be a full lowercase commit SHA`)
  }
  return value
}
