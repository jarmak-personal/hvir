import { mkdtemp, realpath, rm } from 'node:fs/promises'
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
    fixture.host.exec.mockImplementation((command, args, options) =>
      host.exec(command, args, options),
    )
  })
  afterEach(async () => {
    fixture.dispose()
    await host.dispose()
    await rm(root, { recursive: true, force: true })
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
