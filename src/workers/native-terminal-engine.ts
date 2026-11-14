import { drainNativeTerminalEffects } from './native-terminal-effects'
/** One real caller thread. This entry never imports Electron or project capabilities. */
import { parentPort, workerData } from 'node:worker_threads'
import engine, { type Host } from '@hvir/native-terminal/engine'
import { normalizeNativeTerminalPixels } from './native-terminal-pixels'
import {
  validNativeTerminalLinuxOptions,
  validNativeTerminalExportMode,
} from '../shared/native-terminal-linux'
import type { NativeTerminalWorkerOptions } from '../shared/native-terminal'
import {
  validNativeTerminalSelectionContext,
  validNativeTerminalSelectionOperation,
} from '../shared/native-terminal-selection'

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
        case 'input': {
          const selectionContext = args[4]
          if (
            selectionContext !== undefined &&
            !validNativeTerminalSelectionContext(selectionContext)
          )
            throw new Error('native-selection-context-invalid')
          try {
            value = engine.input(
              host,
              BigInt(String(args[0])),
              args[1] as Parameters<typeof engine.input>[2],
              args[2] === true,
              args[3] as Parameters<typeof engine.input>[4],
              selectionContext && {
                screen: selectionContext.screen,
                geometrySerial: BigInt(selectionContext.geometrySerial),
              },
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
        }
        case 'selection': {
          const operation = args[1]
          if (!validNativeTerminalSelectionOperation(operation))
            throw new Error('native-selection-command-invalid')
          const id = BigInt(String(args[0]))
          switch (operation.kind) {
            case 'command':
              value = engine.selection(host, id, operation.action, {
                screen: operation.context.screen,
                geometrySerial: BigInt(operation.context.geometrySerial),
              })
              break
            case 'begin':
              value = engine.extractBegin(host, id, BigInt(operation.selectionSerial), {
                screen: operation.context.screen,
                geometrySerial: BigInt(operation.context.geometrySerial),
              })
              break
            case 'next':
              value = engine.extractNext(host, id, BigInt(operation.cursor))
              break
            case 'finish':
              value = engine.extractFinish(host, id, BigInt(operation.cursor))
              break
            case 'close':
              value = engine.extractClose(host, id, BigInt(operation.cursor))
              break
            case 'link-row-begin': {
              const result = engine.linkRowBegin(host, id, {
                ...operation.query,
                geometrySerial: BigInt(operation.query.geometrySerial),
              })
              value = result.link
                ? {
                    ...result,
                    link: {
                      ...result.link,
                      uri: new TextDecoder('utf-8', { fatal: true }).decode(
                        result.link.uri,
                      ),
                    },
                  }
                : result
              break
            }
          }
          break
        }
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
        case 'effects':
          value = drainNativeTerminalEffects(() =>
            engine.event(host, BigInt(String(args[0]))),
          )
          break
        case 'link': {
          const query =
            args[1] as import('../shared/native-terminal-link').NativeTerminalLinkQuery
          const result = engine.link(host, BigInt(String(args[0])), {
            ...query,
            expectedSequence: BigInt(query.expectedSequence),
            expectedMutation: BigInt(query.expectedMutation),
            expectedGeometrySerial: BigInt(query.expectedGeometrySerial),
          })
          value =
            result.result === 6
              ? { result: 0, unavailable: 6 }
              : result.link
                ? {
                    result: result.result,
                    link: {
                      ...result.link,
                      uri: new TextDecoder('utf-8', { fatal: true }).decode(
                        result.link.uri,
                      ),
                    },
                  }
                : { result: result.result }
          break
        }
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
