// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'

type Value = Record<string, unknown>
interface Preview {
  exposure_id: string
  target: string
  preview: {
    project: string
    confirmation_token: string
    source: {
      id: string
      root: string
      content_hash: string
      source: { library_id: string; library_root: string }
    }
  }
}
interface Status {
  library: Value
  skill: {
    id: string
    path: string
    entrypoint: string
    working_hash: string
    accepted_hash: string
    acceptance: string
    exposures: Value[]
  }
}
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
})
function fixture() {
  const template = document.createElement('template')
  template.innerHTML = readFileSync('packages/skillager-extension/detail.html', 'utf8')
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  const preview = JSON.parse(
    readFileSync(
      'test/fixtures/skillager-management/codex-exact-mode-update-preview.json',
      'utf8',
    ),
  ) as [Preview]
  const selected = preview[0].preview.source
  const status = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-status.json', 'utf8'),
  ) as Status
  Object.assign(status.library, {
    library_id: selected.source.library_id,
    root: selected.source.library_root,
  })
  Object.assign(status.skill, {
    id: selected.id,
    path: selected.root,
    entrypoint: `${selected.root}/SKILL.md`,
    working_hash: selected.content_hash,
    accepted_hash: selected.content_hash,
    acceptance: 'accepted',
  })
  const workspace = {
    id: 'workspace',
    name: 'Project',
    host: 'local',
    root: { hostId: 'local', path: preview[0].preview.project },
  }
  let context: Value = { visible: true, workspace },
    exposures: unknown[] = [],
    failure = false,
    hold = false,
    release: (() => void) | undefined
  let actionResult: Value = {
    outcome: 'verified',
    action: 'add-copy',
    exposureId: preview[0].exposure_id,
    target: { hostId: 'local', path: preview[0].target },
  }
  const actions: Value[] = [],
    outputs = new Map<string, unknown>(),
    controller = new AbortController()
  let count = 0
  const client = {
    alive: true,
    signal: controller.signal,
    listen: () => () => undefined,
    request: async (capability: string, input: Value): Promise<unknown> => {
      if (capability === 'actions.invoke') {
        actions.push(input)
        return actionResult
      }
      if (capability === 'connector.output')
        return input['release']
          ? null
          : {
              data:
                input['stream'] === 'stderr'
                  ? ''
                  : JSON.stringify(outputs.get(String(input['receipt']))),
              nextOffset: null,
            }
      if (capability === 'connector.connect') {
        failure = false
        return { connections: [{ outcome: 'connected' }] }
      }
      const args = input['args'] as string[]
      if (failure && input['connector'] === 'project-cli')
        return { outcome: 'not-started', reason: 'unapproved' }
      const receipt = String(++count)
      outputs.set(
        receipt,
        args.includes('--list')
          ? { schema: 'skillager.exposures.v1', exposures }
          : args[0] === 'expose'
            ? preview
            : input['connector'] === 'project-cli'
              ? status
              : { ...status, skill: { ...status.skill, exposures: [] } },
      )
      if (hold) {
        hold = false
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return { outcome: 'completed', code: 0, receipt, truncated: false }
    },
  }
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/selected-skill-view.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { TextEncoder, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
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
    row: { id: selected.id, source: 'library', path: status.skill.entrypoint },
    library: { id: selected.source.library_id, root: selected.source.library_root },
  }
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement
  const ready = () =>
    vi.waitFor(() => expect(button('task-primary').disabled).toBe(false))
  return {
    view,
    selection,
    status,
    actions,
    preview,
    button,
    ready,
    changeMode: (mode: string) => {
      const select = document.getElementById('task-mode') as HTMLSelectElement
      select.value = mode
      select.dispatchEvent(new Event('change'))
    },
    installed: () => {
      exposures = [
        {
          ...preview[0],
          skill_id: selected.id,
          source_library_id: selected.source.library_id,
          mode: 'native',
          status: 'current',
        },
      ]
      status.skill.exposures = [
        {
          path: preview[0].target,
          agent: 'codex',
          scope: 'project',
          source_library_id: selected.source.library_id,
          source_hash: selected.content_hash,
        },
      ]
    },
    fail: () => {
      failure = true
    },
    hold: () => {
      hold = true
    },
    release: () => release?.(),
    target: (id: string) => {
      context = { ...context, workspace: { ...workspace, id } }
      view.contextChanged()
    },
    result: (value: Value) => {
      actionResult = value
    },
  }
}
it('resolves selection internally and adds the accepted version with one action and visible destination', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  expect(document.getElementById('task-destination')?.textContent).toContain(
    'local: /owned-fixture/',
  )
  f.button('task-primary').click()
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.actions[0]).toMatchObject({
    action: 'add-copy',
    input: {
      skillId: f.status.skill.id,
      hash: f.status.skill.accepted_hash,
      agent: 'codex',
      mode: 'native',
    },
  })
  await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Added'))
  expect(f.button('task-primary').disabled).toBe(true)
})
it('keeps a current project-bound copy quiet after refresh and presents affected files with one confirmation for mode changes', async () => {
  const f = fixture()
  f.installed()
  f.view.select(f.selection)
  await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Added'))
  expect(f.button('task-primary').disabled).toBe(true)
  f.button('task-refresh').click()
  await vi.waitFor(() =>
    expect(document.getElementById('task-state')?.textContent).toContain(
      'In this project',
    ),
  )
  expect(f.button('task-primary').textContent).toBe('Added')
  f.changeMode('stub')
  await f.ready()
  f.button('task-primary').click()
  await vi.waitFor(() =>
    expect((document.getElementById('task-confirmation') as HTMLElement).hidden).toBe(
      false,
    ),
  )
  expect(document.getElementById('task-effects')?.textContent).toContain('SKILL.md')
  expect(f.actions).toEqual([])
  f.button('task-cancel').click()
  expect(f.actions).toEqual([])
  f.button('task-primary').click()
  await vi.waitFor(() =>
    expect((document.getElementById('task-confirmation') as HTMLElement).hidden).toBe(
      false,
    ),
  )
  f.button('task-confirm').click()
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.actions[0]).toMatchObject({
    action: 'change-exposure',
    input: { token: f.preview[0].preview.confirmation_token },
  })
})
it('invalidates an old preparation immediately on destination changes and ignores its late completion', async () => {
  const f = fixture()
  f.installed()
  f.view.select(f.selection)
  await vi.waitFor(() => expect(f.button('task-primary').textContent).toBe('Added'))
  f.changeMode('stub')
  await f.ready()
  f.hold()
  f.button('task-primary').click()
  await vi.waitFor(() => expect(f.button('task-primary').disabled).toBe(true))
  f.target('other')
  f.release()
  await f.ready()
  expect((document.getElementById('task-confirmation') as HTMLElement).hidden).toBe(true)
  expect(f.actions).toEqual([])
})
it('never leaves a stale Add enabled after failed observation and refreshes automatically after connection', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  f.fail()
  f.button('task-refresh').click()
  await vi.waitFor(() => expect(f.button('task-connect').hidden).toBe(false))
  expect(f.button('task-primary').disabled).toBe(true)
  f.button('task-connect').click()
  await f.ready()
  expect(f.button('task-connect').hidden).toBe(true)
})
it('retains uncertainty for the exact source and target across selection and destination changes', async () => {
  const f = fixture()
  f.view.select(f.selection)
  await f.ready()
  f.result({
    outcome: 'uncertain',
    action: 'add-copy',
    operationId: 'owned-operation',
    message: 'Completion unknown',
  })
  f.button('task-primary').click()
  await vi.waitFor(() => expect(f.button('task-reconcile').hidden).toBe(false))
  f.target('other')
  await f.ready()
  f.target('workspace')
  await vi.waitFor(() =>
    expect(document.getElementById('task-state')?.textContent).toContain(
      'uncertain outcome',
    ),
  )
  expect(f.button('task-primary').disabled).toBe(true)
  expect(f.button('task-reconcile').hidden).toBe(false)
})

