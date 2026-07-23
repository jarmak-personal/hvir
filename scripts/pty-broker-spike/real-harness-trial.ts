// The decision spike writes only marker files in its own mkdtemp root.
// eslint-disable-next-line no-restricted-imports
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  sessionAuthority,
  startSpikeBroker,
  waitForBrokerEvent,
  type SpikeBrokerClient,
} from './client.ts'
import type { BrokerEvent, BrokerSpawnBody } from './protocol.ts'

type HarnessKind = 'claude' | 'codex'

async function main(): Promise<void> {
  if (!process.versions.electron || process.env['ELECTRON_RUN_AS_NODE'] !== '1') {
    throw new Error('Run the real-harness trial through the repository package script')
  }
  const kind = process.argv[2]
  if (kind !== 'claude' && kind !== 'codex') {
    throw new Error('Real-harness trial requires claude or codex')
  }
  const scratch = await mkdtemp(join(tmpdir(), `hvir-${kind}-broker-trial-`))
  const marker = join(scratch, 'turn-progress.marker')
  const handle = await startSpikeBroker({
    perSessionReplayBytes: 256 * 1024,
    globalReplayBytes: 512 * 1024,
    clientQueueBytes: 512 * 1024,
    defaultLeaseMs: 2 * 60 * 1000,
    terminationGraceMs: 1_000,
    tombstoneMs: 2_000,
  })
  const first = await handle.connect()
  const startedAt = performance.now()
  let outputBytesBeforeDisconnect = 0
  const disposeFirstOutput = first.onEvent((event) => {
    if (event.event === 'data') {
      outputBytesBeforeDisconnect += Buffer.byteLength(event.data, 'utf8')
    }
  })
  try {
    const spawned = await first.spawn(realHarnessLaunch(kind, scratch, marker))
    await delay(750)
    disposeFirstOutput()
    first.crash()

    const second = await handle.connect()
    await markerOrLiveExit(second, spawned.sessionId, marker, 90_000)
    let outputBytesAfterReattach = 0
    const disposeSecondOutput = second.onEvent((event) => {
      if (event.event === 'data' && event.sessionId === spawned.sessionId) {
        outputBytesAfterReattach += Buffer.byteLength(event.data, 'utf8')
      }
    })
    const attached = await second.attach(sessionAuthority(spawned))
    outputBytesAfterReattach += attached.replayBytes
    const exitEvent = waitForBrokerEvent(
      second,
      (event) => event.event === 'exit' && event.sessionId === spawned.sessionId,
      120_000,
    )
    const exit = (await exitEvent) as Extract<BrokerEvent, { readonly event: 'exit' }>
    disposeSecondOutput()
    await second.close()
    process.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          harness: kind,
          brokerPid: handle.pid,
          ptyPid: spawned.pid,
          reattachedPtyPid: attached.pid,
          samePtyPid: attached.pid === spawned.pid,
          markerObservedAfterDisconnect: true,
          attachmentEpochAdvanced: attached.epoch > spawned.epoch,
          exitCode: exit.exitCode,
          signal: exit.signal,
          outputBytesBeforeDisconnect,
          outputBytesAfterReattach,
          elapsedMs: rounded(performance.now() - startedAt),
        },
        null,
        2,
      )}\n`,
    )
  } finally {
    disposeFirstOutput()
    await first.close().catch(() => undefined)
    await handle.cleanup()
    await rm(scratch, { recursive: true, force: true })
  }
}

function realHarnessLaunch(
  kind: HarnessKind,
  scratch: string,
  marker: string,
): BrokerSpawnBody {
  const command =
    `sleep 3; printf completed > ${shellQuote(marker)}; ` +
    'sleep 8; printf trial-finished'
  const prompt =
    'Use the shell exactly once to run the following command. ' +
    `Wait for it to finish before replying: ${command}`
  if (kind === 'claude') {
    return {
      file: 'claude',
      args: [
        '-p',
        '--safe-mode',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--dangerously-skip-permissions',
        '--tools',
        'Bash',
        '--max-budget-usd',
        '1.00',
        prompt,
      ],
      cwd: scratch,
      unsetEnv: ['ELECTRON_RUN_AS_NODE', 'HVIR_PTY_BROKER_SPIKE'],
      leaseMs: 2 * 60 * 1000,
    }
  }
  return {
    file: 'codex',
    args: [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-rules',
      '--dangerously-bypass-approvals-and-sandbox',
      '--color',
      'never',
      '-C',
      scratch,
      prompt,
    ],
    cwd: scratch,
    unsetEnv: ['ELECTRON_RUN_AS_NODE', 'HVIR_PTY_BROKER_SPIKE'],
    leaseMs: 2 * 60 * 1000,
  }
}

async function markerOrLiveExit(
  client: SpikeBrokerClient,
  sessionId: string,
  marker: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pathExists(marker)) return
    const status = (await client.list()).find(
      (candidate) => candidate.sessionId === sessionId,
    )
    if (!status || status.state === 'exited') {
      throw new Error('Harness exited before producing the content-free progress marker')
    }
    await delay(100)
  }
  throw new Error('Harness did not produce the content-free progress marker in time')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false
    }
    throw error
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Real-harness broker trial failed: ${message}\n`)
  process.exitCode = 1
})
