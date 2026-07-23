// Synthetic issue #215 fixture: never imported by the application.
// eslint-disable-next-line no-restricted-imports
import { spawn } from 'node:child_process'
// Synthetic issue #215 fixture writes only caller-provided mkdtemp evidence.
// eslint-disable-next-line no-restricted-imports
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

interface HarnessOptions {
  readonly markerPath: string
  readonly processRecordPath: string
  readonly delayMs: number
  readonly ignoreSigterm: boolean
}

async function main(): Promise<void> {
  if (process.argv[2] === '--grandchild') {
    await runGrandchild(process.argv[3])
    return
  }
  const options = parseOptions(process.argv.slice(2))
  if (options.ignoreSigterm) process.on('SIGTERM', () => undefined)
  const entry = fileURLToPath(import.meta.url)
  const grandchild = spawn(
    process.execPath,
    [entry, '--grandchild', options.processRecordPath],
    {
      stdio: 'ignore',
    },
  )
  if (!grandchild.pid) throw new Error('Synthetic grandchild did not report a pid')
  await writeFile(
    options.processRecordPath,
    JSON.stringify({ leaderPid: process.pid, grandchildPid: grandchild.pid }),
    { encoding: 'utf8', mode: 0o600 },
  )
  process.stdout.write(`ready:${process.pid}:${grandchild.pid}\n`)
  setTimeout(() => {
    void writeFile(options.markerPath, 'completed\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
  }, options.delayMs).unref()
  process.on('SIGWINCH', () => {
    process.stdout.write(
      `size:${process.stdout.columns ?? 0}x${process.stdout.rows ?? 0}\n`,
    )
  })
  process.stdin.setEncoding('utf8')
  let input = ''
  process.stdin.on('data', (data: string) => {
    input += data
    while (true) {
      const newline = input.indexOf('\n')
      if (newline < 0) return
      const command = input.slice(0, newline).replace(/\r$/, '')
      input = input.slice(newline + 1)
      handleCommand(command, grandchild.pid!)
    }
  })
  setInterval(() => undefined, 60_000)
}

function runGrandchild(processRecordPath: string | undefined): Promise<void> {
  if (!processRecordPath) throw new Error('Synthetic grandchild record path is required')
  setInterval(() => undefined, 60_000)
  return new Promise(() => undefined)
}

function handleCommand(command: string, grandchildPid: number): void {
  if (command.startsWith('ping ')) {
    process.stdout.write(`pong ${command.slice(5)}\n`)
    return
  }
  if (command.startsWith('flood ')) {
    const bytes = Number(command.slice(6))
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 32 * 1024 * 1024) {
      process.stdout.write('flood-invalid\n')
      return
    }
    const chunk = 'x'.repeat(Math.min(16 * 1024, bytes))
    let remaining = bytes
    while (remaining > 0) {
      const length = Math.min(chunk.length, remaining)
      process.stdout.write(chunk.slice(0, length))
      remaining -= length
    }
    process.stdout.write('\nflood-end\n')
    return
  }
  if (command === 'exit') {
    try {
      process.kill(grandchildPid, 'SIGTERM')
    } catch {
      // The exact synthetic child already ended.
    }
    process.exit(0)
  }
}

function parseOptions(args: readonly string[]): HarnessOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('Invalid synthetic harness arguments')
    }
    values.set(key.slice(2), value)
  }
  const markerPath = values.get('marker')
  const processRecordPath = values.get('process-record')
  const delayMs = Number(values.get('delay-ms') ?? '250')
  const ignoreSigtermValue = values.get('ignore-sigterm') ?? 'false'
  if (
    !markerPath ||
    !processRecordPath ||
    !Number.isSafeInteger(delayMs) ||
    delayMs < 0 ||
    delayMs > 60_000 ||
    (ignoreSigtermValue !== 'true' && ignoreSigtermValue !== 'false')
  ) {
    throw new Error('Invalid synthetic harness options')
  }
  return {
    markerPath,
    processRecordPath,
    delayMs,
    ignoreSigterm: ignoreSigtermValue === 'true',
  }
}

void main().catch(() => {
  process.exitCode = 1
})
