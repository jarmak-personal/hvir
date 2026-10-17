import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { deliveryFixture } from './fixtures/extension-delivery'
import { ExtensionConnectorApprovalOwner } from '../src/main/extensions/connector-approval'
import { ExtensionConnectorExecutionOwner } from '../src/main/extensions/connector-execution'
import { requestGuestDelivery } from '../src/main/extensions/guest-delivery'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { localPath } from '../src/shared/host-path'
import type { ExtensionInvocation } from '../src/shared/extensions/contract'
type Value = Record<string, unknown>
interface Module {
  executeDelivery(client: unknown, invocation: Value): Promise<Value>
}
/** Public installed producer + actual connector/consumer/core filesystem ports; the qualified sink is simulated, not real SSH evidence. */
it.runIf(!!process.env['HVIR_DELIVERY_SKILLAGER'])(
  'delivers public approved Full Add, Update and Remove through ordinary extension actions and survives owner restart',
  async () => {
    const f = await deliveryFixture(),
      executable = process.env['HVIR_DELIVERY_SKILLAGER']!,
      catalog = join(f.directory, 'catalog'),
      state = join(f.directory, 'skillager-state'),
      cliArgs = ['--catalog-state-dir', catalog, '--state-dir', state],
      evidence: Value[] = []
    const manifest = validateExtensionManifest(
      JSON.parse(
        await fs.readFile('packages/skillager-extension/hvir-extension.json', 'utf8'),
      ),
    ).manifest
    Object.assign(f.activation.revision, { manifest })
    let approvalsState: unknown = []
    const approvals = new ExtensionConnectorApprovalOwner(
      {
        local: f.local,
        listHosts: () => [
          {
            hostId: f.local.hostId,
            label: 'Local',
            kind: 'local',
            connectionState: 'connected',
            watchTier: 'native',
          },
        ],
        hostById: (id) => (id === 'local' ? f.local : undefined),
        materializeHost: (id) => {
          if (id !== 'local') throw new Error('No remote CLI')
          return Promise.resolve(f.local)
        },
        onHostStateChange: () => () => {},
      },
      {
        active: f.active,
        assertWritable: f.authority.assertWritable,
        readConnectorApprovals: () => Promise.resolve(approvalsState),
        saveConnectorApprovals: (value, current) => {
          current()
          approvalsState = value
          return Promise.resolve()
        },
      },
      () => {},
    )
    const execution = new ExtensionConnectorExecutionOwner(
      approvals,
      localPath(f.directory),
      f.authority.assertWritable,
    )
    f.native.assertCaptureReceipt.mockImplementation((caller, receipt) =>
      execution.assertCaptureReceipt(caller, receipt),
    )
    const sandbox = { TextEncoder, Module: undefined as unknown }
    runInNewContext(
      buildSync({
        entryPoints: ['packages/skillager-extension/src/delivery-operation.mjs'],
        bundle: true,
        format: 'iife',
        globalName: 'Module',
        write: false,
      }).outputFiles[0]!.text,
      sandbox,
    )
    const module = sandbox.Module as Module
    let succeeded = false
    let owner = f.owner,
      caller = f.caller,
      invocation: ExtensionInvocation
    const client = {
      alive: true,
      async request(capability: string, input: Value): Promise<unknown> {
        if (capability === 'connector.execute') {
          if (
            input['connector'] !== 'library-cli' ||
            input['host'] !== 'local' ||
            input['workspace']
          )
            throw new Error('Remote tool execution is unsupported')
          return execution.execute(caller, input)
        }
        if (capability === 'connector.output') return execution.output(caller, input)
        return requestGuestDelivery(
          capability,
          input,
          caller,
          owner,
          caller.admitted,
          caller.authorize,
          false,
          manifest,
          invocation,
        )
      },
    }
    async function cli(args: string[]) {
      const result = await f.local.exec(executable, [...cliArgs, ...args], {
        cwd: localPath(f.directory),
        maxBuffer: 256 * 1024,
      })
      evidence.push({ args, result })
      expect(result.code, result.stderr).toBe(0)
      return JSON.parse(result.stdout) as Value
    }
    const workspace = {
        id: 'workspace',
        name: 'Workspace',
        host: f.root.hostId,
        root: f.root,
      },
      libraryRoot = join(f.directory, 'library'),
      skillId = 'lib/delivery-proof',
      skillRoot = join(libraryRoot, 'skills', 'delivery-proof')
    async function accept() {
      const preview = await cli([
        'library',
        'accept',
        skillId,
        '--review-manifest',
        '--json',
      ])
      expect(preview['requires_override']).toBe(false)
      const argv = preview['next_command_argv'] as string[]
      expect(argv.slice(0, 4)).toEqual(['skillager', 'library', 'accept', skillId])
      expect(argv).toContain('--review-manifest')
      expect(argv).not.toContain('--override-lint')
      await cli(argv.slice(1))
      const status = await cli(['library', 'status', skillId, '--json'])
      return {
        library: {
          id: (status['library'] as Value)['library_id'],
          root: { hostId: 'local', path: libraryRoot },
          gitMode: 'disabled',
        },
        hash: (status['skill'] as Value)['accepted_hash'],
      }
    }
    async function action(action: string, input: Value) {
      const id = `native-action-${evidence.length}`
      caller = { ...f.caller, action: id }
      invocation = {
        id,
        action,
        input,
        context: { surface: 'viewer', visible: true, workspace },
        caller: 'agent',
        authorization: 'standing',
      }
      const result = await module.executeDelivery(client, invocation as unknown as Value)
      evidence.push({ action, input, result })
      expect(result['outcome']).toBe('completed')
      return result
    }
    try {
      for (const input of [
        {
          installationId: f.activation.installationId,
          source: 'delivery-source',
          root: f.exports,
        },
        {
          installationId: f.activation.installationId,
          source: 'delivery-target',
          workspaceId: 'workspace',
        },
      ])
        await f.approvals.approve((await f.approvals.prepare(input, () => {})).token)
      await approvals.start()
      await approvals.approve(
        (
          await approvals.prepare(
            {
              installationId: f.activation.installationId,
              connector: 'library-cli',
              host: 'local',
              executable,
              configuration: { args: cliArgs, env: {} },
            },
            () => {},
          )
        ).token,
      )
      await cli(['library', 'init', '--path', libraryRoot, '--no-git', '--json'])
      await cli(['library', 'new', 'delivery-proof', '--json'])
      await fs.writeFile(
        join(skillRoot, 'SKILL.md'),
        '---\nname: delivery-proof\ndescription: Harmless file delivery proof.\n---\n\n# Delivery proof\n\nRead the fixture.\n',
      )
      await fs.chmod(join(skillRoot, 'SKILL.md'), 0o664)
      await fs.mkdir(join(skillRoot, 'support'))
      await fs.writeFile(
        join(skillRoot, 'support', 'binary.dat'),
        Buffer.from([0, 255, 7, 128]),
      )
      const first = await accept(),
        input = {
          ...first,
          skillId,
          agent: 'codex',
          mode: 'native',
          exportDirectory: join(f.exports.path, 'add'),
        },
        added = await action('add-copy', input),
        target = (added['record'] as Value)['target'] as { path: string }
      expect(await fs.readFile(join(target.path, 'support', 'binary.dat'))).toEqual(
        Buffer.from([0, 255, 7, 128]),
      )
      expect((await fs.stat(join(target.path, 'SKILL.md'))).mode & 0o777).toBe(0o664)
      await owner.dispose()
      owner = await f.make()
      expect(owner.status(caller, { offset: 0 })).toMatchObject({
        entries: [{ operation: added['operation'] }],
      })
      await fs.appendFile(join(skillRoot, 'SKILL.md'), '\nNew approved version.\n')
      const next = await accept(),
        record = added['record'] as Value,
        update = {
          ...next,
          skillId,
          agent: 'codex',
          mode: 'native',
          exportDirectory: join(f.exports.path, 'update'),
          target,
          record: record['id'],
        }
      // Host qualification is explicit in both standing and destructive-confirmed action inputs.
      update.target = record['target'] as { path: string }
      const updated = await action('change-exposure', {
        library: next.library,
        agent: 'codex',
        request: JSON.stringify(update),
      })
      expect(
        await fs.readFile(
          join((updated['preserved'] as { path: string }).path, 'SKILL.md'),
          'utf8',
        ),
      ).not.toContain('New approved version')
      const removed = await action('remove-copy', {
        ...next,
        skillId,
        agent: 'codex',
        mode: 'native',
        record: record['id'],
        target: record['target'],
      })
      await expect(fs.stat(target.path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(
        await fs.readFile(
          join((removed['preserved'] as { path: string }).path, 'SKILL.md'),
          'utf8',
        ),
      ).toContain('New approved version')
      expect(f.native.assertCaptureReceipt).toHaveBeenCalledTimes(2)
      expect(
        ((await owner.domain(caller, {})) as { value: { deliveries: unknown[] } }).value
          .deliveries,
      ).toHaveLength(3)
      const proof = {
        qualifier:
          'Actual installed local CLI and public extension/core chain. Qualified SSH port uses local filesystem mechanics; no real SSH host or loaded-agent claim.',
        executable,
        cliVersion: await f.local.exec(executable, ['--version']),
        evidence,
        journal: f.persisted(),
      }
      succeeded = true
      if (process.env['HVIR_DELIVERY_EVIDENCE_DIR'])
        await fs.writeFile(
          join(
            process.env['HVIR_DELIVERY_EVIDENCE_DIR'],
            `public-delivery-proof-${Date.now()}.json`,
          ),
          JSON.stringify(proof, null, 2),
        )
    } finally {
      execution.dispose()
      approvals.dispose()
      if (owner !== f.owner) await owner.dispose()
      if (!succeeded && process.env['HVIR_DELIVERY_EVIDENCE_DIR']) {
        await fs.writeFile(
          join(
            process.env['HVIR_DELIVERY_EVIDENCE_DIR'],
            `failed-public-delivery-proof-${Date.now()}.json`,
          ),
          JSON.stringify(
            {
              executable,
              fixture: f.directory,
              qualifier:
                'Installed local CLI + simulated SSH-qualified filesystem port. Failed fixture retained.',
              evidence,
              journal: f.persisted(),
            },
            null,
            2,
          ),
        )
        await f.owner.dispose()
        f.approvals.dispose()
        await f.local.dispose()
      } else await f.dispose()
    }
  },
  180_000,
)
