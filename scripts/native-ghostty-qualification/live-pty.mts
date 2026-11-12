import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { LocalHost } from '../../src/main/project-host/local-host'
import { PtySupervisor } from '../../src/main/pty/pty-supervisor'
import { harnessProvider } from '../../src/main/harness/bundled-harness-providers'
import { hostPath, LOCAL_HOST_ID } from '../../src/shared'

/** Only the experiment depends on production launch/host owners; no reverse edge. */
export class LivePtys {
  readonly host = new LocalHost()
  readonly supervisor = new PtySupervisor()
  readonly samples: number[] = []
  readonly streams = new Map<
    string,
    {
      bytes: number
      chunks: number
      maxChunkBytes: number
      transcript?: string
      digest: ReturnType<typeof createHash>
      pid?: number
      exit?: number
      detach?: () => void | Promise<void>
    }
  >()

  async launch(options: {
    id: string
    owner: number
    cwd: string
    provider: 'plain-shell' | 'claude-code'
    fixture?: { node: string; file: string }
    feed: (data: Buffer) => void
    onError: (error: unknown) => void
  }): Promise<void> {
    const stream = {
      bytes: 0,
      chunks: 0,
      maxChunkBytes: 0,
      digest: createHash('sha256'),
      ...(options.fixture ? { transcript: '' } : {}),
    }
    this.streams.set(options.id, stream)
    const managed = await this.supervisor.spawn({
      host: this.host,
      provider: harnessProvider(options.fixture ? 'plain-shell' : options.provider),
      cwd: hostPath(LOCAL_HOST_ID, options.cwd),
      ownerId: options.owner,
      ownerGeneration: 1,
      sessionId: options.id,
      cols: 100,
      rows: 30,
      ...(options.fixture
        ? {
            launchSpec: {
              file: options.fixture.node,
              args: [options.fixture.file, options.id],
            },
          }
        : {}),
    })
    const record = this.streams.get(options.id)!
    record.pid = managed.pid
    record.detach = this.supervisor.attach(
      options.id,
      options.owner,
      {
        onData: (data) => {
          try {
            const bytes = Buffer.from(data)
            record.bytes += bytes.length
            record.chunks++
            record.maxChunkBytes = Math.max(record.maxChunkBytes, bytes.length)
            record.digest.update(bytes)
            if (record.transcript !== undefined) {
              if (record.transcript.length + data.length > 2 * 1024 * 1024)
                throw new Error('Disposable fixture transcript exceeded its bound')
              record.transcript += data
            }
            const started = performance.now()
            options.feed(bytes)
            if (this.samples.length < 20000)
              this.samples.push(performance.now() - started)
          } catch (error) {
            options.onError(error)
          }
        },
        onExit: (exit) => {
          record.exit = exit.exitCode
        },
      },
      1,
    )
  }

  write(id: string, owner: number, text: string): void {
    if (Buffer.byteLength(text) > 65536) throw new Error('Input exceeds experiment bound')
    this.supervisor.write(id, owner, text, 1)
  }

  resize(id: string, owner: number, cols: number, rows: number): void {
    this.supervisor.resize(id, owner, cols, rows, 1)
  }

  async stop(): Promise<void> {
    await this.supervisor.disposeAllAndWait()
    for (const stream of this.streams.values()) await stream.detach?.()
  }

  evidence(): unknown {
    return [...this.streams].map(([id, stream]) => ({
      id,
      bytes: stream.bytes,
      chunks: stream.chunks,
      maxChunkBytes: stream.maxChunkBytes,
      sha256: stream.digest.copy().digest('hex'),
      exit: stream.exit ?? null,
      processAliveAfterCleanup: stream.pid ? processAlive(stream.pid) : null,
    }))
  }
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
