import { discardNativeTerminalEffects } from './native-terminal-effects'
/** One real caller thread. This entry never imports Electron or project capabilities. */
import { parentPort, workerData } from 'node:worker_threads'
import engine, { type Host } from '@hvir/native-terminal/engine'
import { normalizeNativeTerminalPixels } from './native-terminal-pixels'
import {
  validNativeTerminalLinuxOptions,
  validNativeTerminalExportMode,
} from '../shared/native-terminal-linux'
import type { NativeTerminalWorkerOptions } from '../shared/native-terminal'

if (!parentPort) throw new Error('Native terminal engine requires its owner worker')
const options = workerData as Pick<NativeTerminalWorkerOptions, 'library' | 'linux'>
if (
  options.linux !== undefined &&
  (process.platform !== 'linux' || !validNativeTerminalLinuxOptions(options.linux))
)
  throw new Error('native-linux-config-invalid')
const opened = options.linux
  ? engine.open(options.library, {
      ...(options.linux.device.kind === 'drm-render-node'
        ? { renderNode: options.linux.device.node.path }
        : {}),
      presentationMode: options.linux.presentationMode,
    })
  : engine.open(options.library)
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
        case 'key':
          value = engine.key(
            host,
            BigInt(String(args[0])),
            Number(args[1]),
            Number(args[2]),
            Number(args[3]),
            String(args[4]),
            65536,
          )
          break
        case 'input':
          try {
            value = engine.input(
              host,
              BigInt(String(args[0])),
              args[1] as Parameters<typeof engine.input>[2],
              args[2] === true,
              args[3] as Parameters<typeof engine.input>[4],
            )
          } catch (error) {
            // This reserved NAPI code is emitted only by input_text's allocation
            // before the facade is called. Do not extend this catch to cloning.
            if (
              !(error instanceof Error) ||
              !('code' in error) ||
              error.code !== 'HVIR_INPUT_ALLOCATION_UNSENT'
            )
              throw error
            value = { result: 7, requestedMutation: 0n, capacity: 0 }
          }
          break
        case 'visibility':
          value = engine.visibility(host, BigInt(String(args[0])), args[1] === true)
          break
        case 'presentation-mode':
          if (!validNativeTerminalExportMode(args[1]))
            throw new Error('native-mode-invalid')
          value = engine.presentationMode(
            host,
            BigInt(String(args[0])),
            args[1] === 'pixels' ? 1 : 0,
          )
          break
        case 'renderer-info':
          value = engine.rendererInfo(host, BigInt(String(args[0])))
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
        case 'discard-events':
          value = discardNativeTerminalEffects(() =>
            engine.event(host, BigInt(String(args[0]))),
          )
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
