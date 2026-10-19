import { build } from 'esbuild'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { AGENT_CONTRACT, validateAgentRequest } from '../src/shared/agent/contract'

it('relays exact server stdout, stderr and 0/64/69/75 statuses through the Node CLI without replay', async () => {
  const directory = await mkdtemp('/tmp/hvir-cli-')
  const endpointDirectory = join(directory, `hvir-agent-${process.getuid!()}`)
  const endpoint = join(endpointDirectory, '0123456789abcdef.sock')
  const cli = join(directory, 'client.cjs')
  const streams = new Set<Socket>()
  let response = { stdout: '', stderr: '', exitStatus: 0 }
  const requests: unknown[] = []
  const server = createServer((stream) => {
    streams.add(stream)
    stream.on('close', () => streams.delete(stream))
    stream.on('error', () => undefined)
    let buffered = ''
    stream.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      if (!buffered.includes('\n')) return
      requests.push(validateAgentRequest(JSON.parse(buffered)))
      stream.end(JSON.stringify({ contract: AGENT_CONTRACT, ...response }) + '\n')
    })
  })
  try {
    await build({
      entryPoints: [resolve('src/agent-cli/index.ts')],
      outfile: cli,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    })
    await mkdir(endpointDirectory, { mode: 0o700 })
    await new Promise<void>((accept, reject) => {
      server.once('error', reject)
      server.listen(endpoint, accept)
    })
    await chmod(endpoint, 0o600)
    for (const exitStatus of [0, 64, 69, 75]) {
      response = {
        stdout: `opaque result 😃 ${exitStatus}\n`,
        stderr: `server detail ${exitStatus}\n`,
        exitStatus,
      }
      const result = await new Promise<{
        stdout: string
        stderr: string
        exitStatus: number | null
      }>((accept, reject) => {
        const child = spawn(
          process.execPath,
          [cli, 'workspaces', '--instance', endpoint],
          {
            env: {
              ...process.env,
              TMPDIR: directory,
              XDG_RUNTIME_DIR: directory,
              HVIR_AGENT_ENDPOINT: endpoint,
              HVIR_AGENT_WORKSPACE: '',
              HVIR_AGENT_SESSION: '',
            },
          },
        )
        let stdout = '',
          stderr = ''
        const timer = setTimeout(() => child.kill(), 5000)
        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString('utf8')
        })
        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString('utf8')
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', (code) => {
          clearTimeout(timer)
          accept({ stdout, stderr, exitStatus: code })
        })
        child.stdin.end()
      })
      expect(result).toEqual(response)
    }
    expect(requests).toHaveLength(4)
    for (const request of requests)
      expect(request).toMatchObject({
        argv: ['workspaces', '--instance', endpoint],
        defaults: {},
        stdin: '',
      })
  } finally {
    for (const stream of streams) stream.destroy()
    if (server.listening) await new Promise<void>((done) => server.close(() => done()))
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
