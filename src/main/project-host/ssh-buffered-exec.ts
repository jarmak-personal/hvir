import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Client, ClientChannel } from 'ssh2'
import type { ExecResult } from '../../shared/fs-types'
import type { ExecOptions } from './project-host'
import type { SshTransportPool } from './ssh-transport-pool'
import { remoteCommand, quoteSshArgument } from './ssh-command'

/** Buffered SSH channel effects; the host/pool own ordinary and finite admission respectively. */
export function startBufferedSshExec(
  pool: SshTransportPool,
  command: string,
  args: readonly string[],
  opts: ExecOptions,
  finite = false,
): Promise<ExecResult> | undefined {
  const statusMarker = `__hvir_exec_status_${randomUUID()}__`
  const open = (client: Client) =>
    new Promise<ClientChannel>((resolve, reject) => {
      try {
        client.exec(
          remoteBufferedCommand(command, args, opts, statusMarker),
          (error, value) => (error ? reject(error) : resolve(value)),
        )
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  const channel = finite
    ? pool.tryOpenFiniteChannel(open, opts.signal)
    : pool.openChannel('control', open, opts.signal)
  return channel?.then((stream) =>
    collectBufferedSshExec(stream, opts, statusMarker, finite),
  )
}

function collectBufferedSshExec(
  stream: ClientChannel,
  opts: ExecOptions,
  statusMarker: string,
  drain: boolean,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    // The private status trailer is transport metadata, never part of finite tool-output authority.
    const maximum =
      (opts.maxBuffer ?? 10 * 1024 * 1024) +
      (drain ? Buffer.byteLength(statusMarker) + 3 : 0)
    let stdout = '',
      stderr = '',
      bytes = 0,
      stdoutNulRecords = 0,
      code: number | null = null,
      signal: string | null = null
    let settled = false
    let terminalError: Error | undefined
    let truncated = false
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const append = (kind: 'out' | 'err', chunk: Buffer): void => {
      if (truncated) return
      bytes += chunk.length
      if (kind === 'out' && opts.maxStdoutNulRecords !== undefined) {
        for (const byte of chunk) if (byte === 0) stdoutNulRecords++
      }
      if (kind === 'out') stdout += stdoutDecoder.write(chunk)
      else stderr += stderrDecoder.write(chunk)
      if (
        bytes > maximum ||
        (opts.maxStdoutNulRecords !== undefined &&
          stdoutNulRecords >= opts.maxStdoutNulRecords)
      ) {
        if (opts.allowTruncatedOutput) {
          truncated = true
          return stream.close()
        }
        terminalError = new Error('SSH exec output exceeded maxBuffer')
        if (!drain) {
          reject(terminalError)
          settled = true
        }
        return stream.close()
      }
    }
    stream.on('data', (chunk: Buffer) => append('out', chunk))
    stream.stderr.on('data', (chunk: Buffer) => append('err', chunk))
    stream.on('exit', (exitCode: number | null, exitSignal?: string) => {
      code = exitCode
      signal = exitSignal ?? null
    })
    stream.on('error', (reason: Error) => {
      terminalError = reason
      if (!drain) {
        reject(reason)
        settled = true
      } else stream.close()
    })
    stream.on('close', () => {
      if (!settled && terminalError) reject(terminalError)
      else if (!settled) {
        stdout += stdoutDecoder.end()
        stderr += stderrDecoder.end()
        const recovered = recoverBufferedExecStatus(stderr, statusMarker)
        resolve({
          code: recovered.code ?? code,
          signal,
          stdout,
          stderr: recovered.stderr,
          ...(truncated ? { outputTruncated: true } : {}),
        })
      }
      settled = true
    })
    if (opts.signal) {
      const abort = (): void => {
        terminalError = new DOMException('The operation was aborted', 'AbortError')
        if (!drain) {
          reject(terminalError)
          settled = true
        }
        stream.close()
      }
      stream.once('close', () => opts.signal?.removeEventListener('abort', abort))
      opts.signal.addEventListener('abort', abort, { once: true })
      if (opts.signal.aborted) {
        abort()
        return
      }
    }
    stream.end(opts.input)
  })
}

function remoteBufferedCommand(
  command: string,
  args: readonly string[],
  opts: Pick<ExecOptions, 'cwd' | 'env' | 'unsetEnv'>,
  statusMarker: string,
): string {
  const invocation = remoteCommand(command, args, opts)
  return `( ${invocation} ); hvir_status=$?; printf '%s%s' ${quoteSshArgument(statusMarker)} "$hvir_status" >&2; exit "$hvir_status"`
}
function recoverBufferedExecStatus(
  stderr: string,
  statusMarker: string,
): { readonly code?: number; readonly stderr: string } {
  const markerAt = stderr.lastIndexOf(statusMarker)
  if (markerAt < 0) return { stderr }
  const rawCode = stderr.slice(markerAt + statusMarker.length)
  if (!/^\d{1,3}$/.test(rawCode)) return { stderr }
  const code = Number(rawCode)
  if (!Number.isSafeInteger(code) || code > 255) return { stderr }
  return { code, stderr: stderr.slice(0, markerAt) }
}
