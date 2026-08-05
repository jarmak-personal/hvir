import {
  SshHost,
  type SshHostOptions,
  type SshIdentitySource,
  type SshHostTrust,
} from '../src/main/project-host'

type TestSshHostOptions = Omit<SshHostOptions, 'trust'> & {
  readonly trust?: SshHostTrust
}

/** Supplies the explicit in-memory trust owner used by non-trust SSH tests. */
export function createTestSshHost(options: TestSshHostOptions): SshHost {
  const { trust = inMemorySshHostTrust(), ...hostOptions } = options
  return new SshHost({ ...hostOptions, trust })
}

export function inMemorySshHostTrust(initialFingerprint?: string): SshHostTrust {
  let fingerprint = initialFingerprint
  return {
    trustedHostKey: () => fingerprint,
    rememberHostKey: (value) => {
      fingerprint = value
      return Promise.resolve()
    },
  }
}

export function testSshIdentitySource(
  identities: readonly { readonly path: string; readonly privateKey: Buffer }[],
): SshIdentitySource {
  return {
    candidatePaths: identities.map(({ path }) => path),
    acquire(path, signal) {
      const identity = identities.find((candidate) => candidate.path === path)
      if (!identity || signal.aborted) return Promise.resolve(undefined)
      let privateKey: Buffer | undefined = Buffer.from(identity.privateKey)
      return Promise.resolve({
        path,
        get privateKey() {
          if (!privateKey) throw new Error('SSH identity lease is released')
          return privateKey
        },
        release() {
          privateKey?.fill(0)
          privateKey = undefined
        },
      })
    },
  }
}