it('uses the canonical skill identity while retaining a searched occurrence selection', async () => {
  const f = fixture()
  f.view.select({
    ...f.selection,
    row: {
      ...f.selection.row,
      id: 'search-occurrence-hash',
      canonical: { library_id: f.selection.library.id, skill_id: f.selection.row.id },
    },
  })
  await f.ready()
  f.button('task-primary').click()
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.actions[0]).toMatchObject({
    action: 'add-copy',
    input: { skillId: f.selection.row.id },
  })
})

it.each(['foreign-library', 'stale-entrypoint'])(
  'refuses a same-name searched occurrence with %s identity',
  async (mismatch) => {
    const f = fixture()
    f.view.select({
      ...f.selection,
      row: {
        ...f.selection.row,
        id: 'same-name-occurrence',
        name: 'Same visible name',
        path:
          mismatch === 'stale-entrypoint'
            ? '/old/library/SKILL.md'
            : f.selection.row.path,
        canonical: {
          library_id:
            mismatch === 'foreign-library'
              ? '00000000-0000-4000-8000-000000000000'
              : f.selection.library.id,
          skill_id: f.selection.row.id,
        },
      },
    })
    await vi.waitFor(() =>
      expect(document.getElementById('task-state')?.textContent).toMatch(
        /different library|moved or is unavailable/,
      ),
    )
    expect(f.button('task-primary').disabled).toBe(true)
    expect(f.actions).toEqual([])
  },
)
