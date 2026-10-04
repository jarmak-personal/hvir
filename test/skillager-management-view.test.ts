// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'

type Value = Record<string, unknown>
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
function fixture() {
  const template = document.createElement('template')
  template.innerHTML = readFileSync(
    'packages/skillager-extension/management.html',
    'utf8',
  )
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  const preview = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/codex-mode-initial-preview.json',
      'utf8',
    ),
  ) as Array<{
    agent: string
    target: string
    exposure_id: string
    scope: string
    preview: {
      source: {
        id: string
        root: string
        content_hash: string
        source: { library_id: string; library_root: string }
      }
    }
  }>
  const selected = preview[0]!.preview.source
  const update = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/codex-exact-mode-update-preview.json',
      'utf8',
    ),
  ) as unknown
  const status = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-status.json', 'utf8'),
  ) as { library: Value; skill: Value }
  status.library['library_id'] = selected.source.library_id
  status.library['root'] = selected.source.library_root
  Object.assign(status.skill, {
    id: selected.id,
    path: selected.root,
    working_hash: selected.content_hash,
    accepted_hash: selected.content_hash,
    acceptance: 'accepted',
  })
  const listeners = new Set<(message: unknown) => void>(),
    controller = new AbortController(),
    outputs = new Map<string, unknown>()
  const actions: Array<{ action: string; input: Value }> = []
  let serial = 0
  let protectedTarget = false
  const client = {
    alive: true,
    signal: controller.signal,
    listen(callback: (message: unknown) => void) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    request(capability: string, input: Value) {
      if (capability === 'actions.invoke') {
        actions.push(input as { action: string; input: Value })
        return Promise.resolve({ outcome: 'verified' })
      }
      if (capability === 'connector.output')
        return Promise.resolve(
          input['release']
            ? null
            : {
                data:
                  input['stream'] === 'stderr'
                    ? ''
                    : JSON.stringify(outputs.get(String(input['receipt']))),
                nextOffset: null,
              },
        )
      const args = input['args'] as string[],
        receipt = String(++serial)
      outputs.set(
        receipt,
        args.includes('--list')
          ? { schema: 'skillager.exposures.v1', exposures: preview }
          : args.includes('expose')
            ? protectedTarget
              ? [
                  {
                    schema: 'skillager.exposure-result.v1',
                    status: 'skipped',
                    reason: 'target has local edits',
                  },
                ]
              : update
            : status,
      )
      return Promise.resolve({ outcome: 'completed', code: 0, receipt, truncated: false })
    },
  }
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/management-view.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { TextEncoder, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const module = sandbox.Module as {
    bindManagementView(document: Document, client: unknown): { dispose(): void }
  }
  const view = module.bindManagementView(document, client)
  dispose = () => {
    view.dispose()
    controller.abort()
  }
  const row = (id: string) => {
    for (const listener of listeners)
      listener({
        kind: 'context',
        context: {
          visible: true,
          workspace: {
            id: 'exact-workspace',
            host: 'local',
            root: { hostId: 'local', path: '/owned-fixture/mode-change-codex' },
          },
          input: { row: { source: 'library', id } },
        },
      })
  }
  row(selected.id)
  const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click()
  const ready = async (message: RegExp) =>
    vi.waitFor(() =>
      expect(document.getElementById('state')!.textContent).toMatch(message),
    )
  const connect = async () => {
    click('observe-library')
    await ready(/Public library status observed/)
    click('connect-library')
    await ready(/Management connected/)
    click('observe-source')
    await ready(/Accepted source version selected/)
  }
  return {
    click,
    ready,
    connect,
    actions,
    row,
    selected,
    input: document.getElementById('skill-id') as HTMLInputElement,
    protectTarget: () => {
      protectedTarget = true
    },
  }
}
it('shows protected CLI refusal without a preview or confirmation action', async () => {
  const f = fixture()
  await f.connect()
  f.click('observe-copies')
  await vi.waitFor(() =>
    expect(document.querySelectorAll('#managed-copies button')).toHaveLength(2),
  )
  f.protectTarget()
  ;(document.getElementById('copy-mode') as HTMLSelectElement).value = 'stub'
  ;(document.querySelector('#managed-copies button') as HTMLButtonElement).click()
  await f.ready(/preserve the existing target and observe/)
  expect(document.getElementById('review')!.hidden).toBe(true)
  expect(f.actions).toEqual([])
})
it.each(['input', 'context', 'programmatic'])(
  'cannot Add a cached source after %s retargeting',
  async (mode) => {
    const f = fixture()
    await f.connect()
    if (mode === 'context') f.row('lib/different')
    else {
      f.input.value = 'lib/different'
      if (mode === 'input') f.input.dispatchEvent(new Event('input'))
    }
    f.click('add-copy')
    await f.ready(/Select the current accepted source version explicitly/)
    expect(f.actions).toEqual([])
  },
)
it.each(['input', 'context', 'programmatic'])(
  'cannot confirm a cached Update plan after %s source retargeting',
  async (mode) => {
    const f = fixture()
    await f.connect()
    f.click('observe-copies')
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#managed-copies button')).toHaveLength(2),
    )
    ;(document.getElementById('copy-mode') as HTMLSelectElement).value = 'stub'
    ;(document.querySelector('#managed-copies button') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(document.getElementById('review')!.hidden).toBe(false))
    if (mode === 'context') f.row('lib/different')
    else {
      f.input.value = 'lib/different'
      if (mode === 'input') f.input.dispatchEvent(new Event('input'))
    }
    f.click('confirm-plan')
    await f.ready(
      mode === 'programmatic'
        ? /selected source changed/
        : /Review one complete current plan/,
    )
    expect(f.actions).toEqual([])
    if (mode !== 'programmatic') {
      f.row(f.selected.id)
      f.click('add-copy')
      await f.ready(/Select the current accepted source version explicitly/)
      expect(f.actions).toEqual([])
    }
  },
)
