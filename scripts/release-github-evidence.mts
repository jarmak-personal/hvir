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

  async requestJson<T>(url: URL, token: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!response.ok) {
      throw new Error(`${this.evidenceName} request failed (${response.status})`)
    }
    try {
      return (await response.json()) as T
    } catch {
      throw new Error(`${this.evidenceName} response was invalid`)
    }
  }

  incomplete(): never {
    throw new Error(`${this.evidenceName} response was incomplete`)
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
