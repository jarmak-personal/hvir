import inventoryFixture from './skillager-project-import/inventory.json'
import previewFixture from './skillager-project-import/preview.json'
import resultFixture from './skillager-project-import/apply.json'
import stateFixture from './skillager-project-import/status.json'
import afterFixture from './skillager-project-import/inventory-after.json'
import { importModule } from './skillager-import'
import { connectorOutputFixture } from './connector-output'

type Value = Record<string, unknown>
export function projectImportFixture() {
  const preview = structuredClone(previewFixture),
    inventory = structuredClone(inventoryFixture),
    result = structuredClone(resultFixture),
    state = structuredClone(stateFixture),
    after = structuredClone(afterFixture)
  const workspace = {
      id: 'project-import-workspace',
      host: 'local',
      root: { hostId: 'local', path: preview.project_root },
    },
    input = {
      selection: JSON.stringify(preview.selection),
      token: preview.confirmation_token,
    }
  return { preview, inventory, result, state, after, workspace, input }
}
export function projectImportOperationFixture() {
  const data = projectImportFixture(),
    module = importModule<{
      executeManagement(client: unknown, invocation: unknown): Promise<Value>
    }>('management-operation'),
    native = connectorOutputFixture(),
    calls: Value[] = []
  let serial = 0,
    code = 0,
    invalid = false,
    revoke = false,
    notStarted = false,
    reply: unknown = data.result,
    preview: unknown = data.preview
  const client = {
    alive: true,
    request(capability: string, input: Value): Promise<unknown> {
      if (capability === 'connector.output') return Promise.resolve(native.read(input))
      calls.push(input)
      const args = input['args'] as string[],
        mutation = args.includes('--yes')
      if (mutation && notStarted)
        return Promise.resolve({ outcome: 'not-started', reason: 'revoked' })
      if (mutation && revoke) client.alive = false
      return Promise.resolve(
        native.complete(
          {
            outcome: 'completed',
            code: mutation ? code : 0,
            receipt: `receipt-${++serial}`,
            truncated: false,
          },
          mutation && invalid
            ? 'lost completion'
            : JSON.stringify(
                mutation ? reply : args.includes('--status') ? data.state : preview,
              ),
        ),
      )
    },
  }
  const invoke = (
    action = 'save-project-skills',
    input: unknown = data.input,
    caller = 'guest',
    context: unknown = { workspace: data.workspace },
  ) =>
    module.executeManagement(client, {
      id: `project-import-${++serial}`,
      action,
      input,
      caller,
      authorization: 'human',
      context,
    })
  return {
    ...data,
    calls,
    client,
    invoke,
    reply(value: unknown, exit = 2) {
      reply = value
      code = exit
    },
    preflight(value: unknown) {
      preview = value
    },
    lose() {
      invalid = true
    },
    revoke() {
      revoke = true
    },
    notStarted() {
      notStarted = true
    },
  }
}
