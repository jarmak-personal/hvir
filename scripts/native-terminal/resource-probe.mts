import assert from 'node:assert/strict'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Endpoint, Receipt } from '../../packages/native-terminal/resource'

/* Standalone, reproducible synthetic resource mechanics; never GPU qualification.
 * Importing this module neither loads the addon nor starts a proof. */
async function run(helper: string): Promise<void> {
  const { default: edge } = await import('../../packages/native-terminal/resource.js')
  const execute = promisify(execFile)
  const directory = await mkdtemp(join(tmpdir(), 'hvir-resource-'))
  const prefix = `org.hvir.resource.probe.${process.pid}.${randomUUID()}`
  const endpoints = new Set<Endpoint>()
  const receipts = new Set<Receipt>()
  const children = new Set<ChildProcess>()
  let nextAddress = 0
  let checks = 0
  const address = (): string =>
    process.platform === 'darwin'
      ? `${prefix}.${nextAddress++}`
      : join(directory, `${nextAddress++}.sock`)
  const create = async (target: string): Promise<Endpoint> => {
    const endpoint = await edge.createEndpoint(target)
    endpoints.add(endpoint)
    return endpoint
  }
  const close = async (endpoint: Endpoint): Promise<void> => {
    await edge.closeEndpoint(endpoint)
    endpoints.delete(endpoint)
  }
  const sender = async (target: string, ticket: string, mode = 'normal') => {
    const child = spawn(helper, ['--send', target, String(process.pid), ticket, mode], {
      stdio: 'ignore',
    })
    children.add(child)
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
    const finished = new Promise<number | null>((accept, reject) => {
      child.once('error', reject)
      child.once('exit', (code) => {
        clearTimeout(timeout)
        children.delete(child)
        accept(code)
      })
    })
    // Observe failure immediately even if spawn readiness itself rejects first.
    void finished.catch(() => undefined)
    await once(child, 'spawn')
    assert.ok(child.pid)
    return { pid: child.pid, finished }
  }
  try {
    const counts = await execute(helper, ['--counts'], {
      timeout: 30_000,
      maxBuffer: 4096,
    })
    const counted = JSON.parse(counts.stdout) as {
      resourceMechanics: string
      transfers: number
      fdCountChecked: boolean
      machRightsChecked: boolean
      synthetic: boolean
      hardwareGpuQualified: boolean
    }
    assert.equal(counted.resourceMechanics, 'passed')
    assert.equal(counted.transfers, 23)
    assert.equal(counted.fdCountChecked, true)
    assert.equal(counted.machRightsChecked, process.platform === 'darwin')
    assert.equal(counted.synthetic, true)
    assert.equal(counted.hardwareGpuQualified, false)
    checks += 6

    const target = address()
    const endpoint = await create(target)
    const child = await sender(target, 'receipt-proof')
    const receipt = await edge.receive(endpoint, child.pid, 'receipt-proof', 2000)
    receipts.add(receipt)
    assert.equal(receipt.ticket, 'receipt-proof')
    assert.equal(receipt.kind, process.platform === 'darwin' ? 1 : 2)
    assert.equal(receipt.width, 4)
    assert.equal(receipt.height, 4)
    assert.equal(receipt.premultiplied, true)
    assert.equal(receipt.modifier, 0n)
    assert.equal(await child.finished, 0)
    checks += 7

    const forwarded = edge.receive(endpoint, process.pid, 'forwarded-receipt', 2000)
    void forwarded.catch(() => undefined)
    await edge.sendFrame(target, process.pid, 'forwarded-receipt', receipt)
    const second = await forwarded
    receipts.add(second)
    assert.equal(second.width, 4)
    assert.equal(second.kind, receipt.kind)
    edge.release(second)
    receipts.delete(second)
    checks += 2

    // Snapshot fields cannot replace the C record used by physical release.
    receipt.surface?.fill(0)
    for (const plane of receipt.planes) plane.fd = -1
    receipt.kind = 99
    edge.release(receipt)
    edge.release(receipt)
    receipts.delete(receipt)
    assert.throws(
      () => edge.sendFrame(target, process.pid, 'released', receipt),
      /resource-send-arguments/,
    )
    checks += 1
    await close(endpoint)

    for (const mode of ['pid', 'ticket', 'wrong-receiver'] as const) {
      const selected = address()
      const owner = await create(selected)
      const source = await sender(
        selected,
        'sent-ticket',
        mode === 'wrong-receiver' ? mode : 'normal',
      )
      await assert.rejects(
        edge.receive(
          owner,
          source.pid + Number(mode === 'pid'),
          mode === 'ticket' ? 'other-ticket' : 'sent-ticket',
          2000,
        ),
        mode === 'wrong-receiver'
          ? /resource-(timeout|peer-closed|message-rejected)/
          : /resource-(peer|message)-rejected/,
      )
      const status = await source.finished
      // Linux verifies server identity before send, but kernel acceptance is not
      // an acknowledgement that the receiver accepted sender identity/ticket.
      if (process.platform === 'linux' && mode !== 'wrong-receiver')
        assert.ok(status === 0 || status === 71)
      else assert.equal(status, 71)
      await close(owner)
      checks += 2
    }

    if (process.platform === 'linux') {
      // A bad ancillary payload must close every receiver-created FD, including
      // the prefix delivered before MSG_CTRUNC. Child stdio allocates no pipes.
      const before = (await readdir('/proc/self/fd')).length
      for (const mode of ['malformed-count', 'extra-rights', 'truncated']) {
        const selected = address()
        const owner = await create(selected)
        const source = await sender(selected, 'malformed-rights', mode)
        await assert.rejects(
          edge.receive(owner, source.pid, 'malformed-rights', 2000),
          /resource-message-rejected/,
        )
        assert.equal(await source.finished, 0)
        await close(owner)
        checks += 2
      }
      assert.equal((await readdir('/proc/self/fd')).length, before)
      checks++
    }

    const waiting: Endpoint[] = []
    for (let i = 0; i < 9; i++) waiting.push(await create(address()))
    const rejected = waiting
      .slice(0, 8)
      .map((owner) =>
        assert.rejects(
          edge.receive(owner, process.pid, 'pending', 5000),
          /endpoint-closed/,
        ),
      )
    const overflow = waiting[8]
    const closed = waiting[0]
    assert.ok(overflow && closed)
    assert.throws(
      () => edge.receive(overflow, process.pid, 'too-many', 5000),
      /resource-job-bound/,
    )
    const closing = waiting.map((owner, index) => {
      const first = edge.closeEndpoint(owner)
      const duplicate = edge.closeEndpoint(owner)
      if (index < 8) assert.strictEqual(first, duplicate)
      return Promise.all([first, duplicate]).then(() => endpoints.delete(owner))
    })
    await Promise.all([...rejected, ...closing])
    assert.throws(() => edge.receive(closed, process.pid, 'closed', 10), /closed/)
    checks += 10

    for (let i = 0; i < 20; i++) {
      const owner = await create(address())
      await close(owner)
    }
    const capacity: Endpoint[] = []
    for (let i = 0; i < 16; i++) capacity.push(await create(address()))
    assert.throws(() => edge.createEndpoint(address()), /resource-endpoint-bound/)
    await Promise.all(capacity.map(close))
    checks++

    console.log(
      JSON.stringify({
        schema: 1,
        resourceNodeApi: 'passed',
        platform: process.platform,
        checks,
        workerJobsBound: 8,
        endpointsBound: 16,
        repeatedTransfers: counted.transfers,
        fdCountChecked: true,
        machRightsChecked: counted.machRightsChecked,
        malformedAncillaryChecked: process.platform === 'linux',
        synthetic: true,
        hardwareGpuQualified: false,
      }),
    )
  } finally {
    for (const receipt of receipts) edge.release(receipt)
    for (const child of children) child.kill('SIGKILL')
    await Promise.allSettled(
      [...endpoints].map((endpoint) => edge.closeEndpoint(endpoint)),
    )
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const helper = process.argv[2]
  if (process.argv.length !== 3 || !helper)
    throw new Error('Usage: resource-probe.mts HELPER_PATH')
  await run(resolve(helper))
}
