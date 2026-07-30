import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import {
  SMOKE_OWNERSHIP_MARKER,
  SMOKE_OWNERSHIP_MARKER_VALUE,
  cleanupOwnedSmokeRoot,
  parseSmokeCheckpointLine,
} from '../scripts/run-smoke-interruption.mts'
import { SmokeInterruptionCheckpoint } from '../src/main/smoke/interruption-checkpoint'

const RUN_TOKEN = '019c0000-0000-7000-8000-000000000118'

describe('smoke interruption checkpoints', () => {
  it('emits a closed checkpoint and cleanup schema without changing authority', async () => {
    const output: string[] = []
    const checkpoint = SmokeInterruptionCheckpoint.fromEnvironment(
      {
        HVIR_SMOKE_ISOLATION_RUN: RUN_TOKEN,
        HVIR_SMOKE_ISOLATION_CHECKPOINT: 'renderer-watch-ready',
        HVIR_SMOKE_ISOLATION_ACTION: 'observe',
      },
      (line) => output.push(line),
    )
    onTestFinished(() => checkpoint.dispose())

    await checkpoint.reach({
      name: 'profile-pty-ready',
      profileCount: 2,
      ptyCount: 1,
      predecessorProfileObserved: false,
    })
    await checkpoint.reach({
      name: 'renderer-watch-ready',
      ownerGeneration: 1,
      watcherActive: true,
      predecessorSelectionObserved: false,
    })
    checkpoint.disposed('project watch')

    expect(output).toHaveLength(2)
    expect(parseSmokeCheckpointLine(output[0]!)).toEqual({
      schema: 1,
      runToken: RUN_TOKEN,
      name: 'renderer-watch-ready',
      ownerGeneration: 1,
      watcherActive: true,
      predecessorSelectionObserved: false,
    })
    expect(output[1]).toBe(
      `[smoke:isolation:disposed] {"schema":1,"runToken":"${RUN_TOKEN}","resource":"project watch"}`,
    )
  })

  it('preserves the controlled scenario failure as the primary outcome', async () => {
    const checkpoint = SmokeInterruptionCheckpoint.fromEnvironment(
      {
        HVIR_SMOKE_ISOLATION_RUN: RUN_TOKEN,
        HVIR_SMOKE_ISOLATION_CHECKPOINT: 'profile-pty-ready',
        HVIR_SMOKE_ISOLATION_ACTION: 'fail',
      },
      () => undefined,
    )
    onTestFinished(() => checkpoint.dispose())

    await expect(
      checkpoint.reach({
        name: 'profile-pty-ready',
        profileCount: 2,
        ptyCount: 1,
        predecessorProfileObserved: false,
      }),
    ).rejects.toThrow('Controlled smoke failure at checkpoint profile-pty-ready')
  })

  it('rejects unreviewed checkpoint fields', () => {
    expect(() =>
      parseSmokeCheckpointLine(
        `[smoke:isolation:checkpoint] ${JSON.stringify({
          schema: 1,
          runToken: RUN_TOKEN,
          name: 'renderer-watch-ready',
          ownerGeneration: 1,
          watcherActive: true,
          predecessorSelectionObserved: false,
          terminalTranscript: 'not allowed',
        })}`,
      ),
    ).toThrow('unreviewed fields')
  })
})

describe('owned stale smoke roots', () => {
  it('removes only an exact marker beneath the canonical temporary parent', async () => {
    const root = await ownedRoot()
    await cleanupOwnedSmokeRoot(root, tmpdir())
    await expect(readFile(join(root, SMOKE_OWNERSHIP_MARKER))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('refuses an invalid marker and leaves the root intact', async () => {
    const root = await ownedRoot()
    await writeFile(join(root, SMOKE_OWNERSHIP_MARKER), 'wrong-owner\n')

    await expect(cleanupOwnedSmokeRoot(root, tmpdir())).rejects.toThrow(
      'invalid ownership marker',
    )
    expect(await readFile(join(root, SMOKE_OWNERSHIP_MARKER), 'utf8')).toBe(
      'wrong-owner\n',
    )
  })
})

async function ownedRoot(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'hvir-smoke.'))
  await writeFile(join(root, SMOKE_OWNERSHIP_MARKER), SMOKE_OWNERSHIP_MARKER_VALUE)
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  return root
}
