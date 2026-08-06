import { describe, expect, it } from 'vitest'

import type { ProjectHost } from '../src/main/project-host'
import {
  LocalSshIdentitySource,
  SshIdentityGeneration,
} from '../src/main/project-host/ssh-identity-source'
import { localPath, type HostPath } from '../src/shared'

describe('LocalSshIdentitySource', () => {
  it('reads current local contents for each lease and overwrites released buffers', async () => {
    const first = Buffer.from('first-identity-sentinel')
    const replacement = Buffer.from('replacement-identity-sentinel')
    const pending = [first, replacement]
    const reads: HostPath[] = []
    const local: Pick<ProjectHost, 'readFile'> = {
      readFile: (path) => {
        reads.push(path)
        return Promise.resolve(pending.shift()!)
      },
    }
    const source = new LocalSshIdentitySource(local, ['/home/test/.ssh/work'])

    const firstLease = await source.acquire(
      '/home/test/.ssh/work',
      new AbortController().signal,
    )
    expect(firstLease?.privateKey).toBe(first)
    expect(source.activeLeaseCount).toBe(1)

    firstLease?.release()
    firstLease?.release()
    expect(first.equals(Buffer.alloc(first.length))).toBe(true)
    expect(source.activeLeaseCount).toBe(0)

    const replacementLease = await source.acquire(
      '/home/test/.ssh/work',
      new AbortController().signal,
    )
    expect(replacementLease?.privateKey).toBe(replacement)
    expect(reads).toEqual([
      localPath('/home/test/.ssh/work'),
      localPath('/home/test/.ssh/work'),
    ])

    replacementLease?.release()
    expect(replacement.equals(Buffer.alloc(replacement.length))).toBe(true)
    expect(source.activeLeaseCount).toBe(0)
  })

  it('overwrites a late read without creating a lease after generation revocation', async () => {
    let finishRead: ((value: Buffer) => void) | undefined
    const local: Pick<ProjectHost, 'readFile'> = {
      readFile: () =>
        new Promise<Buffer>((resolve) => {
          finishRead = resolve
        }),
    }
    const source = new LocalSshIdentitySource(local, ['/home/test/.ssh/work'])
    const generation = new SshIdentityGeneration(source)
    const acquiring = generation.next()

    generation.release()
    const sentinel = Buffer.from('late-identity-sentinel')
    finishRead?.(sentinel)

    await expect(acquiring).resolves.toBeUndefined()
    expect(sentinel.equals(Buffer.alloc(sentinel.length))).toBe(true)
    expect(source.activeLeaseCount).toBe(0)
  })

  it('preserves candidate order while skipping an unavailable identity', async () => {
    const available = Buffer.from('available-identity-sentinel')
    const reads: string[] = []
    const local: Pick<ProjectHost, 'readFile'> = {
      readFile: (path) => {
        reads.push(path.path)
        if (path.path.endsWith('/missing')) return Promise.reject(new Error('missing'))
        return Promise.resolve(available)
      },
    }
    const source = new LocalSshIdentitySource(local, [
      '/home/test/.ssh/missing',
      '/home/test/.ssh/available',
    ])
    const generation = new SshIdentityGeneration(source)

    const lease = await generation.next()

    expect(lease?.path).toBe('/home/test/.ssh/available')
    expect(reads).toEqual(['/home/test/.ssh/missing', '/home/test/.ssh/available'])
    generation.release()
    expect(available.equals(Buffer.alloc(available.length))).toBe(true)
  })
})
