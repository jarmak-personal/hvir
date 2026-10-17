import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  AGENT_CONTRACT,
  validateAgentRequest,
  type AgentRequest,
} from '../src/shared/agent/contract.ts'

const binary = resolve(process.argv[2] ?? ''),
  directory = await mkdtemp(join(tmpdir(), 'hvir-client-')),
  socket = join(directory, 'a.sock')
const streams = new Set<Socket>()
let check: (request: AgentRequest) => void,
  response: object | undefined,
  observed = false,
  failed = false,
  requests = 0
const server = createServer((stream) => {
  streams.add(stream)
  stream.on('close', () => streams.delete(stream))
  stream.on('error', () => undefined)
  let data = Buffer.alloc(0)
  stream.on('data', (chunk: Buffer) => {
    data = Buffer.concat([data, chunk])
    if (data.length > 256 * 1024) {
      failed = true
      stream.destroy()
      return
    }
    if (!data.includes(10)) return
    try {
      check(validateAgentRequest(JSON.parse(data.toString('utf8'))))
      observed = true
      requests++
    } catch {
      failed = true
      stream.destroy()
      return
    }
    if (response)
      stream.end(JSON.stringify({ contract: AGENT_CONTRACT, ...response }) + '\n')
    else stream.destroy()
  })
})
async function invoke(
  argv: string[],
  input = '',
  endpoint = socket,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  observed = false
  failed = false
  return new Promise((accept, reject) => {
    const child = spawn(binary, argv, {
      env: {
        ...process.env,
        HVIR_AGENT_ENDPOINT: endpoint,
        HVIR_AGENT_WORKSPACE: 'workspace:ssh:/project',
      },
    })
    let stdout = '',
      stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Native client deadline exceeded'))
    }, 10_000)
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString('utf8')
      if (stdout.length > 256 * 1024) child.kill()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString('utf8')
      if (stderr.length > 256 * 1024) child.kill()
    })
    child.on('error', () => {
      clearTimeout(timer)
      reject(new Error('Native client could not execute'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      accept({ stdout, stderr, code })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}
try {
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(socket, accept)
  })
  check = (request) => {
    if (
      request.argv[0] !== 'future-command' ||
      request.defaults.workspace !== 'workspace:ssh:/project'
    )
      throw new Error('request')
  }
  response = {
    stdout: 'native protocol 😃\n',
    stderr: 'server warning\n',
    exitStatus: 23,
  }
  const forwarded = await invoke(['future-command'])
  if (
    !observed ||
    failed ||
    forwarded.stdout !== 'native protocol 😃\n' ||
    forwarded.stderr !== 'server warning\n' ||
    forwarded.code !== 23
  )
    throw new Error('Native client changed server output/status')
  check = (request) => {
    if (request.stdin !== 'report 😃\n' || request.argv[0] !== 'report')
      throw new Error('request')
  }
  response = { stdout: 'accepted\n', stderr: '', exitStatus: 0 }
  const stdin = await invoke(['report', '--stdin'], 'report 😃\n')
  if (
    !observed ||
    failed ||
    stdin.code !== 0 ||
    stdin.stdout !== 'accepted\n' ||
    stdin.stderr
  )
    throw new Error('Native client stdin relay failed')
  check = (request) => {
    if (
      request.defaults.workspace ||
      request.argv.join(' ') !== `workspaces --instance ${socket}`
    )
      throw new Error('request')
  }
  const selected = await invoke(
    ['workspaces', '--instance', socket],
    '',
    socket + '.other',
  )
  if (!observed || failed || selected.code !== 0)
    throw new Error('Explicit endpoint retained another terminal context')
  check = () => undefined
  response = undefined
  const interrupted = await invoke(['future-command'])
  const failure = JSON.parse(interrupted.stdout) as {
    contract: string
    ok: boolean
    error: { code: string; message: string }
  }
  if (
    !observed ||
    failed ||
    interrupted.code !== 69 ||
    interrupted.stderr ||
    failure.contract !== AGENT_CONTRACT ||
    failure.ok !== false ||
    failure.error.code !== 'unavailable' ||
    !failure.error.message.includes('uncertain')
  )
    throw new Error('Interrupted request was reported as complete')
  if (requests !== 4) throw new Error('Client replayed a request')
  console.log(
    'HVIR_NATIVE_AGENT_CLIENT_PROTOCOL_OK relay/stdin/explicit-instance/uncertain-no-replay',
  )
} finally {
  for (const stream of streams) stream.destroy()
  await new Promise<void>((done) => server.close(() => done()))
  await rm(directory, { recursive: true, force: true })
}
