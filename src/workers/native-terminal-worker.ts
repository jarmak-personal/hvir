import { runNativeTerminalHost } from './native-terminal-runtime'
import type { NativeTerminalWorkerOptions } from '../shared/native-terminal'

const port = process.parentPort
if (!port) throw new Error('Native terminal host requires Electron utility parent')
port.once('message', ({ data }: { data: NativeTerminalWorkerOptions }) => {
  runNativeTerminalHost(port, data)
})
