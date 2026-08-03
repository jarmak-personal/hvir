import type { Mock } from 'vitest'
import { describe, expect, it, vi } from 'vitest'

import { SshHostTrustStore, type ProjectHost } from '../src/main/project-host'
import { localPath } from '../src/shared'

const ALPHA_FINGERPRINT = 'SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BETA_FINGERPRINT = 'SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

describe('SshHostTrustStore', () => {
  it.each([
    ['missing', () => Promise.reject(new Error('missing'))],
    ['unreadable', () => Promise.reject(new Error('permission denied'))],
    ['malformed', () => Promise.resolve('{not json')],
  ])('fails closed for a %s trust record', async (_name, readTextFile) => {
    const host = metadataHost(readTextFile)
    const store = await SshHostTrustStore.load(host, localPath('/known-hosts.json'))

    expect(store.forAlias('alpha').trustedHostKey()).toBeUndefined()
  })

  it('retains valid independent records while rejecting invalid entries', async () => {
    const host = metadataHost(() =>
      Promise.resolve(
        JSON.stringify({
          alpha: ALPHA_FINGERPRINT,
          beta: 'not-a-fingerprint',
          'invalid alias': BETA_FINGERPRINT,
          gamma: BETA_FINGERPRINT,
        }),
      ),
    )
    const store = await SshHostTrustStore.load(host, localPath('/known-hosts.json'))

    expect(store.forAlias('alpha').trustedHostKey()).toBe(ALPHA_FINGERPRINT)
    expect(store.forAlias('beta').trustedHostKey()).toBeUndefined()
    expect(store.forAlias('gamma').trustedHostKey()).toBe(BETA_FINGERPRINT)
  })

  it('serializes overlapping updates so the final record retains both aliases', async () => {
    let releaseFirst!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let persisted = '{}'
    const writeFile = vi.fn(async (_path, data: Uint8Array | string) => {
      if (writeFile.mock.calls.length === 1) await firstWrite
      persisted = String(data)
    })
    const host = metadataHost(() => Promise.resolve('{}'), writeFile)
    const store = await SshHostTrustStore.load(host, localPath('/known-hosts.json'))

    const alpha = store.forAlias('alpha').rememberHostKey(ALPHA_FINGERPRINT)
    const beta = store.forAlias('beta').rememberHostKey(BETA_FINGERPRINT)
    await vi.waitFor(() => expect(writeFile).toHaveBeenCalledOnce())
    releaseFirst()
    await alpha
    await beta

    expect(writeFile).toHaveBeenCalledTimes(2)
    expect(JSON.parse(persisted)).toEqual({
      alpha: ALPHA_FINGERPRINT,
      beta: BETA_FINGERPRINT,
    })
  })

  it('does not publish a failed write into the accepted in-memory record', async () => {
    const writeFile = vi.fn().mockRejectedValueOnce(new Error('disk full'))
    const host = metadataHost(() => Promise.resolve('{}'), writeFile)
    const store = await SshHostTrustStore.load(host, localPath('/known-hosts.json'))
    const alpha = store.forAlias('alpha')

    await expect(alpha.rememberHostKey(ALPHA_FINGERPRINT)).rejects.toThrow('disk full')
    expect(alpha.trustedHostKey()).toBeUndefined()
  })
})

function metadataHost(
  readTextFile: () => Promise<string>,
  writeFile: Mock = vi.fn(() => Promise.resolve()),
): Pick<ProjectHost, 'readTextFile' | 'writeFile'> {
  return {
    readTextFile,
    writeFile,
  }
}
