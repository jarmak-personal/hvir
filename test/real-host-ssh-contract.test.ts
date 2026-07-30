import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, onTestFinished } from 'vitest'

import {
  REAL_HOST_SSH_ENVIRONMENT_KEYS,
  createRealHostSshFailureEvidence,
  readRealHostSshConfiguration,
  writeRealHostSshFailureEvidence,
} from '../scripts/real-host-ssh-contract.mts'

const HOST_KEY = `SHA256:${'A'.repeat(43)}`

describe('real-host SSH acceptance contract', () => {
  it('reports an absent explicit target as unavailable without ambient fallback', () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: '/ambient-home-must-not-be-read',
      SSH_AUTH_SOCK: '/ambient-agent-must-not-be-read',
      SSH_CONNECTION: 'ambient-connection-must-not-be-read',
    }
    for (const key of REAL_HOST_SSH_ENVIRONMENT_KEYS) delete environment[key]

    const result = spawnSync('npm', ['run', 'acceptance:ssh:real-host'], {
      cwd: new URL('..', import.meta.url),
      env: environment,
      encoding: 'utf8',
    })

    expect(result.status).toBe(2)
    expect(result.stderr).toContain(
      'unavailable: explicit target configuration is absent',
    )
    expect(result.stderr).not.toContain('ambient')
  })

  it('fails closed on partial configuration without retaining supplied secret material', () => {
    const result = readRealHostSshConfiguration({
      HVIR_REAL_SSH_HOST: 'acceptance.example.test',
      HVIR_REAL_SSH_PRIVATE_KEY: 'PRIVATE-KEY-MUST-NOT-ESCAPE',
    })

    expect(result.kind).toBe('invalid')
    expect(JSON.stringify(result)).not.toContain('PRIVATE-KEY-MUST-NOT-ESCAPE')
    if (result.kind === 'invalid') {
      expect(result.fields).toContain('HVIR_REAL_SSH_PORT')
      expect(result.fields).toContain('HVIR_REAL_SSH_HOST_KEY')
    }
  })

  it('accepts one exact pinned target and records only credential provenance', () => {
    const result = readRealHostSshConfiguration({
      HVIR_REAL_SSH_HOST: 'acceptance.example.test',
      HVIR_REAL_SSH_PORT: '2222',
      HVIR_REAL_SSH_USER: 'hvir-acceptance',
      HVIR_REAL_SSH_HOST_KEY: HOST_KEY,
      HVIR_REAL_SSH_ROOT_PARENT: '/srv/hvir-acceptance',
      HVIR_REAL_SSH_PRIVATE_KEY: 'PRIVATE-KEY-MUST-NOT-ESCAPE',
      HVIR_REAL_SSH_PASSPHRASE: 'PASSPHRASE-MUST-NOT-ESCAPE',
    })

    expect(result).toEqual({
      kind: 'configured',
      value: {
        alias: 'real-host-acceptance',
        hostname: 'acceptance.example.test',
        port: 2222,
        user: 'hvir-acceptance',
        trustedHostKey: HOST_KEY,
        rootParent: '/srv/hvir-acceptance',
        credential: { kind: 'inline' },
        hasPassphrase: true,
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-KEY|PASSPHRASE/)
  })

  it('writes a bounded, content-free failure artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-real-host-evidence-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    const evidence = createRealHostSshFailureEvidence({
      phase: 'loopback-stream',
      durationMs: 1234.6,
      connectionState: 'connected',
      watchTier: 'polling',
      resources: {
        rootRegistered: true,
        watcherActive: false,
        ptyCount: 0,
        providerObserverActive: false,
        loopbackActive: true,
        streamCount: 2,
      },
      transports: [
        {
          id: 1,
          role: 'control',
          primary: true,
          channels: 2,
          pendingChannels: 0,
          channelBudget: 6,
          refusedChannels: 0,
        },
      ],
    })

    expect(await writeRealHostSshFailureEvidence(directory, evidence)).toBe(true)
    const contents = await readFile(join(directory, 'real-host-ssh-failure.json'), 'utf8')
    expect(Buffer.byteLength(contents)).toBeLessThanOrEqual(4_096)
    expect(JSON.parse(contents)).toEqual(evidence)
    expect(contents).not.toMatch(
      /hostname|username|fingerprint|private|passphrase|terminal|cookie|header|path/,
    )
  })
})
