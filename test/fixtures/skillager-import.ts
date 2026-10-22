import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { buildSync } from 'esbuild'
import { connectorOutputFixture } from './connector-output'

type Value = Record<string, unknown>
export interface ImportPreview {
  schema: string
  status: string
  blocked: boolean
  requires_override: boolean
  project: string
  source_hash: string
  next_command_argv: string[]
  source: {
    id: string
    path: string
    file: string
    content_hash: string
    type: string
    collection: string | null
    package: string | null
    version: string | null
    editable: boolean
  }
  destination: { id: string; name: string; path: string; exists: boolean }
  library: { root: string; status: string; git_mode: string }
  review_manifest: {
    schema: string
    source_id: string
    source_root: string
    source_file: string
    source_hash: string
    working_hash: string
    confirmation_token: string
    destination_id: string
    destination_path: string
    source_provenance: Value
    library: { library_id: string | null; root: string; status: string; git_mode: string }
    files: Array<{ path: string; size: number; sha256: string; executable: boolean }>
    file_count: number
    total_bytes: number
  }
}
/** Unedited public CLI previews captured from the bound import implementation. */
export function publicImportCases(): Array<{ case: string; preview: ImportPreview }> {
  return (
    JSON.parse(
      readFileSync(
        'test/fixtures/skillager-management/import-public-identities.json',
        'utf8',
      ),
    ) as { cases: Array<{ case: string; preview: ImportPreview }> }
  ).cases
}
export function importContractFixture(publicPreview?: ImportPreview) {
  const read = (name: string) =>
    JSON.parse(
      readFileSync(`test/fixtures/skillager-management/import-${name}.json`, 'utf8'),
    ) as unknown
  const preview = publicPreview ?? (read('preview') as ImportPreview)
  const result = read('imported') as {
    schema: string
    status: string
    source: Value
    destination: Value
    approval: Value
    copied_file_count: number
    library?: unknown
  }
  const status = read('status') as {
    library: { library_id: string; root: string }
    git: { mode: string }
    skill: {
      acceptance: string
      working_hash: string
      accepted_hash: string
      path: string
    }
  }
  const workspace = {
    id: 'owned-workspace',
    host: 'local',
    root: { hostId: 'local', path: preview.project },
  }
  const input = {
    skillId: preview.source.id,
    file: { hostId: 'local', path: preview.source.file },
    name: preview.destination.name,
    hash: preview.source_hash,
    token: preview.review_manifest.confirmation_token,
  }
  return { preview, result, status, workspace, input }
}
export function importModule<T>(name: string): T {
  const bundle = buildSync({
    entryPoints: [`packages/skillager-extension/src/${name}.mjs`],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { TextEncoder, crypto: webcrypto, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  return sandbox.Module as T
}
export function importOperationFixture() {
  const data = importContractFixture()
  const module = importModule<{
    executeManagement(client: unknown, invocation: unknown): Promise<Value>
  }>('management-operation')
  const native = connectorOutputFixture(),
    calls: Value[] = []
  let serial = 0,
    applyCode = 0,
    invalidOutput = false,
    revoke = false,
    selectedStatusMissing = false,
    registration: unknown
  const client = {
    alive: true,
    request(capability: string, input: Value) {
      if (capability === 'connector.output') return Promise.resolve(native.read(input))
      calls.push(input)
      const args = input['args'] as string[],
        mutation = args.includes('--yes'),
        missing = selectedStatusMissing && args[0] === 'library' && args[2] !== '--json'
      if (mutation && revoke) client.alive = false
      return Promise.resolve(
        native.complete(
          {
            outcome: 'completed',
            code: mutation ? applyCode : missing ? 2 : 0,
            receipt: `receipt-${++serial}`,
            truncated: false,
          },
          mutation && invalidOutput
            ? 'lost completion'
            : JSON.stringify(
                args[0] === 'import'
                  ? mutation
                    ? data.result
                    : data.preview
                  : registration !== undefined && args[2] === '--json'
                    ? registration
                    : data.status,
              ),
          missing
            ? 'Selected status unavailable'
            : mutation && applyCode
              ? 'Git failed; copied content may remain pending'
              : '',
        ),
      )
    },
  }
  const invoke = (
    action = 'save-and-accept',
    input: unknown = data.input,
    caller = 'guest',
    context: Value = { workspace: data.workspace },
  ) =>
    module.executeManagement(client, {
      id: `action-${++serial}`,
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
    missing: () => {
      selectedStatusMissing = true
    },
    registration: (value: unknown) => {
      registration = value
    },
    fail: () => {
      applyCode = 2
    },
    lose: () => {
      invalidOutput = true
    },
    revoke: () => {
      revoke = true
    },
  }
}
