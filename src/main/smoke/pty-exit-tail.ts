import { createHash } from 'node:crypto'

import type { HostPath } from '../../shared'
import { plainShellProvider } from '../harness/harness-provider'
import type { ProjectHost, PtyExit } from '../project-host'
import type { PtyPreparedTerminal } from '../pty/pty-contract'
import type { PtySupervisor } from '../pty/pty-supervisor'

const MARKER = 'HVIR_FINAL_1114_TAIL_f729c8e1'
const BLOCK = '0123456789abcdef'.repeat(4096)
const OWNER = 0
const DEADLINE_MS = 12000

/** Real transport regression; latency is simulated, never native GPU evidence.
 * Hash incrementally so a stream larger than ingress credit is not a transcript. */
export async function verifyPtyExitTail(
  host: ProjectHost,
  supervisor: PtySupervisor,
  root: HostPath,
): Promise<void> {
  const results = []
  for (const [mode, blocks] of [
    ['baseline', 1],
    ['fast', 1],
    ['delayed', 1],
    ['delayed', 17],
  ] as const) {
    const expectedBytes = BLOCK.length * blocks + MARKER.length
    const expected = createHash('sha256')
    for (let i = 0; i < blocks; i++) expected.update(BLOCK)
    expected.update(MARKER)
    const expectedHash = expected.digest('hex')
    const decodedHash = createHash('sha256'),
      nativeHash = createHash('sha256')
    let decodedBytes = 0,
      nativeBytes = 0,
      decodedTail = '',
      nativeTail = ''
    let active = 0,
      maximumActive = 0,
      maximumBatch = 0
    let physicalExit: PtyExit | undefined
    let finish!: () => void, fail!: (error: unknown) => void
    const completed = new Promise<void>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    // Own the rejection before spawning; synchronous source delivery can fail early.
    void completed.catch(() => undefined)
    const sessionId = `exit-tail-${mode}-${blocks}`
    const native: PtyPreparedTerminal = {
      columns: 80,
      rows: 24,
      connect() {},
      async output(text) {
        const bytes = Buffer.byteLength(text, 'utf8')
        maximumBatch = Math.max(maximumBatch, bytes)
        maximumActive = Math.max(maximumActive, ++active)
        try {
          if (mode === 'delayed' && nativeBytes >= BLOCK.length * blocks - 5536)
            await new Promise<void>((resolve) => setTimeout(resolve, 500))
          nativeHash.update(text)
          nativeBytes += bytes
          nativeTail = (nativeTail + text).slice(-MARKER.length)
        } finally {
          active--
        }
      },
      exited() {
        finish()
        return Promise.resolve()
      },
      failed(error) {
        fail(error)
      },
      async dispose() {},
    }
    const stop = supervisor.onExit((info, exit) => {
      if (info.id !== sessionId) return
      physicalExit = exit
      if (mode === 'baseline') finish()
    })
    const cancellation = new AbortController()
    const timer = setTimeout(() => {
      cancellation.abort()
      fail(new Error(`PTY exit tail timeout: ${sessionId}`))
    }, DEADLINE_MS)
    let terminal: Awaited<ReturnType<PtySupervisor['spawn']>> | undefined
    try {
      terminal = await supervisor.spawn({
        host,
        provider: plainShellProvider,
        cwd: root,
        workspaceRoot: root,
        ownerId: OWNER,
        sessionId,
        signal: cancellation.signal,
        launchSpec: {
          file: process.execPath,
          args: [
            '-e',
            `setTimeout(async()=>{const b='0123456789abcdef'.repeat(4096);for(let i=0;i<${blocks};i++)await new Promise(r=>process.stdout.write(b,r));process.stdout.write('${MARKER}',()=>process.exit(0))},100)`,
          ],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
        ...(mode === 'baseline'
          ? {}
          : { prepareTerminal: () => Promise.resolve(native) }),
      })
      supervisor.attach(terminal.id, OWNER, {
        onData(text) {
          decodedHash.update(text)
          decodedBytes += Buffer.byteLength(text, 'utf8')
          decodedTail = (decodedTail + text).slice(-MARKER.length)
        },
      })
      await completed
      if (
        physicalExit?.exitCode !== 0 ||
        decodedBytes !== expectedBytes ||
        decodedHash.digest('hex') !== expectedHash ||
        decodedTail !== MARKER ||
        (mode !== 'baseline' &&
          (nativeBytes !== expectedBytes ||
            nativeHash.digest('hex') !== expectedHash ||
            nativeTail !== MARKER ||
            maximumActive !== 1 ||
            maximumBatch > 128 * 1024))
      )
        throw new Error(
          `PTY exit tail mismatch: ${sessionId} decoded=${decodedBytes} native=${nativeBytes} expected=${expectedBytes}`,
        )
      // Signal zero observes only this owned child; cleanup never targets a PID match.
      let childAlive = false
      try {
        process.kill(terminal.pid, 0)
        childAlive = true
      } catch {
        /* Reaped. */
      }
      if (childAlive) throw new Error(`PTY exit tail child still alive: ${sessionId}`)
      results.push({
        mode,
        bytes: expectedBytes,
        sha256: expectedHash,
        simulatedTailDelayMs: mode === 'delayed' ? 500 : 0,
        maximumNativeBatchBytes: maximumBatch,
        maximumPhysicalConsumers: maximumActive,
        ownedChildExited: true,
      })
    } finally {
      clearTimeout(timer)
      await stop()
      if (terminal && supervisor.get(sessionId)?.instanceId === terminal.instanceId)
        supervisor.disposeSession(sessionId, OWNER)
    }
  }
  console.log(
    'HVIR_PTY_EXIT_TAIL_OK ' +
      JSON.stringify({
        cases: results,
        realSupervisorAndLocalHost: true,
        nativeConsumerSimulated: true,
        hardwareQualified: false,
      }),
  )
}
