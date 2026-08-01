import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import {
  SmokeAttemptEvidenceCollector,
  createSmokeFailureArtifact,
  writeSmokeFailureArtifact,
} from '../scripts/smoke-failure-artifact.mts'

describe('bounded smoke failure evidence', () => {
  it('recognizes the success sentinel across stdout chunk boundaries', () => {
    const collector = new SmokeAttemptEvidenceCollector()
    collector.observe('stdout', 'HVIR_SM')
    collector.observe('stdout', 'OKE_OK\n')

    expect(collector.evidence().logs.successSentinel).toBe(true)
  })

  it('retains only the closed semantic, resource, process, and log-event schema', () => {
    const collector = new SmokeAttemptEvidenceCollector()
    collector.observe('stdout', 'terminal output TOKEN=do-not-retain\n')
    collector.observe(
      'stderr',
      '[smoke:failure-evidence] ' +
        JSON.stringify({
          schema: 1,
          phase: 'renderer-ready',
          owners: {
            windowCount: 1,
            ptyCount: 0,
            watcherActive: true,
            rendererOwnerActive: true,
            rendererGeneration: 3,
          },
        }) +
        '\n',
    )
    collector.observe(
      'stderr',
      '[smoke:failure-evidence] ' +
        JSON.stringify({
          schema: 1,
          phase: 'scenario-active',
          owners: {
            windowCount: 1,
            ptyCount: 2,
            watcherActive: true,
            rendererOwnerActive: true,
            rendererGeneration: 3,
          },
        }) +
        '\nHVIR_SMOKE_FAIL Error: /secret/file\n',
    )
    collector.observe('stderr', 'HVIR_SMOKE_CLEANUP_FAIL Error: cookie=value\n')
    collector.finish()

    const artifact = createSmokeFailureArtifact({
      scenario: 'web-pane',
      iteration: 2,
      repetitionCount: 20,
      durationMs: 1234.7,
      exitCode: 1,
      signal: null,
      spawnError: false,
      collector,
    })

    expect(artifact).toEqual({
      schema: 1,
      scenario: 'web-pane',
      iteration: 2,
      repetitionCount: 20,
      durationMs: 1235,
      expectedOutcome: 'exit-zero-with-success-sentinel',
      process: { exitCode: 1, signal: null, spawnError: false },
      semanticSnapshot: {
        schema: 1,
        phase: 'scenario-active',
        owners: {
          windowCount: 1,
          ptyCount: 2,
          watcherActive: true,
          rendererOwnerActive: true,
          rendererGeneration: 3,
        },
      },
      applicationLogs: {
        successSentinel: false,
        failureSentinel: true,
        startupFailure: false,
        cleanupFailure: true,
        evidenceRejected: false,
      },
    })
    expect(JSON.stringify(artifact)).not.toMatch(
      /TOKEN|do-not-retain|secret|cookie|terminal output/,
    )
  })

  it('rejects unreviewed semantic fields before they can enter an artifact', () => {
    const collector = new SmokeAttemptEvidenceCollector()
    collector.observe(
      'stderr',
      '[smoke:failure-evidence] ' +
        JSON.stringify({
          schema: 1,
          phase: 'scenario-active',
          owners: {
            windowCount: 1,
            ptyCount: 0,
            watcherActive: true,
            rendererOwnerActive: false,
            rendererGeneration: null,
          },
          rawLog: 'not allowed',
        }) +
        '\n',
    )

    const artifact = createSmokeFailureArtifact({
      scenario: 'web-pane',
      iteration: 1,
      repetitionCount: 1,
      durationMs: 200,
      exitCode: 3,
      signal: null,
      spawnError: false,
      collector,
    })

    expect(artifact).toMatchObject({
      process: { exitCode: 3, signal: null, spawnError: false },
      semanticSnapshot: null,
      applicationLogs: {
        successSentinel: false,
        failureSentinel: false,
        startupFailure: false,
        cleanupFailure: false,
        evidenceRejected: true,
      },
    })
  })

  it('writes a bounded per-attempt artifact only to the requested directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-smoke-artifacts-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const collector = new SmokeAttemptEvidenceCollector()
    collector.observe('stderr', 'HVIR_STARTUP_FAIL Error\n')
    collector.finish()
    const artifact = createSmokeFailureArtifact({
      scenario: 'pty-native',
      iteration: 1,
      repetitionCount: 5,
      durationMs: 20,
      exitCode: null,
      signal: 'SIGTERM',
      spawnError: false,
      collector,
    })

    const path = await writeSmokeFailureArtifact(directory, artifact)

    expect(path).toBe(join(directory, 'pty-native-iteration-1-of-5.json'))
    expect(JSON.parse(await readFile(path!, 'utf8'))).toEqual(artifact)
  })

  it('rejects fields outside the reviewed artifact schema', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-smoke-artifacts-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const collector = new SmokeAttemptEvidenceCollector()
    const artifact = {
      ...createSmokeFailureArtifact({
        scenario: 'pty-native',
        iteration: 1,
        repetitionCount: 1,
        durationMs: 20,
        exitCode: 1,
        signal: null,
        spawnError: false,
        collector,
      }),
      rawOutput: 'not allowed',
    }

    await expect(writeSmokeFailureArtifact(directory, artifact)).rejects.toThrow(
      'contained unreviewed fields',
    )
  })
})
