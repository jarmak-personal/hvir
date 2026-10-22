import { mkdtemp, realpath, rm, writeFile, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectorFixture } from './fixtures/extension-connector'
import { LocalHost } from '../src/main/project-host/local-host'

describe('connector execution through real local process mechanics', () => {
  let root: string, host: LocalHost, fixture: ReturnType<typeof connectorFixture>
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-connector-local-')))
    host = new LocalHost()
    fixture = connectorFixture('application', 4 * 1024 * 1024, root)
    fixture.host.realpath.mockImplementation((path) => host.realpath(path))
    fixture.host.stat.mockImplementation(async (path) => {
      const stat = await host.stat(path)
      return { ...stat, type: stat.type }
    })
    fixture.finiteExec.tryExec.mockImplementation((command, args, options) =>
      host.finiteExec.tryExec(command, args, options)!,
    )
  })
  afterEach(async () => {
    fixture.dispose()
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })
  it('inspects real symlink updates and executes the newly pinned target only with session trust', async () => {
    const launcher = join(root, 'tool'),
      a = join(root, 'A'),
      b = join(root, 'B')
    await writeFile(a, '#!/bin/sh\nprintf A', { mode: 0o755 })
    await writeFile(b, '#!/bin/sh\nprintf B', { mode: 0o755 })
    await symlink(a, launcher)
    const approval = await fixture.approve(launcher, { args: [], env: {} })
    await unlink(launcher)
    await symlink(b, launcher)
    expect(await fixture.approvals.inspectStatus(fixture.activation)).toMatchObject([
      { reason: 'executable-changed' },
    ])
    expect(await fixture.execution.execute(fixture.caller, fixture.input)).toMatchObject({
      outcome: 'not-started',
      reason: 'executable-changed',
    })
    const prepared = await fixture.approvals.prepare(
      approval,
      () => undefined,
      undefined,
      true,
    )
    await fixture.approvals.approve(prepared.token)
    const result = await fixture.execution.execute(fixture.caller, fixture.input)
    expect(result.outcome).toBe('completed')
    expect(fixture.finiteExec.tryExec.mock.calls[0]?.[0]).toBe(b)
    expect(
      fixture.execution.output(fixture.caller, {
        receipt: result.receipt,
        stream: 'stdout',
        offset: 0,
      })?.data,
    ).toBe('B')
    fixture.approvals.endSession(approval)
    expect(await fixture.execution.execute(fixture.caller, fixture.input)).toMatchObject({
      reason: 'executable-changed',
    })
  })
  it('passes literal argv without shell interpretation and uses application context without a project', async () => {
    await fixture.approve(process.execPath, { args: [], env: {} })
    const literal = '$(printf escaped); space " quote'
    const result = await fixture.execution.execute(fixture.caller, {
      connector: 'tool',
      host: 'local',
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({cwd:process.cwd(),arg:process.argv[1]}))',
        literal,
      ],
    })
    expect(result.outcome).toBe('completed')
    const page = fixture.execution.output(fixture.caller, {
      receipt: result.receipt,
      stream: 'stdout',
      offset: 0,
    })!
    expect(JSON.parse(page.data)).toEqual({ cwd: root, arg: literal })
  })
  it('retains a bounded real-process prefix and discloses termination from output pressure', async () => {
    const declaration = fixture.activation.revision.manifest.connectors![0]!
    Object.assign(declaration, { outputBytes: 4096 })
    await fixture.approve(process.execPath, { args: [], env: {} })
    const result = await fixture.execution.execute(fixture.caller, {
      connector: 'tool',
      host: 'local',
      args: ['-e', 'process.stdout.write("x".repeat(65536)); setInterval(()=>{},1000)'],
    })
    expect(result).toMatchObject({
      outcome: 'interrupted-uncertain',
      truncated: true,
      reason: 'output-limit',
    })
    expect(result.stdoutBytes + result.stderrBytes).toBeLessThanOrEqual(4096)
    expect(
      fixture.execution.output(fixture.caller, {
        receipt: result.receipt,
        stream: 'stdout',
        offset: 0,
      })!.data,
    ).toBe('x'.repeat(result.stdoutBytes))
  })
})
