import { readFileSync } from 'node:fs'
import { importModule } from './skillager-import'
import { connectorOutputFixture } from './connector-output'
import type { ImportPreview } from './skillager-import'

type Value = Record<string, unknown>
export function importPlacementFixture() {
  const read = (name: string) =>
    JSON.parse(
      readFileSync(
        `test/fixtures/skillager-management/import-placement-${name}.json`,
        'utf8',
      ),
    ) as Value
  const preview = read('preview') as Value & {
      import: ImportPreview
      confirmation_token: string
      mode: string
      agent: string
    },
    applied = read('applied'),
    status = read('library'),
    exposures = read('exposures'),
    removal = read('removal'),
    input = {
      skillId: preview.import.source.id,
      file: { hostId: 'local', path: preview.import.source.file },
      name: preview.import.destination.name,
      hash: preview.import.source_hash,
      token: preview.confirmation_token,
      agent: preview.agent,
      mode: preview.mode,
    },
    workspace = {
      id: 'compound-project',
      host: 'local',
      root: { hostId: 'local', path: preview.import.project },
    }
  const module = importModule<{
    executeManagement(client: unknown, invocation: unknown): Promise<Value>
  }>('management-operation')
  const native = connectorOutputFixture(),
    calls: Value[] = []
  let serial = 0,
    code = 0,
    lost = false,
    old = false,
    revoked = false
  const client = {
    alive: true,
    request(capability: string, request: Value): Promise<unknown> {
      if (capability === 'connector.output') return Promise.resolve(native.read(request))
      calls.push(request)
      const args = request['args'] as string[],
        mutation = args.includes('--yes')
      if (mutation && revoked) client.alive = false
      return Promise.resolve(
        native.complete(
          {
            outcome: 'completed',
            receipt: `compound-${++serial}`,
            truncated: false,
            code: mutation ? code : old ? 2 : 0,
          },
          old
            ? ''
            : mutation && lost
              ? 'missing'
              : JSON.stringify(
                  args[0] === 'import'
                    ? mutation
                      ? applied
                      : preview
                    : args[0] === 'expose'
                      ? args.includes('--remove')
                        ? removal
                        : exposures
                      : status,
                ),
          old ? 'unrecognized arguments: --project-mode stub --agent codex' : '',
        ),
      )
    },
  }
  const invoke = (
    action = 'save-and-use-copy',
    value: unknown = input,
    caller = 'guest',
    context: unknown = { workspace },
  ) =>
    module.executeManagement(client, {
      id: `compound-action-${++serial}`,
      action,
      input: value,
      caller,
      authorization: 'human',
      context,
    })
  return {
    preview,
    applied,
    status,
    removal,
    input,
    workspace,
    client,
    calls,
    invoke,
    fail: (next = 2) => {
      code = next
    },
    lose: () => {
      lost = true
    },
    older: () => {
      old = true
    },
    revoke: () => {
      revoked = true
    },
  }
}
