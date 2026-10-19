import { connectorOutputFixture } from './connector-output'
import { buildSync } from 'esbuild'
import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'
import { expect } from 'vitest'
type Value = Record<string, unknown>
interface Module {
  prepareDelivery(
    client: unknown,
    input: Value,
    workspace: Value,
    kind?: string,
  ): Promise<Value>
  applyPreparedDelivery(client: unknown, prepared: Value): Promise<Value>
  executeDelivery(client: unknown, invocation: Value): Promise<Value>
  compactDeliveryMetadata(client: unknown, workspace: Value): Promise<void>
}
interface ViewModule {
  bindDeliveryView(document: unknown, client: unknown, ports: unknown): unknown
}
export function fixture() {
  const sandbox = {
    TextEncoder,
    Module: undefined as unknown,
    View: undefined as unknown,
  }
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
  runInNewContext(
    buildSync({
      entryPoints: ['packages/skillager-extension/src/delivery-view.mjs'],
      bundle: true,
      format: 'iife',
      globalName: 'View',
      write: false,
    }).outputFiles[0]!.text,
    sandbox,
  )
  const module = sandbox.Module as Module,
    hash = 'a'.repeat(64),
    sha256 = createHash('sha256').update('payload').digest('hex'),
    library = {
      id: '01234567-89ab-cdef-0123-456789abcdef',
      root: { hostId: 'local', path: '/library' },
      gitMode: 'disabled',
    },
    workspace = {
      id: 'remote-workspace',
      host: 'ssh:remote',
      root: { hostId: 'ssh:remote', path: '/project' },
    },
    input = {
      library,
      skillId: 'lib/skill',
      hash,
      agent: 'codex',
      mode: 'native',
      exportDirectory: '/exports/one',
    },
    files = [{ path: 'SKILL.md', mode: 0o664, size: 7, sha256 }],
    calls: { capability: string; input: Value }[] = [],
    outputs = new Map<string, unknown>()
  let domain: unknown = null,
    revision = 'revision-0',
    serial = 0,
    statusHash = hash,
    exportChange: Value = {},
    application: Value = { outcome: 'completed', operation: 'operation' },
    applyFails = false
  let records: Value[] = [],
    operations: Value[] = [],
    pending: Value = {},
    previews = 0,
    journalRevision = 0
  const native = connectorOutputFixture()
  const client = {
    alive: true,
    async request(capability: string, request: Value) {
      await Promise.resolve()
      calls.push({ capability, input: request })
      if (capability === 'connector.execute') {
        expect(request['connector']).toBe('library-cli')
        expect(request['host']).toBe('local')
        expect(request['workspace']).toBeUndefined()
        const args = request['args'] as string[],
          receipt = String(++serial)
        if (args[0] === 'library')
          outputs.set(receipt, {
            schema: 'skillager.library-status.v1',
            initialized: true,
            library: {
              library_id: library.id,
              root: library.root.path,
              registration: 'valid',
            },
            git: { mode: 'disabled' },
            skill: {
              id: input.skillId,
              acceptance: 'accepted',
              accepted_hash: statusHash,
              working_hash: statusHash,
              path: '/library/skills/skill',
              entrypoint: '/library/skills/skill/SKILL.md',
            },
          })
        else if (args[0] === 'show')
          outputs.set(receipt, {
            skill: {
              id: input.skillId,
              content_hash: statusHash,
              trust: 'reviewed',
              compatibility: { env: ['API_TOKEN'] },
              targets: {},
              activation: 'manual',
            },
          })
        else if (args[0] === 'export')
          outputs.set(receipt, {
            schema: 'skillager.export.v1',
            status: 'exported',
            id: input.skillId,
            library_id: library.id,
            agent: 'codex',
            scope: 'export',
            destination: input.exportDirectory,
            content_hash: statusHash,
            files,
            ...exportChange,
          })
        else throw new Error('Unexpected native operation')
        return native.complete(
          { outcome: 'completed', receipt, code: 0, truncated: false },
          JSON.stringify(outputs.get(receipt)),
        )
      }
      if (capability === 'connector.output') return native.read(request)
      if (capability === 'delivery.capture') {
        expect(
          calls.some(
            (call) =>
              call.capability === 'connector.output' &&
              call.input['receipt'] === request['nativeReceipt'] &&
              call.input['release'],
          ),
        ).toBe(false)
        return {
          receipt: 'capture',
          root: { hostId: 'local', path: input.exportDirectory },
        }
      }
      if (capability === 'delivery.manifest')
        return request['release']
          ? null
          : {
              entries: [
                { path: '', type: 'dir', mode: 0o755, size: 0 },
                ...files.map((file) => ({ ...file, type: 'file' })),
              ],
              nextOffset: null,
            }
      if (capability === 'delivery.status')
        return {
          entries: request['kind'] === 'operations' ? operations : records,
          nextOffset: null,
          revision: `journal-${journalRevision}`,
        }
      if (capability === 'delivery.domain') {
        if (request['write']) {
          expect(request['expected']).toBe(revision)
          if (request['journalRevision'])
            expect(request['journalRevision']).toBe(`journal-${journalRevision}`)
          domain = request['value']
          revision = `revision-${++serial}`
          return null
        }
        return { value: domain, revision }
      }
      if (capability === 'delivery.preview') {
        previews++
        pending = {
          ...request,
          operation: previews === 1 ? 'operation' : `operation-${previews}`,
        }
        return {
          receipt: 'preview',
          operation: pending['operation'],
          target: request['target'],
          parents: [
            { hostId: workspace.host, path: '/project/.agents' },
            { hostId: workspace.host, path: '/project/.agents/skills' },
          ],
          recordEffect: 'record-exact-delivery',
        }
      }
      if (capability === 'delivery.apply') {
        if (applyFails) throw new Error('Disconnected reply')
        if (application['outcome'] === 'completed') {
          const previous = records[0]
          records =
            pending['kind'] === 'remove'
              ? []
              : [
                  {
                    id: 'record',
                    operation: pending['operation'],
                    target: pending['target'],
                    sourceVersion: pending['sourceVersion'],
                    workspace: workspace.id,
                    root: workspace.root,
                  },
                ]
          if (previous)
            operations.push({
              id: pending['operation'],
              phase: 'completed',
              sourceVersion: pending['sourceVersion'] ?? previous['sourceVersion'],
              workspace: workspace.id,
              root: workspace.root,
              target: pending['target'],
              previousOperation: previous['operation'],
            })
          journalRevision++
        }
        return {
          ...application,
          operation: pending['operation'],
          ...(records[0] ? { record: records[0] } : {}),
        }
      }
      throw new Error(`Unexpected capability ${capability}`)
    },
  }
  return {
    module,
    view: sandbox.View as ViewModule,
    client,
    input,
    workspace,
    calls,
    files,
    changeExport: (value: Value) => {
      exportChange = value
    },
    advanceVersion: () => {
      statusHash = 'b'.repeat(64)
      input.hash = statusHash
    },
    changeSource: () => {
      statusHash = 'b'.repeat(64)
    },
    lostReply: (value = true) => {
      applyFails = value
    },
    result: (value: Value) => {
      application = value
    },
    domain: () => domain as { deliveries: Value[] },
    records: () => records,
    cleanup: (id: unknown) => {
      operations = operations.filter((entry) => entry['id'] !== id)
      journalRevision++
    },
  }
}
