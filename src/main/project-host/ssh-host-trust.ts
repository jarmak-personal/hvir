import type { HostPath } from '../../shared'
import type { ProjectHost } from './project-host'

type TrustMetadataHost = Pick<ProjectHost, 'readTextFile' | 'writeFile'>

export interface SshHostTrust {
  readonly trustedHostKey: () => string | undefined
  readonly rememberHostKey: (fingerprint: string) => Promise<void>
}

const VALID_ALIAS = /^[^\s]{1,255}$/
const VALID_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{20,}$/

/** Owns the alias-keyed local host-trust record, not host-key acceptance policy. */
export class SshHostTrustStore {
  private pendingWrite: Promise<void> = Promise.resolve()

  private constructor(
    private readonly host: TrustMetadataHost,
    private readonly file: HostPath,
    private fingerprints: Record<string, string>,
  ) {}

  static async load(host: TrustMetadataHost, file: HostPath): Promise<SshHostTrustStore> {
    try {
      const parsed: unknown = JSON.parse(await host.readTextFile(file))
      const fingerprints: Record<string, string> = {}
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [alias, fingerprint] of Object.entries(parsed)) {
          if (
            VALID_ALIAS.test(alias) &&
            typeof fingerprint === 'string' &&
            VALID_FINGERPRINT.test(fingerprint)
          ) {
            fingerprints[alias] = fingerprint
          }
        }
      }
      return new SshHostTrustStore(host, file, fingerprints)
    } catch {
      return new SshHostTrustStore(host, file, {})
    }
  }

  forAlias(alias: string): SshHostTrust {
    if (!VALID_ALIAS.test(alias)) throw new Error('Invalid SSH host alias')
    return {
      trustedHostKey: () => this.fingerprints[alias],
      rememberHostKey: (fingerprint) => this.remember(alias, fingerprint),
    }
  }

  private remember(alias: string, fingerprint: string): Promise<void> {
    if (!VALID_FINGERPRINT.test(fingerprint)) {
      return Promise.reject(new Error('Invalid SSH host-key fingerprint'))
    }
    const write = async (): Promise<void> => {
      const fingerprints = { ...this.fingerprints, [alias]: fingerprint }
      await this.host.writeFile(this.file, JSON.stringify(fingerprints, null, 2))
      this.fingerprints = fingerprints
    }
    const next = this.pendingWrite.then(write, write)
    this.pendingWrite = next.catch(() => undefined)
    return next
  }
}
