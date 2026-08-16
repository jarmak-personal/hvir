import { describe, expect, it, vi } from 'vitest'

import {
  HARNESS_USAGE_ARTIFACT_BYTE_LIMIT,
  readHarnessUsageArtifact,
} from '../src/main/harness/harness-usage-artifact'
import type { ProjectHost } from '../src/main/project-host'
import { localPath } from '../src/shared'

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
})
