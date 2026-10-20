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
  let pendingAcceptance = false,
    observationFails = false,
    holdApply: string | undefined,
    releaseApply: (() => void) | undefined
  const client = {
    ...f.client,
    signal: controller.signal,
    listen: () => () => {},
    request: async (capability: string, input: Record<string, unknown>) => {
      if (capability === 'delivery.status' && observationFails)
        throw new Error('Delivery status is unavailable for this workspace')
      if (capability === holdApply) {
        holdApply = undefined
        await new Promise<void>((resolve) => {
          releaseApply = resolve
        })
      }
      return capability === 'actions.invoke'
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
        : f.client.request(capability, input)
    },
  }
  const sandbox = { AbortController, TextEncoder, Module: undefined as unknown }
  runInNewContext(
    buildSync({
      entryPoints: ['packages/skillager-extension/src/selected-task-surface.mjs'],
      bundle: true,
      format: 'iife',
      globalName: 'Module',
      write: false,
    }).outputFiles[0]!.text,
    sandbox,
  )
  const changed = vi.fn(),
    activity = vi.fn()
  const view = (
    sandbox.Module as {
      bindSelectedTaskSurface(
        document: Document,
        client: unknown,
        ports: unknown,
      ): {
        select(input: unknown): void
        contextChanged(): void
        visibilityChanged(options?: { completed: boolean }): void
        submitted: boolean
        onActivity(callback: unknown): void
        dispose(): void
      }
    }
  ).bindSelectedTaskSurface(document, client, {
    context: () => context,
    changed,
    activity,
  })
  view.onActivity(activity)
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
    changed,
    activity,
    selection,
    button,
    ready,
    exportFolder,
    prepared,
    failObservation: () => {
      observationFails = true
    },
    hold: (capability = 'delivery.apply') => {
      holdApply = capability
    },
    waiting: () => !!releaseApply,
    release: () => releaseApply?.(),
    show: (visible: boolean, completed = false) => {
      context = { ...context, visible }
      view.visibilityChanged({ completed })
    },
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
    'Full add completed',
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

it.each(['completed', 'uncertain', 'rejected'] as const)(
  'notifies the exact remote origin for %s delivery without substituting a result',
  async (outcome) => {
    const f = fixture()
    f.view.select(f.selection)
    await f.ready()
    f.exportFolder()
    f.button('task-primary').click()
    await f.prepared()
    if (outcome === 'uncertain') f.lostReply()
    if (outcome === 'rejected') f.changeSource()
    f.button('task-confirm').click()
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledOnce())
    expect(f.changed.mock.calls[0]?.[1]).toMatchObject(f.workspace)
    if (outcome === 'rejected') expect(f.changed.mock.calls[0]?.[0]).toBeUndefined()
    else expect(f.changed.mock.calls[0]?.[0]).toMatchObject({ outcome })
    expect(f.activity).toHaveBeenCalledWith(true)
    expect(f.activity).toHaveBeenLastCalledWith(false)
  },
)

it.each(['completed', 'refused', 'uncertain'] as const)(
  'retains actual composed remote %s result across hidden completion and metadata renewal',
  async (outcome) => {
    const f = fixture()
    f.view.select(f.selection)
    await f.ready()
    f.exportFolder()
    f.button('task-primary').click()
    await f.prepared()
    if (outcome === 'uncertain') f.lostReply()
    if (outcome === 'refused') f.result({ outcome })
    f.hold()
    f.button('task-confirm').click()
    await vi.waitFor(() => expect(f.waiting()).toBe(true))
    f.show(false)
    f.release()
    await vi.waitFor(() => expect(f.view.submitted).toBe(false))
    expect(JSON.parse(document.getElementById('task-result')!.textContent)).toMatchObject(
      { outcome, operation: 'operation' },
    )
    f.show(true, outcome === 'completed')
    await vi.waitFor(() => expect(f.button('task-refresh').disabled).toBe(false))
    if (outcome === 'completed') {
      await vi.waitFor(() =>
        expect(f.button('task-primary').textContent).toBe('Recorded'),
      )
      expect(f.button('task-remove').hidden).toBe(false)
    } else if (outcome === 'uncertain') {
      await vi.waitFor(() => expect(f.button('task-reconcile').hidden).toBe(false))
      expect(f.button('task-primary').disabled).toBe(true)
    }
    expect(f.calls.filter((call) => call.capability === 'delivery.apply')).toHaveLength(1)
    expect(f.calls.filter((call) => call.capability === 'delivery.preview')).toHaveLength(
      1,
    )
    expect(f.button('task-confirmation').hidden).toBe(true)
  },
)
it('keeps remote delivery physically busy on early return and quarantines another workspace', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  f.exportFolder()
  f.button('task-primary').click()
  await f.prepared()
  f.hold()
  f.button('task-confirm').click()
  await vi.waitFor(() => expect(f.waiting()).toBe(true))
  f.show(false)
  f.show(true)
  expect(f.view.submitted).toBe(true)
  expect(f.button('task-primary').disabled).toBe(true)
  f.target()
  f.release()
  await vi.waitFor(() => expect(f.view.submitted).toBe(false))
  expect(document.getElementById('task-result')!.textContent).toBe('')
  expect(f.changed.mock.calls.at(-1)?.[1]).toMatchObject(f.workspace)
  expect(f.calls.filter((call) => call.capability === 'delivery.apply')).toHaveLength(1)
})

it('retains a hidden remote pre-submit rejection without delivering or reviving the preview', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  f.exportFolder()
  f.button('task-primary').click()
  await f.prepared()
  f.hold('connector.execute')
  f.button('task-confirm').click()
  await vi.waitFor(() => expect(f.waiting()).toBe(true))
  f.show(false)
  f.release()
  await vi.waitFor(() => expect(f.view.submitted).toBe(false))
  expect(f.changed.mock.calls.at(-1)?.[0]).toBeUndefined()
  const message = document.getElementById('task-state')!.textContent
  expect(message).toContain('changed')
  f.show(true)
  await f.ready()
  expect(document.getElementById('task-state')!.textContent).toBe(message)
  expect(f.button('task-confirmation').hidden).toBe(true)
  expect(f.calls.filter((call) => call.capability === 'delivery.apply')).toHaveLength(0)
  expect(f.calls.filter((call) => call.capability === 'delivery.preview')).toHaveLength(1)
})

it.each([false, true])(
  'retains delivery uncertainty only for the same selection after failed observation (replace workspace=%s)',
  async (replace) => {
    const f = fixture()
    f.view.select(f.selection)
    await f.ready()
    f.exportFolder()
    f.button('task-primary').click()
    await f.prepared()
    f.lostReply()
    f.button('task-confirm').click()
    await vi.waitFor(() => expect(f.button('task-reconcile').hidden).toBe(false))
    expect(document.getElementById('task-result')!.textContent).toContain('operation')
    f.failObservation()
    if (replace) f.target()
    else {
      f.show(false)
      f.show(true)
    }
    await vi.waitFor(() =>
      expect(document.getElementById('task-state')!.textContent).toBe(
        'Delivery status is unavailable for this workspace',
      ),
    )
    expect(f.button('task-reconcile').hidden).toBe(replace)
    expect(f.button('task-primary').disabled).toBe(true)
    if (replace) expect(document.getElementById('task-result')!.textContent).toBe('')
    else
      expect(document.getElementById('task-result')!.textContent).toContain('operation')
    expect(f.calls.filter((call) => call.capability === 'delivery.apply')).toHaveLength(1)
  },
)
