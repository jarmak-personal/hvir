// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture as deliveryFixture } from './fixtures/skillager-delivery'
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
function fixture() {
  const f = deliveryFixture(),
    controller = new AbortController()
  const template = document.createElement('template')
  template.innerHTML = readFileSync('packages/skillager-extension/detail.html', 'utf8')
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  let context = { visible: true, workspace: { ...f.workspace, name: 'Remote' } }
  let pendingAcceptance = false
  const client = {
    ...f.client,
    signal: controller.signal,
    listen: () => () => {},
    request: (capability: string, input: Record<string, unknown>) =>
      capability === 'actions.invoke'
        ? Promise.resolve(
            input['input'] &&
              (input['input'] as Record<string, unknown>)['mode'] === 'report'
              ? {
                  data: JSON.stringify({
                    id: 'accepting',
                    operation: {
                      action: 'accept-version',
                      library: {
                        id: f.input['library'].id,
                        root: { hostId: 'local', path: '/library' },
                      },
                      source: { id: 'lib/skill' },
                    },
                  }),
                  nextOffset: null,
                }
              : { ids: pendingAcceptance ? ['accepting'] : [] },
          )
        : f.client.request(capability, input),
  }
  const sandbox = { TextEncoder, Module: undefined as unknown }
  runInNewContext(
    buildSync({
      entryPoints: ['packages/skillager-extension/src/selected-skill-view.mjs'],
      bundle: true,
      format: 'iife',
      globalName: 'Module',
      write: false,
    }).outputFiles[0]!.text,
    sandbox,
  )
  const view = (
    sandbox.Module as {
      bindSelectedSkill(
        document: Document,
        client: unknown,
        ports: unknown,
      ): { select(input: unknown): void; contextChanged(): void; dispose(): void }
    }
  ).bindSelectedSkill(document, client, { context: () => context })
  dispose = () => {
    view.dispose()
    controller.abort()
  }
  const selection = {
    library: { id: f.input['library'].id, root: '/library' },
    row: {
      id: 'ranked-occurrence',
      source: 'library',
      path: '/library/skills/skill/SKILL.md',
      canonical: { library_id: f.input['library'].id, skill_id: 'lib/skill' },
    },
  }
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement
  const ready = () =>
    vi.waitFor(() => expect(button('task-primary').disabled).toBe(false))
  const exportFolder = () => {
    ;(document.getElementById('task-export') as HTMLInputElement).value = '/exports/one'
  }
  const prepared = () =>
    vi.waitFor(() =>
      expect((document.getElementById('task-confirmation') as HTMLElement).hidden).toBe(
        false,
      ),
    )
  return {
    ...f,
    view,
    selection,
    button,
    ready,
    exportFolder,
    prepared,
    pendingAcceptance: () => {
      pendingAcceptance = true
    },
    target: () => {
      context = {
        ...context,
        workspace: {
          ...context.workspace,
          id: 'other',
          root: { hostId: 'ssh:remote', path: '/another' },
        },
      }
      view.contextChanged()
    },
  }
}
it('keeps canonical source and exact SSH destination through Full Add, changed-version Update, and Remove previews', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  expect(document.getElementById('task-destination')?.title).toContain(
    'ssh:remote: /project',
  )
  expect((document.getElementById('task-mode') as HTMLSelectElement).disabled).toBe(true)
  f.exportFolder()
  f.button('task-primary').click()
  await f.prepared()
  expect(document.getElementById('task-plan')?.textContent).toContain('API_TOKEN')
  expect(document.getElementById('task-effects')?.textContent).toContain('SKILL.md')
  expect(f.calls.some((call) => call.capability === 'delivery.apply')).toBe(false)
  f.button('task-confirm').click()
  await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Recorded'))
  expect(document.getElementById('task-state')?.textContent).toContain(
    'not been verified',
  )
  expect(f.records()[0]).toMatchObject({
    target: { hostId: 'ssh:remote', path: '/project/.agents/skills/skill' },
  })
  expect(f.button('task-update').hidden).toBe(false)
  f.exportFolder()
  f.button('task-update').click()
  await f.prepared()
  expect(
    f.calls.filter((call) => call.capability === 'delivery.preview').at(-1)?.input,
  ).toMatchObject({ kind: 'update', record: 'record' })
  f.button('task-cancel').click()
  f.advanceVersion()
  f.button('task-refresh').click()
  await f.ready()
  expect(f.button('task-primary').textContent).toBe('Update')
  f.exportFolder()
  f.button('task-primary').click()
  await f.prepared()
  expect(
    f.calls.filter((call) => call.capability === 'delivery.preview').at(-1)?.input,
  ).toMatchObject({ kind: 'update', record: 'record' })
  f.button('task-confirm').click()
  await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Recorded'))
  f.button('task-remove').click()
  await f.prepared()
  expect(
    f.calls.filter((call) => call.capability === 'delivery.preview').at(-1)?.input,
  ).toMatchObject({ kind: 'remove', record: 'record' })
  f.button('task-confirm').click()
  await vi.waitFor(() => expect(f.records()).toHaveLength(0))
  await f.ready()
  expect(f.button('task-primary').textContent).toBe('Add to project')
  expect(
    f.calls
      .filter((call) => call.capability === 'connector.execute')
      .every((call) => call.input['connector'] === 'library-cli'),
  ).toBe(true)
})
it.each(['target', 'selection', 'cancel'] as const)(
  'releases the reviewed export when %s changes and never applies its stale preview',
  async (change) => {
    const f = fixture()
    f.view.select(f.selection)
    await f.ready()
    f.exportFolder()
    f.button('task-primary').click()
    await f.prepared()
    if (change === 'target') f.target()
    else if (change === 'selection') f.view.select(undefined)
    else f.button('task-cancel').click()
    await vi.waitFor(() =>
      expect(
        f.calls.some(
          (call) => call.capability === 'delivery.manifest' && call.input['release'],
        ),
      ).toBe(true),
    )
    expect((document.getElementById('task-confirmation') as HTMLElement).hidden).toBe(
      true,
    )
    f.button('task-confirm').click()
    expect(f.calls.some((call) => call.capability === 'delivery.apply')).toBe(false)
  },
)
it('does not silently substitute a same-name source from another library', async () => {
  const f = fixture()
  f.view.select({
    ...f.selection,
    library: { id: '00000000-0000-4000-8000-000000000000', root: '/library' },
  })
  await vi.waitFor(() =>
    expect(document.getElementById('task-state')?.textContent).toContain(
      'different library',
    ),
  )
  expect(f.button('task-primary').disabled).toBe(true)
  expect(f.calls.some((call) => call.capability.startsWith('delivery.'))).toBe(false)
})

it('labels library acceptance uncertainty by its owner when an SSH project is selected', async () => {
  const f = fixture()
  f.pendingAcceptance()
  f.view.select(f.selection)
  await vi.waitFor(() => expect(f.button('task-reconcile').hidden).toBe(false))
  expect(f.button('task-reconcile').textContent).toBe('Inspect uncertain operation')
  expect(document.getElementById('task-state')?.textContent).toContain(
    'uncertain outcome',
  )
  expect(document.getElementById('task-state')?.textContent).not.toContain(
    'Delivery recovery',
  )
  expect(f.button('task-primary').disabled).toBe(true)
})
