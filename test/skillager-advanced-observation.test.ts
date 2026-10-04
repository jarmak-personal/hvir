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
      contents: `export { bindExposureView } from './packages/skillager-extension/src/exposure-view.mjs';
      export { exposureFacts } from './packages/skillager-extension/src/exposure-reconcile.mjs';
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
    bindExposureView(document: Document, client: unknown, ports: unknown): unknown
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
it('observes every preserved native choice and reconciles full metadata independently of synchronization report capacity', async () => {
  const { sync, library, module } = fixture()
  const template = document.createElement('template')
  template.innerHTML = readFileSync(
    'packages/skillager-extension/management.html',
    'utf8',
  )
  for (const item of template.content.querySelectorAll('script, link')) item.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  const workspace = {
    id: 'exact',
    host: 'local',
    root: { hostId: 'local', path: '/owned-fixture/advanced/project' },
  }
  const callbacks = new Map<
    string,
    (event: unknown, current: () => boolean) => Promise<void>
  >()
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
  module.bindExposureView(
    document,
    {},
    {
      on(
        id: string,
        _event: string,
        callback: (event: unknown, current: () => boolean) => Promise<void>,
      ) {
        callbacks.set(id, callback)
      },
      local: () => workspace,
      clear: () => {},
      say: () => {},
      io: () => io,
      library: () => library,
    },
  )
  await callbacks.get('observe-advanced')!(undefined, () => true)
  expect(document.querySelectorAll('#advanced-origin option')).toHaveLength(2)
  const observed = JSON.parse(
    document.getElementById('advanced-observation')!.textContent,
  ) as { preserved: Sync }
  expect(observed.preserved).toEqual(sync)
  expect(observed.preserved.candidates).toHaveLength(29)
  expect(() => module.syncObservation(sync, library)).toThrow(/action-result bound/)
  sync.coverage['complete'] = false
  await callbacks.get('observe-advanced')!(undefined, () => true)
  expect(document.querySelectorAll('#advanced-origin option')).toHaveLength(0)
  expect(document.querySelectorAll('#advanced-router option')).toHaveLength(1)
  sync.coverage['complete'] = true
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
