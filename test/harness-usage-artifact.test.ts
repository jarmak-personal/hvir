import { describe, expect, it, vi } from 'vitest'

import {
  HARNESS_USAGE_ARTIFACT_BYTE_LIMIT,
  readHarnessUsageArtifact,
  scanHarnessUsageArtifactLines,
} from '../src/main/harness/harness-usage-artifact'
import type { ProjectHost } from '../src/main/project-host'
import { asHostId, hostPath, localPath, type HostPath } from '../src/shared'

describe('bounded harness usage artifact reads', () => {
  it('fails closed when the exact artifact exceeds the read bound', async () => {
    const signal = new AbortController().signal
    const readTextFilePrefix = vi.fn<ProjectHost['readTextFilePrefix']>(() =>
      Promise.resolve({
        content: 'bounded prefix',
        byteLength: 14,
        lineCount: 1,
        complete: false,
        validUtf8: true,
      }),
    )
    const host = {
      hostId: localPath('/').hostId,
      readTextFilePrefix,
    } as unknown as ProjectHost

    await expect(
      readHarnessUsageArtifact(
        host,
        localPath('/private/provider-artifact.jsonl'),
        signal,
      ),
    ).resolves.toEqual({ status: 'unavailable', reason: 'artifact-too-large' })
    expect(readTextFilePrefix).toHaveBeenCalledWith(
      localPath('/private/provider-artifact.jsonl'),
      HARNESS_USAGE_ARTIFACT_BYTE_LIMIT,
      { signal },
    )
  })

  it('admits a streamed artifact at the cumulative byte bound', async () => {
    const path = localPath('/private/provider-artifact.jsonl')
    const host = streamingHost(path, async function* () {
      await Promise.resolve()
      yield Buffer.alloc(HARNESS_USAGE_ARTIFACT_BYTE_LIMIT)
    })
    const oversized = vi.fn()

    await expect(
      scanHarnessUsageArtifactLines(
        host,
        path,
        new AbortController().signal,
        { visit: vi.fn(), oversized },
      ),
    ).resolves.toEqual({ status: 'available' })
    expect(oversized).toHaveBeenCalledOnce()
  })

  it('stops an oversized growing stream and closes its iterator', async () => {
    const remoteHostId = asHostId('ssh:usage-test')
    const path = hostPath(remoteHostId, '/private/provider-artifact.jsonl')
    let chunksRead = 0
    let iteratorClosed = false
    const host = streamingHost(path, async function* () {
      try {
        await Promise.resolve()
        for (;;) {
          chunksRead += 1
          yield Buffer.alloc(1024 * 1024)
        }
      } finally {
        iteratorClosed = true
      }
    })

    await expect(
      scanHarnessUsageArtifactLines(
        host,
        path,
        new AbortController().signal,
        { visit: vi.fn(), oversized: vi.fn() },
      ),
    ).resolves.toEqual({ status: 'unavailable', reason: 'artifact-too-large' })
    expect(chunksRead).toBe(9)
    expect(iteratorClosed).toBe(true)
  })
})

function streamingHost(
  path: HostPath,
  chunks: () => AsyncIterable<Uint8Array>,
): ProjectHost {
  return {
    hostId: path.hostId,
    fileTransfer: {
      hostId: path.hostId,
      readFileChunks: (candidate: HostPath) => {
        expect(candidate).toEqual(path)
        return chunks()
      },
    },
  } as unknown as ProjectHost
}
