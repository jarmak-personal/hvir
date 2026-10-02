import type { ExtensionConnectorOutput } from '../src/shared/extensions/connectors'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { connectorFixture } from './fixtures/extension-connector'

/** Opt-in environmental evidence: public installed CLI only, isolated user data, no private DB. */
it.runIf(!!process.env['HVIR_CONNECTOR_SKILLAGER'])(
  'runs real Skillager metadata contracts through approved finite local execution',
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'hvir-connector-skillager-')),
    )
    const host = new LocalHost(),
      fixture = connectorFixture('application', 4 * 1024 * 1024, root)
    fixture.host.realpath.mockImplementation((path) => host.realpath(path))
    fixture.host.stat.mockImplementation((path) => host.stat(path))
    fixture.host.exec.mockImplementation((command, args, options) =>
      host.exec(command, args, options),
    )
    const env = {
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
      SKILLAGER_CATALOG_STATE_DIR: join(root, 'catalog'),
      SKILLAGER_STATE_DIR: join(root, 'project-state'),
      SKILLAGER_CACHE_DIR: join(root, 'skillager-cache'),
    }
    Object.assign(fixture.activation.revision.manifest.connectors![0]!, {
      environment: Object.keys(env),
    })
    try {
      await fixture.approve(process.env['HVIR_CONNECTOR_SKILLAGER'], { args: [], env })
      let invocation = 0
      async function run(args: string[]): Promise<string> {
        const caller = { ...fixture.caller, action: `pressure-${++invocation}` }
        const result = await fixture.execution.execute(caller, {
          connector: 'tool',
          host: 'local',
          args,
        })
        expect(result).toMatchObject({ outcome: 'completed', code: 0, truncated: false })
        let output = '',
          offset: number | null = 0
        while (offset !== null) {
          const page: ExtensionConnectorOutput = fixture.execution.output(caller, {
            receipt: result.receipt,
            stream: 'stdout',
            offset,
          })!
          output += page.data
          offset = page.nextOffset
        }
        fixture.execution.output(caller, { receipt: result.receipt, release: true })
        return output
      }
      expect(await run(['--version'])).toMatch(/skillager/u)
      await run(['library', 'init', '--path', join(root, 'library'), '--no-git'])
      await run(['library', 'new', 'connector-proof'])
      const inventory = JSON.parse(
        await run(['list', '--scope', 'library', '--json', '--limit', '1']),
      ) as { schema: string; skills?: unknown[] }
      expect(inventory.schema).toBe('skillager.list.v1')
      const search = JSON.parse(
        await run([
          'search',
          '--json',
          '--limit',
          '1',
          '--cursor',
          '',
          '--',
          'connector-proof',
        ]),
      ) as { schema: string }
      expect(search.schema).toMatch(/skillager.search/u)
    } finally {
      fixture.dispose()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
  180_000,
)
