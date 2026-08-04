import {
  SshHost,
  type SshHostOptions,
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

export function inMemorySshHostTrust(
  initialFingerprint?: string,
): SshHostTrust {
  let fingerprint = initialFingerprint
  return {
    trustedHostKey: () => fingerprint,
    rememberHostKey: (value) => {
      fingerprint = value
      return Promise.resolve()
    },
  }
}
