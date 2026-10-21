import { vi } from 'vitest'
import { importModule } from './skillager-import'
import { projectImportFixture } from './skillager-project-import'
import { connectorOutputFixture } from './connector-output'

type Value = Record<string, unknown>
interface View {
  open(): Promise<void>
  observe(): Promise<void>
  close(): void
  invalidate(): void
  contextChanged(): void
  visibilityChanged(): void
  scopeChanged(): void
  dispose(): void
  submitted: boolean
}
/** Real task view/helpers; only its public connector/action transport is replaced. */
export function projectImportViewFixture(eligible = 2, managed = 0) {
  document.body.innerHTML = `
    <div id="project-save-entry" hidden><span id="project-save-count"></span>
      <button id="project-save-open">Save all…</button></div>
    <section id="skill-task-sheet"><div id="instructions">Keep reading</div></section>`
  const data = projectImportFixture(),
    native = connectorOutputFixture(),
    control = new AbortController(),
    requests: Array<{ capability: string; input: Value }> = [],
    context = { visible: true, workspace: data.workspace },
    all = Array.from({ length: eligible + managed }, (_, i) => {
      const item = structuredClone(data.inventory.items[0]!)
      item.occurrence_id = `project:${(i + 1).toString(16).padStart(64, '0')}`
      item.id = `project/skill-${i}`
      item.name = `Skill ${i}`
      item.skill_file = `${data.workspace.root.path}/.skills/skill-${i}/SKILL.md`
      item.destination_id = `lib/skill-${i}`
      item.eligibility = i < managed ? 'managed' : 'eligible'
      return item
    }),
    inventory = structuredClone(data.inventory)
  inventory.summary = {
    total: all.length,
    eligible,
    managed,
    already_saved: 0,
    blocked: 0,
    conflict: 0,
    duplicate: 0,
  }
  inventory.default_selection =
    eligible <= 32
      ? all
          .filter((item) => item.eligibility === 'eligible')
          .map((item) => item.occurrence_id)
          .sort()
      : (null as unknown as string[])
  let serial = 0,
    project = true,
    holdPreview = false,
    holdInventory = 0,
    holdSave = false,
    staleCursors = 0,
    previewFailure: Error | undefined,
    inventoryFailure: Error | undefined,
    finishPreview: (() => void) | undefined,
    finishSave: ((result?: unknown, error?: Error) => void) | undefined,
    result: unknown,
    record: unknown
  const finishInventories: Array<() => void> = []
  const page = (offset = 0) => ({
    ...inventory,
    items: all.slice(offset, offset + 100),
    next_cursor: offset + 100 < all.length ? String(offset + 100) : null,
  })
  function preview(selection: string[]) {
    const value = structuredClone(data.preview)
    value.selection = [...selection].sort()
    value.items = value.selection.map((id) => {
      const source = all.find((item) => item.occurrence_id === id)!,
        item = structuredClone(data.preview.items[0]!),
        path = source.skill_file.replace(/\/SKILL.md$/u, ''),
        name = source.destination_id.slice(4),
        destination = `${value.library.root}/skills/${name}`
      item.occurrence_id = id
      Object.assign(item.source, {
        id: source.id,
        name: source.name,
        file: source.skill_file,
        path,
      })
      Object.assign(item.destination, {
        id: source.destination_id,
        name,
        slug: name,
        path: destination,
      })
      item.source_location.path = path
      item.source_file_identity.path = source.skill_file
      Object.assign(item.review_manifest, {
        source_id: source.id,
        source_root: path,
        source_file: source.skill_file,
        destination_id: source.destination_id,
        destination_path: destination,
      })
      return item
    })
    value.next_command_argv = [
      'skillager',
      'import-project',
      '--json',
      '--review-manifest',
      '--select',
      JSON.stringify(value.selection),
      '--yes',
      '--confirmation-token',
      value.confirmation_token,
    ]
    return value
  }
  const changed = vi.fn(),
    activity = vi.fn()
  const client = {
    alive: true,
    signal: control.signal,
    delay: () => Promise.resolve(),
    async request(capability: string, input: Value): Promise<unknown> {
      requests.push({ capability, input })
      if (capability === 'connector.output') return native.read(input)
      if (capability === 'actions.invoke') {
        if (input.action === 'save-project-skills') {
          const selected = JSON.parse(
            (input.input as { selection: string }).selection,
          ) as string[]
          const value = result ?? {
            outcome: 'verified',
            action: 'save-project-skills',
            counts: { accepted: selected.length, failed: 0, skipped: 0, uncertain: 0 },
            items: selected.map((_, index) => ({ index, status: 'accepted' })),
            originals: 'unchanged',
          }
          if (holdSave) {
            holdSave = false
            return new Promise((resolve, reject) => {
              finishSave = (other, error) =>
                error ? reject(error) : resolve(other ?? value)
            })
          }
          return value
        }
        const operation = input.input as Value
        if (operation.mode === 'list') return { ids: record ? ['pending-batch'] : [] }
        if (operation.mode === 'report')
          return { data: JSON.stringify(record), nextOffset: null }
        if (operation.mode === 'observe')
          return {
            outcome: 'observed',
            observation: 'exact-current-facts',
            message: 'Current saved skills checked.',
          }
        if (operation.mode === 'acknowledge')
          return { outcome: 'reconciled', message: 'Current facts acknowledged.' }
      }
      if (capability === 'connector.execute') {
        const args = input.args as string[],
          reviewing = args.includes('--review-manifest'),
          selected = reviewing
            ? (JSON.parse(args[args.indexOf('--select') + 1]!) as string[])
            : undefined
        if (args.includes('--cursor') && staleCursors-- > 0)
          return native.complete(
            {
              outcome: 'completed',
              code: 15,
              receipt: `view-${++serial}`,
              truncated: false,
            },
            JSON.stringify({
              schema: 'skillager.error.v1',
              error: { code: 'stale_cursor', message: 'Inventory changed.' },
            }),
          )
        if (reviewing && previewFailure) throw previewFailure
        if (!reviewing && inventoryFailure) throw inventoryFailure
        const value = selected
            ? preview(selected)
            : page(
                args.includes('--cursor')
                  ? Number(args[args.indexOf('--cursor') + 1])
                  : 0,
              ),
          output = JSON.stringify(value),
          reply = () =>
            native.complete(
              {
                outcome: 'completed',
                code: 0,
                receipt: `view-${++serial}`,
                truncated: false,
              },
              output,
            )
        if (!reviewing && holdInventory > 0) {
          holdInventory--
          return new Promise((resolve) => {
            finishInventories.push(() => resolve(reply()))
          })
        }
        if (reviewing && holdPreview) {
          holdPreview = false
          return new Promise((resolve) => {
            finishPreview = () => resolve(reply())
          })
        }
        return reply()
      }
      return undefined
    },
  }
  const module = importModule<{
    bindProjectImport(document: Document, client: unknown, ports: unknown): View
  }>('project-import-view')
  const view = module.bindProjectImport(document, client, {
    context: () => context,
    project: () => project,
    open: () => void view.open(),
    changed,
    activity,
  })
  const button = (name: string) =>
      document.getElementById(`project-import-${name}`) as HTMLButtonElement,
    checkboxes = () => [
      ...document.querySelectorAll<HTMLInputElement>('#project-import-choices input'),
    ],
    commands = () =>
      requests
        .filter((request) => request.capability === 'connector.execute')
        .map((request) => request.input.args as string[]),
    saves = () =>
      requests.filter(
        (request) =>
          request.capability === 'actions.invoke' &&
          request.input.action === 'save-project-skills',
      )
  return {
    view,
    context,
    requests,
    changed,
    activity,
    inventory,
    all,
    page,
    preview,
    button,
    checkboxes,
    commands,
    saves,
    flush: async () => {
      for (let i = 0; i < 40; i++) await Promise.resolve()
    },
    holdPreview: () => {
      holdPreview = true
    },
    previewResult: () => finishPreview?.(),
    holdInventory: (count = 1) => {
      holdInventory = count
    },
    inventoryResult: () => finishInventories.shift()?.(),
    inventoryFailure: (error?: Error) => {
      inventoryFailure = error
    },
    holdSave: () => {
      holdSave = true
    },
    saveResult: (value?: unknown, error?: Error) => finishSave?.(value, error),
    result: (value: unknown) => {
      result = value
    },
    record: (value: unknown) => {
      record = value
    },
    previewFailure: (error?: Error) => {
      previewFailure = error
    },
    staleCursors: (count = 1) => {
      staleCursors = count
    },
    scope: (value: boolean) => {
      project = value
      view.scopeChanged()
    },
    dispose: () => {
      view.dispose()
      control.abort()
    },
  }
}
