/** One real caller thread. This entry never imports Electron or project capabilities. */
import { parentPort, workerData } from 'node:worker_threads'
import engine, { type Host } from '@hvir/native-terminal/engine'
import { normalizeNativeTerminalPixels } from './native-terminal-pixels'

if (!parentPort) throw new Error('Native terminal engine requires its owner worker')
const opened = engine.open((workerData as { library: string }).library)
if (opened.result || !opened.host) throw new Error(`native-open:${opened.result}`)
const host: Host = opened.host
parentPort.postMessage({ kind: 'ready' })
parentPort.on(
  'message',
  (request: { id: number; operation: string; args: unknown[] }) => {
    try {
      const { operation, args } = request
      let value: unknown
      switch (operation) {
        case 'create':
          value = engine.createBegin(host, Number(args[0]), Number(args[1]))
          break
        case 'feed':
          value = engine.feed(
            host,
            BigInt(String(args[0])),
            BigInt(String(args[1])),
            args[2] as Uint8Array,
          )
          break
        case 'resize':
          value = engine.resize(
            host,
            BigInt(String(args[0])),
            BigInt(String(args[1])),
            Number(args[2]),
            Number(args[3]),
            args[4] === undefined ? 1 : Number(args[4]),
          )
          break
        case 'visibility':
          value = engine.visibility(host, BigInt(String(args[0])), args[1] === true)
          break
        case 'pixels':
          value = engine.copyFrame(
            host,
            BigInt(String(args[0])),
            BigInt(String(args[1])),
            16 * 1024 * 1024,
          )
          {
            const copied = value as { result: number; data?: Buffer; stride?: number }
            if (!copied.result && copied.data && copied.stride)
              normalizeNativeTerminalPixels(copied.data, copied.stride, Number(args[2]))
          }
          break
        case 'inspect':
          value = engine.inspect(host, BigInt(String(args[0])))
          break
        case 'read':
          value = engine.read(host, BigInt(String(args[0])), 65536)
          break
        case 'drain':
          value = engine.drain(host, BigInt(String(args[0])), 65536)
          break
        case 'event':
          value = engine.event(host, BigInt(String(args[0])))
          break
        case 'frame':
          value = engine.takeFrame(host, BigInt(String(args[0])))
          break
        case 'release':
          value = engine.releaseFrame(
            host,
            BigInt(String(args[0])),
            BigInt(String(args[1])),
          )
          break
        case 'destroy':
          value = engine.destroy(host, BigInt(String(args[0])))
          break
        case 'close':
          value = engine.close(host)
          break
        default:
          throw new Error('Unknown native terminal operation')
      }
      parentPort?.postMessage({ id: request.id, value })
    } catch {
      // Allocation may fail after native mutation. Never pretend the job was unapplied.
      parentPort?.postMessage({ id: request.id, fatal: true })
      process.exitCode = 1
      parentPort?.close()
    }
  },
)
