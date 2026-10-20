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
    revoked = false,
    recovery: 'absent' | 'pending' | undefined,
    failure: { code: number; output: string; stderr: string } | undefined
  const client = {
    alive: true,
    request(capability: string, request: Value): Promise<unknown> {
      if (capability === 'connector.output') return Promise.resolve(native.read(request))
      calls.push(request)
      const args = request['args'] as string[],
        mutation = args.includes('--yes')
      if (mutation && revoked) client.alive = false
      const observing = args.includes('--observe-native'),
        absentStatus =
          recovery === 'absent' &&
          args[0] === 'library' &&
          args[1] === 'status' &&
          args.length === 4
      let reply: unknown
      if (recovery && !mutation) {
        if (args[0] === 'expose')
          reply = observing
            ? {
                schema: 'skillager.native-preservation.v1',
                status: 'unavailable',
                project: workspace.root.path,
                agent: input.agent,
                scope: 'project',
                library_id: (preview['library_identity'] as Value)['library_id'],
                origin: preview['original'],
                candidates: [],
                reason_code: 'origin-unpreserved',
              }
            : { schema: 'skillager.exposures.v1', exposures: [] }
        else if (args[0] === 'import' && !args.includes('--project-mode')) {
          const standalone = structuredClone(preview.import)
          standalone.review_manifest.confirmation_token = input.token
          standalone['next_command_argv'] = (
            preview['next_command_argv'] as string[]
          ).filter(
            (arg, index, list) =>
              !['--project-mode', '--agent'].includes(arg) &&
              !['--project-mode', '--agent'].includes(list[index - 1]!),
          )
          reply = standalone
        }
      }
      return Promise.resolve(
        native.complete(
          {
            outcome: 'completed',
            receipt: `compound-${++serial}`,
            truncated: false,
            code:
              failure?.code ??
              (absentStatus || (recovery && observing)
                ? 2
                : mutation
                  ? code
                  : old
                    ? 2
                    : 0),
          },
          failure
            ? failure.output
            : absentStatus
              ? '{}'
              : old
                ? ''
                : mutation && lost
                  ? 'missing'
                  : JSON.stringify(
                      reply ??
                        (args[0] === 'import'
                          ? mutation
                            ? applied
                            : preview
                          : args[0] === 'expose'
                            ? args.includes('--remove')
                              ? removal
                              : exposures
                            : status),
                    ),
          failure?.stderr ??
            (old ? 'unrecognized arguments: --project-mode stub --agent codex' : ''),
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
    existing() {
      for (const value of [preview, applied]) {
        const importing = value['import'] as ImportPreview,
          identity = value['library_identity'] as Value
        importing.review_manifest.library.status = 'ready'
        importing.review_manifest.library.library_id = (status['library'] as Value)[
          'library_id'
        ] as string
        ;(importing['library'] as Value)['status'] = 'ready'
        identity['status'] = 'existing'
      }
      delete applied['initialization']
    },
    recover(state: 'absent' | 'pending') {
      recovery = state
      if (state === 'pending') {
        const skill = status['skill'] as Value
        skill['acceptance'] = 'pending'
        skill['accepted_hash'] = null
      }
    },
    resume() {
      recovery = undefined
      lost = false
    },
    nativeFailure(value: { code: number; output: string; stderr: string }) {
      failure = value
    },
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
