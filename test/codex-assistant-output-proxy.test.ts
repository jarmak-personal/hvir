import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer, createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CODEX_ASSISTANT_OUTPUT_PROXY_SCRIPT } from '../src/main/harness/codex-assistant-output-proxy-script'

const resources: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const dispose of resources.splice(0).reverse()) await dispose()
})

describe('Codex assistant-output routing proxy', () => {
  it('keeps non-assistant records native and assigns each agent item one owner', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hvir-codex-proxy-'))
    resources.push(() => rm(directory, { recursive: true, force: true }))
    const backendPath = join(directory, 'backend.sock')
    const frontendPath = join(directory, 'frontend.sock')
    let serverPeer: Socket | undefined
    const backendConnected = new Promise<void>((resolve) => {
      const server = createServer((socket) => {
        serverPeer = socket
        resolve()
      })
      server.listen(backendPath)
      resources.push(
        () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      )
    })
    const proxy = spawn(
      'python3',
      ['-u', '-c', CODEX_ASSISTANT_OUTPUT_PROXY_SCRIPT, frontendPath, backendPath],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    resources.push(() => stop(proxy))
    await waitUntil(async () => {
      try {
        return (await stat(frontendPath)).isSocket()
      } catch {
        return false
      }
    })
    const client = createConnection(frontendPath)
    resources.push(() => {
      client.destroy()
    })
    await backendConnected
    const native: string[] = []
    const rich: string[] = []
    client.on('data', (chunk) => native.push(chunk.toString('utf8')))
    proxy.stdout.setEncoding('utf8')
    proxy.stdout.on('data', (chunk: string) => rich.push(chunk))

    proxy.stdin.write('MODE\t1\n')
    await tick()
    const body = 'x'.repeat(9_000)
    serverPeer!.write(
      `${record(1, 'item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'commandExecution', id: 'tool-1' },
      })}\n`,
    )
    serverPeer!.write(
      `${record(1, 'item/started', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'message-1', text: '' },
      })}\n`,
    )
    serverPeer!.write(
      `${record(3, 'item/agentMessage/delta', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'message-1',
        delta: body,
      })}\n`,
    )
    await waitUntil(() => rich.join('').split('\n').filter(Boolean).length === 3)
    proxy.stdin.write('MODE\t0\n')
    serverPeer!.write(
      `${record(4, 'item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'message-1', text: body },
      })}\n`,
    )
    serverPeer!.write(
      `${record(5, 'turn/completed', {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      })}\n`,
    )
    await waitUntil(() => rich.join('').split('\n').filter(Boolean).length === 4)
    await waitUntil(() => native.join('').includes('"turn/completed"'))

    const nativeText = native.join('')
    expect(nativeText).toContain('"commandExecution"')
    expect(nativeText).toContain('"turn/completed"')
    expect(nativeText).not.toContain('"agentMessage"')
    expect(nativeText).not.toContain('"item/agentMessage/delta"')
    const richFrames = rich
      .join('')
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string
            itemId: string
            text?: string
            finalBytes?: number
          },
      )
    expect(richFrames).toEqual([
      expect.objectContaining({ kind: 'start', itemId: 'message-1' }),
      expect.objectContaining({ kind: 'delta' }),
      expect.objectContaining({ kind: 'delta' }),
      expect.objectContaining({ kind: 'end', finalBytes: 9_000 }),
    ])
    expect(
      richFrames
        .filter((frame) => frame.kind === 'delta')
        .map((frame) => frame.text)
        .join(''),
    ).toBe(body)

    native.length = 0
    rich.length = 0
    proxy.stdin.write('MODE\t1\n')
    await tick()
    serverPeer!.write(
      `${record(6, 'item/started', {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: { type: 'agentMessage', id: 'message-2', text: '' },
      })}\n`,
    )
    await waitUntil(() => rich.join('').includes('"kind":"start"'))
    proxy.stdin.write('REVOKE\n')
    await tick()
    serverPeer!.write(
      `${record(7, 'item/agentMessage/delta', {
        threadId: 'thread-1',
        turnId: 'turn-2',
        itemId: 'message-2',
        delta: 'withheld',
      })}\n`,
    )
    serverPeer!.write(
      `${record(8, 'item/completed', {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: { type: 'agentMessage', id: 'message-2', text: 'withheld' },
      })}\n`,
    )
    serverPeer!.write(
      `${record(9, 'item/started', {
        threadId: 'thread-1',
        turnId: 'turn-3',
        item: { type: 'agentMessage', id: 'message-3', text: '' },
      })}\n`,
    )
    await waitUntil(() => native.join('').includes('"message-3"'))

    expect(rich.join('').split('\n').filter(Boolean)).toHaveLength(1)
    expect(native.join('')).not.toContain('"message-2"')
    expect(native.join('')).toContain('"message-3"')
  })
})

function record(
  emittedAtMs: number,
  method: string,
  params: Record<string, unknown>,
): string {
  return JSON.stringify({ method, params, emittedAtMs })
}

async function waitUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for proxy')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  child.kill()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}
