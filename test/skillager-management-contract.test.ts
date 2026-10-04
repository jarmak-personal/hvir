import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'

interface PreviewResult {
  preview: {
    source: {
      id: string
      content_hash: string
      root: string
      source: { library_id: string; library_root: string }
      compatibility: unknown
    }
    target: string
    target_state_hash: string | null
    file_effects: Array<{ path: string; action: string; before: unknown; after: unknown }>
    confirmation_token: string
  }
  agent: string
  mode: string
  status: string
  exposure_id: string
  next_command_argv: string[]
}
interface Contract {
  exposurePreview(
    value: unknown,
    request: unknown,
    createOnly?: boolean,
  ): { token: string; effects: unknown[] }
  removalPreview(value: unknown, request: unknown): { token: string }
}
function load<T>(source: string): T {
  const bundle = buildSync({
    entryPoints: [`packages/skillager-extension/src/${source}.mjs`],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const context = { TextEncoder, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, context)
  return context.Module as T
}
const contract = load<Contract>('management-contract')
function fixture(name = 'codex-mode-initial-preview') {
  const data = JSON.parse(
    readFileSync(`test/fixtures/skillager-management/${name}.json`, 'utf8'),
  ) as PreviewResult[]
  const result = data[0]!,
    source = result.preview.source
  const request = {
    workspace: {
      id: 'main-issued-workspace',
      host: 'local',
      root: { hostId: 'local', path: `/owned-fixture/mode-change-${result.agent}` },
    },
    library: {
      id: source.source.library_id,
      root: { hostId: 'local', path: source.source.library_root },
    },
    source: {
      id: source.id,
      hash: source.content_hash,
      root: { hostId: 'local', path: source.root },
    },
    agent: result.agent,
    mode: result.mode,
  }
  return { data, result, request }
}

it.each(['codex-mode-initial-preview', 'claude-mode-initial-preview'])(
  'admits complete public create-only %s without executing returned argv',
  (name) => {
    const f = fixture(name)
    f.result.next_command_argv = ['evil-tool', '--force']
    expect(contract.exposurePreview(f.data, f.request, true)).toMatchObject({
      token: f.result.preview.confirmation_token,
      effects: f.result.preview.file_effects,
    })
  },
)
it('preserves CLI eligibility for advisory assumptions, warnings, same-agent exclusivity and another-agent exclusion', () => {
  const f = fixture()
  f.result.preview.source.compatibility = {
    assumptions: { parallel_subagents: { required: true } },
    warnings: { any: 'assumes_shell' },
    exclusive_to: 'codex',
    incompatible_with: ['claude'],
  }
  expect(contract.exposurePreview(f.data, f.request, true).token).toBe(
    f.result.preview.confirmation_token,
  )
  f.result.status = 'skipped' // Public CLI's negative-only compatibility owner refused the request.
  expect(() => contract.exposurePreview(f.data, f.request, true)).toThrow(/preview/)
})
it('refuses a protected skipped exposure without requiring a nonexistent preview', () => {
  const f = fixture('codex-exact-mode-update-preview')
  const { preview: _preview, ...result } = f.result
  expect(() =>
    contract.exposurePreview(
      [{ ...result, status: 'skipped', reason: 'target has local edits' }],
      f.request,
    ),
  ).toThrow(/preserve the existing target and observe/)
})
it('binds accepted version, local host/project and complete create-only effects before direct Add', () => {
  const f = fixture()
  expect(() =>
    contract.exposurePreview(
      f.data,
      { ...f.request, source: { ...f.request.source, hash: 'a'.repeat(64) } },
      true,
    ),
  ).toThrow(/version/)
  expect(() =>
    contract.exposurePreview(
      f.data,
      { ...f.request, workspace: { ...f.request.workspace, host: 'ssh' } },
      true,
    ),
  ).toThrow(/local/)
  f.result.preview.target_state_hash = 'b'.repeat(64)
  expect(() => contract.exposurePreview(f.data, f.request, true)).toThrow(/absent/)
  f.result.preview.target_state_hash = null
  f.result.preview.file_effects[0]!.path = '../outside'
  expect(() => contract.exposurePreview(f.data, f.request, true)).toThrow(/paths/)
})
it('binds selected managed identity for replacement while keeping direct Add create-only', () => {
  const f = fixture('codex-exact-mode-update-preview')
  expect(
    contract.exposurePreview(f.data, { ...f.request, exposureId: f.result.exposure_id })
      .effects.length,
  ).toBeGreaterThan(0)
  expect(() =>
    contract.exposurePreview(f.data, { ...f.request, exposureId: 'different' }),
  ).toThrow(/managed copy/)
  expect(() => contract.exposurePreview(f.data, f.request, true)).toThrow(/absent/)
})
it('allows exact managed Remove independently of canonical acceptance and refuses force-required local changes', () => {
  const value = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/codex-mode-remove-preview.json',
      'utf8',
    ),
  ) as {
    results: Array<{
      exposure_id: string
      agent: string
      target: string
      requires_force: boolean
      local_changes: boolean
    }>
  }
  const result = value.results[0]!,
    request = {
      workspace: fixture().request.workspace,
      agent: result.agent,
      exposureId: result.exposure_id,
      target: { hostId: 'local', path: result.target },
    }
  expect(contract.removalPreview(value, request).token).toMatch(/^[a-f0-9]{64}$/)
  result.requires_force = true
  result.local_changes = true
  expect(() => contract.removalPreview(value, request)).toThrow(/local changes/)
})
it('constructs mutation argv from validated selectors and tokens, preserving spaces as one argument', () => {
  const argv = load<{
      exposureArgs(request: unknown, token: string): string[]
      initializationArgs(selection: unknown): string[]
    }>('management-argv'),
    f = fixture()
  expect(argv.exposureArgs(f.request, f.result.preview.confirmation_token)).not.toContain(
    '--force',
  )
  expect(() =>
    argv.exposureArgs({ ...f.request, source: { id: '--force' } }, 'a'.repeat(64)),
  ).toThrow(/identity/)
  expect(
    argv.initializationArgs({
      root: { hostId: 'local', path: '/owned library' },
      git: false,
    }),
  ).toEqual(['library', 'init', '--path', '/owned library', '--no-git', '--json'])
})
