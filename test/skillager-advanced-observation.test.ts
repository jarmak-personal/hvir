// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { expect, it } from 'vitest'

type Value = Record<string, unknown>
interface Sync extends Value {
  library: { library_id: string; root: string }
  candidates: Value[]
  lineages: Value[]
  coverage: Value
}
function fixture() {
  // Whole supported installed-wheel response; only the owned root paths are normalized.
  const sync = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/advanced-complete-sync-status.json',
      'utf8',
    ),
  ) as Sync
  const bundle = buildSync({
    stdin: {
      contents: `export { exposureFacts } from './packages/skillager-extension/src/exposure-reconcile.mjs';
      export { syncObservation } from './packages/skillager-extension/src/management-library.mjs';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { TextEncoder, crypto: webcrypto, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const module = sandbox.Module as {
    exposureFacts(
      io: unknown,
      operation: Value,
      workspace: Value,
      library: Value,
    ): Promise<Value>
    syncObservation(value: Value, library: Value): Value
  }
  const library = {
    id: sync.library.library_id,
    root: { hostId: 'local', path: sync.library.root },
  }
  return { sync, library, module }
}
it('reconciles complete native metadata independently of synchronization report capacity', async () => {
  const { sync, library, module } = fixture()
  const workspace = {
    id: 'exact',
    host: 'local',
    root: { hostId: 'local', path: '/owned-fixture/advanced/project' },
  }
  const calls: string[][] = []
  const io = {
    run(args: string[]) {
      calls.push(args)
      return Promise.resolve(
        args.includes('--request-json')
          ? {
              schema: 'skillager.exposure-plan.v1',
              status: 'refused',
              reason_code: 'name-conflict',
            }
          : args.includes('--list')
            ? {
                schema: 'skillager.exposures.v1',
                exposures: [
                  {
                    mode: 'router',
                    agent: 'codex',
                    scope: 'project',
                    target: '/owned-fixture/advanced/project/.agents/skills/owned-router',
                    exposure_id: 'owned-router',
                    skill_ids: ['lib/owned'],
                  },
                ],
              }
            : sync,
      )
    },
  }
  expect(module.syncObservation(sync, library)).toEqual(sync)
  const consequential = structuredClone(sync)
  for (const item of consequential.candidates)
    Object.assign(item, { state: 'eligible-create', reason_code: null })
  expect(() => module.syncObservation(consequential, library)).toThrow(
    /action-result bound/,
  )
  const facts = await module.exposureFacts(
    io,
    {
      workspace,
      agent: 'codex',
      request: { action: 'group' },
      requestRaw: JSON.stringify({
        schema: 'skillager.exposure-request.v1',
        action: 'group',
        name: 'Owned',
        library_id: library.id,
        members: ['lib/owned'],
      }),
      plan: { targets: [] },
    },
    workspace,
    library,
  )
  expect(facts['state']).toBe('supported-current-observation')
  expect(facts['nativePreservation']).toMatch(/^[a-f0-9]{64}$/u)
  expect(
    calls.some((args) => args.includes('--approved') || args.includes('--apply')),
  ).toBe(false)
  document.body.replaceChildren()
})
