// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createHash, webcrypto } from 'node:crypto'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'
import {
  importContractFixture,
  publicImportCases,
  type ImportPreview,
} from './fixtures/skillager-import'
import { importPlacementFixture } from './fixtures/skillager-import-placement'
import { connectorOutputFixture } from './fixtures/connector-output'

type Value = Record<string, unknown>
let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  document.body.replaceChildren()
})
function fixture(preview?: ImportPreview, combined = false) {
  const template = document.createElement('template')
  template.innerHTML = readFileSync('packages/skillager-extension/detail.html', 'utf8')
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  const compound = combined ? importPlacementFixture() : undefined
  const f = compound
      ? { ...compound, preview: compound.preview.import }
      : importContractFixture(preview),
    native = connectorOutputFixture(),
    calls: Array<{ capability: string; input: Value }> = []
  let serial = 0,
    visible = true,
    hold = false,
    release: (() => void) | undefined,
    failure = false,
    uncertain = false,
    actionError = false,
    heldAction = false,
    releaseAction: (() => void) | undefined
  const controller = new AbortController()
  const client = {
    alive: true,
    signal: controller.signal,
    request(capability: string, input: Value): Promise<unknown> {
      calls.push({ capability, input })
      if (capability === 'connector.output') return Promise.resolve(native.read(input))
      if (capability === 'connector.execute') {
        const output = native.complete(
          {
            outcome: 'completed',
            code: failure ? 2 : 0,
            receipt: `read-${++serial}`,
            truncated: false,
          },
          JSON.stringify(
            compound && (input['args'] as string[]).includes('--project-mode')
              ? compound.preview
              : f.preview,
          ),
          failure ? 'destination collision' : '',
        )
        if (hold)
          return new Promise((resolve) => {
            release = () => resolve(output)
          })
        return Promise.resolve(output)
      }
      if (capability === 'actions.invoke') {
        const response =
          input['action'] === 'operation-state'
            ? { ids: [] }
            : uncertain
              ? {
                  outcome: 'uncertain',
                  operationId: 'retained',
                  message: 'Inspect uncertain save.',
                }
              : {
                  outcome: 'verified',
                  message: 'Saved and accepted. Original preserved.',
                }
        if (heldAction && input['action'] !== 'operation-state')
          return new Promise((resolve, reject) => {
            releaseAction = () =>
              actionError
                ? reject(new Error('This original changed. Review again.'))
                : resolve(response)
          })
        if (actionError && input['action'] !== 'operation-state')
          return Promise.reject(new Error('This original changed. Review again.'))
        return Promise.resolve(response)
      }
      if (capability === 'source.request') return Promise.resolve({ granted: true })
      if (capability === 'source.select') {
        const text = 'Owned complete support bytes.\n'
        return Promise.resolve({
          receipt: 'source',
          currentFile: true,
          path: input['path'],
          bytes: Buffer.byteLength(text),
          sha256: createHash('sha256').update(text).digest('hex'),
        })
      }
      if (capability === 'source.read')
        return Promise.resolve(
          input['release']
            ? null
            : { data: 'Owned complete support bytes.\n', nextOffset: null },
        )
      throw new Error(`Unexpected ${capability}`)
    },
  }
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/import-view.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = { TextEncoder, crypto: webcrypto, Module: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const module = sandbox.Module as {
    bindSelectedImport(
      document: unknown,
      client: unknown,
      ports: unknown,
    ): {
      select(value: unknown, options?: unknown): void
      preserved(value: unknown): void
      contextChanged(): void
      visibilityChanged(): void
      dispose(): void
    }
  }
  const changed = vi.fn(),
    activity = vi.fn()
  const view = module.bindSelectedImport(document, client, {
    context: () => ({ visible, workspace: f.workspace }),
    changed,
    activity,
  })
  stop = () => {
    view.dispose()
    controller.abort()
  }
  const row = {
    source: 'project',
    kind: 'Project original',
    host: 'local',
    workspaceId: f.workspace.id,
    agent: compound?.input.agent ?? 'codex',
    skillId: f.input.skillId,
    path: f.input.file.path,
  }
  view.select({ row }, compound ? { mode: compound.input.mode } : undefined)
  return {
    ...f,
    row,
    calls,
    view,
    changed,
    activity,
    holdAction: () => {
      heldAction = true
    },
    releaseAction: () => releaseAction?.(),
    hide: () => {
      visible = false
      view.visibilityChanged()
    },
    show: () => {
      visible = true
      view.visibilityChanged()
    },
    hold: () => {
      hold = true
    },
    release: () => release?.(),
    fail: () => {
      failure = true
    },
    uncertain: () => {
      uncertain = true
    },
    refuseAction: () => {
      actionError = true
    },
    preservation: {
      file: f.input.file,
      sources: [
        {
          library_id: f.preview.review_manifest.library.library_id,
          skill_id: f.preview.review_manifest.destination_id,
        },
      ],
    },
  }
}
const button = (id: string) => document.getElementById(id) as HTMLButtonElement
const ready = () => vi.waitFor(() => expect(button('import-save').disabled).toBe(false))
it('offers a complete optional inventory and one human Save and accept without file acknowledgments', async () => {
  const f = fixture()
  await ready()
  expect(document.querySelectorAll('#import-files [data-review-path]')).toHaveLength(2)
  expect(document.getElementById('import-effect')!.textContent).toMatch(
    /Original stays unchanged/,
  )
  button('import-save').click()
  await vi.waitFor(() =>
    expect(
      f.calls.filter(
        (call) =>
          call.capability === 'actions.invoke' &&
          call.input['action'] === 'save-and-accept',
      ),
    ).toHaveLength(1),
  )
  expect(f.calls.some((call) => call.capability === 'source.select')).toBe(false)
  const action = f.calls.find((call) => call.input['action'] === 'save-and-accept')!
  expect(action.input['input']).toEqual(f.input)
})
it('carries the exact public Unicode occurrence and chosen name through refresh and one Save and accept', async () => {
  const f = fixture(publicImportCases()[0]!.preview)
  await ready()
  const name = document.getElementById('import-name') as HTMLInputElement
  name.value = f.input.name
  name.dispatchEvent(new Event('input', { bubbles: true }))
  expect(button('import-save').disabled).toBe(true)
  button('import-refresh').click()
  await ready()
  expect(document.getElementById('import-destination')!.textContent).toBe(
    f.preview.destination.id,
  )
  button('import-save').click()
  await vi.waitFor(() =>
    expect(
      f.calls.filter((call) => call.input['action'] === 'save-and-accept'),
    ).toHaveLength(1),
  )
  const reads = f.calls.filter((call) => call.capability === 'connector.execute')
  for (const read of reads.slice(-2))
    expect(read.input['args']).toEqual(f.preview.next_command_argv.slice(1, -3))
  expect(
    f.calls.find((call) => call.input['action'] === 'save-and-accept')!.input['input'],
  ).toEqual(f.input)
})
it('inspects the external file through the independently granted exact project source', async () => {
  const f = fixture()
  await ready()
  const instructions = document.getElementById('instructions')!
  instructions.textContent = 'Original instruction reading'
  instructions.scrollTop = 42
  button('import-inspect').click()
  expect(button('import-inspect').getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById('import-inspection')!.hidden).toBe(false)
  ;(
    document.querySelector('[data-review-path="support.txt"]') as HTMLButtonElement
  ).click()
  await vi.waitFor(() =>
    expect(document.getElementById('import-file-body')!.textContent).toBe(
      'Owned complete support bytes.\n',
    ),
  )
  button('import-inspect').click()
  expect(document.getElementById('import-inspection')!.hidden).toBe(true)
  expect(button('import-inspect').getAttribute('aria-expanded')).toBe('false')
  expect(instructions.textContent).toBe('Original instruction reading')
  expect(instructions.scrollTop).toBe(42)
  expect(f.calls.find((call) => call.capability === 'source.request')!.input).toEqual({
    source: 'project',
  })
  expect(
    f.calls.find((call) => call.capability === 'source.select')!.input,
  ).toMatchObject({
    source: 'project',
    workspaceId: f.workspace.id,
    path: { hostId: 'local', path: `${f.preview.source.path}/support.txt` },
  })
})
it('makes actual initialization effects visible without creating a library during selection', async () => {
  const f = fixture()
  f.preview.library.status = f.preview.review_manifest.library.status = 'will-initialize'
  f.preview.review_manifest.library.library_id = null
  await ready()
  button('import-refresh').click()
  await ready()
  expect(document.getElementById('import-effect')!.textContent).toContain(
    'Creates your personal library',
  )
  expect(f.calls.some((call) => call.input['action'] === 'save-and-accept')).toBe(false)
})
it('cancel leaves the original unsaved and changed complete manifest prevents dispatch', async () => {
  const f = fixture()
  await ready()
  button('import-cancel').click()
  expect(button('import-save').disabled).toBe(true)
  button('import-refresh').click()
  await ready()
  f.preview.review_manifest = structuredClone(f.preview.review_manifest)
  f.preview.review_manifest.files[1]!.executable = true
  button('import-save').click()
  await vi.waitFor(() =>
    expect(document.getElementById('import-state')!.textContent).toMatch(
      /changed after reading/,
    ),
  )
  expect(f.calls.some((call) => call.input['action'] === 'save-and-accept')).toBe(false)
})
it('does not revive or dispatch from a late preview after context hiding', async () => {
  const f = fixture()
  await ready()
  f.hold()
  button('import-refresh').click()
  await vi.waitFor(() => expect(button('import-refresh').disabled).toBe(true))
  f.hide()
  f.release()
  await vi.waitFor(() => expect(button('import-refresh').disabled).toBe(false))
  expect(button('import-save').disabled).toBe(true)
  expect(f.calls.some((call) => call.input['action'] === 'save-and-accept')).toBe(false)
})
it('shows a collision refusal without enabling overwrite', async () => {
  const f = fixture()
  await ready()
  f.fail()
  button('import-refresh').click()
  await vi.waitFor(() =>
    expect(document.getElementById('import-state')!.textContent).toContain(
      'destination collision',
    ),
  )
  expect(button('import-save').disabled).toBe(true)
})

it('names the separate destination decision for a structured exit-zero collision', async () => {
  const f = fixture()
  await ready()
  f.preview.destination.exists = true
  button('import-refresh').click()
  await vi.waitFor(() =>
    expect(document.getElementById('import-state')!.textContent).toContain(
      'Choose a different Library name',
    ),
  )
  expect(button('import-save').disabled).toBe(true)
  expect(f.calls.some((call) => call.input['action'] === 'save-and-accept')).toBe(false)
})

it('presents validated exact preservation without a resolved save collision or rename controls', async () => {
  const f = fixture()
  await ready()
  f.fail()
  button('import-refresh').click()
  await vi.waitFor(() =>
    expect(document.getElementById('import-state')!.textContent).toContain(
      'destination collision',
    ),
  )
  f.view.preserved(f.preservation)
  expect(document.getElementById('import-destination')!.textContent).toBe(
    'Saved in library',
  )
  expect(document.getElementById('import-effect')!.textContent).toBe(
    'Original unchanged.',
  )
  expect(document.getElementById('import-state')!.textContent).toBe('')
  expect(button('import-save').hidden).toBe(true)
  expect(document.getElementById('import-options')!.hidden).toBe(true)
  expect(f.calls.some((call) => call.input['action'] === 'save-and-accept')).toBe(false)
  f.view.preserved(undefined)
  expect(button('import-save').hidden).toBe(false)
  expect(document.getElementById('import-state')!.textContent).toContain(
    'destination collision',
  )
})

it('never borrows another original or stale context preservation to claim saved', async () => {
  const f = fixture()
  await ready()
  f.view.preserved({
    ...f.preservation,
    file: { ...f.input.file, path: '/other/SKILL.md' },
  })
  expect(button('import-save').hidden).toBe(false)
  f.view.preserved({ ...f.preservation, file: { ...f.input.file, hostId: 'other-host' } })
  expect(button('import-save').hidden).toBe(false)
  f.view.preserved(f.preservation)
  expect(button('import-save').hidden).toBe(true)
  f.hide()
  expect(button('import-save').hidden).toBe(false)
  expect(document.getElementById('import-destination')!.textContent).not.toBe(
    'Saved in library',
  )
})

it('keeps an uncertain import visible even when current public preservation exists', async () => {
  const f = fixture()
  await ready()
  f.uncertain()
  button('import-save').click()
  await vi.waitFor(() => expect(button('import-reconcile').hidden).toBe(false))
  f.view.preserved(f.preservation)
  expect(button('import-save').hidden).toBe(false)
  expect(document.getElementById('import-state')!.textContent).toBe(
    'Inspect uncertain save.',
  )
  expect(button('import-reconcile').hidden).toBe(false)
})

it('prepares Stub directly with one complete preview and one human confirmation', async () => {
  const f = fixture(undefined, true)
  await ready()
  const reads = () => f.calls.filter((call) => call.capability === 'connector.execute')
  expect(reads()).toHaveLength(1)
  expect(reads()[0]!.input['args']).toContain('--project-mode')
  expect(button('import-save').textContent).toBe('Save and use Stub')
  expect(document.getElementById('import-effects')!.textContent).toContain('helper.sh')
  expect(f.calls.some((call) => call.input['action'] === 'save-and-use-copy')).toBe(false)
  button('import-save').click()
  await vi.waitFor(() =>
    expect(
      f.calls.filter((call) => call.input['action'] === 'save-and-use-copy'),
    ).toHaveLength(1),
  )
  expect(reads()).toHaveLength(1)
  expect(
    reads().every((call) => (call.input['args'] as string[]).includes('--project-mode')),
  ).toBe(true)
  expect(
    f.calls.find((call) => call.input['action'] === 'save-and-use-copy')!.input['input'],
  ).toMatchObject({
    mode: 'stub',
    agent: 'codex',
    hash: f.input.hash,
    token: f.input.token,
  })
})
it('cancels a combined task without requesting acceptance or replacement', async () => {
  const f = fixture(undefined, true)
  await ready()
  button('import-cancel').click()
  button('import-save').click()
  expect(f.calls.some((call) => call.input['action'] === 'save-and-use-copy')).toBe(false)
  expect(button('import-save').disabled).toBe(true)
})
it('rejects combined late preparation after hiding the originating task', async () => {
  const f = fixture(undefined, true)
  await ready()
  f.hold()
  button('import-refresh').click()
  await vi.waitFor(() => expect(button('import-save').disabled).toBe(true))
  f.hide()
  f.release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(button('import-save').disabled).toBe(true)
  expect(f.calls.some((call) => call.input['action'] === 'save-and-use-copy')).toBe(false)
})

it('shows immediate progress and reports uncertain completion to the origin without claiming a saved result', async () => {
  const f = fixture(undefined, true)
  await ready()
  f.uncertain()
  f.holdAction()
  button('import-save').click()
  expect(button('import-save').textContent).toBe('Saving…')
  expect(document.getElementById('selected-import')!.getAttribute('aria-busy')).toBe(
    'true',
  )
  expect(f.changed).not.toHaveBeenCalled()
  f.releaseAction()
  await vi.waitFor(() =>
    expect(f.changed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'uncertain' }),
      expect.objectContaining({ id: 'compound-project', host: 'local' }),
    ),
  )
  expect(button('import-reconcile').hidden).toBe(false)
  expect(document.getElementById('selected-import')!.getAttribute('aria-busy')).toBe(
    'false',
  )
})

it('notifies the current origin after a public action error without fabricating a result', async () => {
  const f = fixture(undefined, true)
  await ready()
  f.refuseAction()
  button('import-save').click()
  await vi.waitFor(() =>
    expect(f.changed).toHaveBeenCalledExactlyOnceWith(
      undefined,
      expect.objectContaining({ id: 'compound-project', host: 'local' }),
      expect.objectContaining({ message: 'This original changed. Review again.' }),
    ),
  )
  expect(document.getElementById('import-state')!.textContent).toContain(
    'This original changed. Review again.',
  )
  expect(document.getElementById('import-result')!.textContent).toBe('')
  expect(document.getElementById('selected-import')!.getAttribute('aria-busy')).toBe(
    'false',
  )
  expect(button('import-save').disabled).toBe(true)
  expect(button('import-reconcile').hidden).toBe(true)
})

it('retains an admitted import result after hiding without reviving its preview authority', async () => {
  const f = fixture(undefined, true)
  await ready()
  f.holdAction()
  button('import-save').click()
  expect(f.activity).toHaveBeenLastCalledWith(true)
  f.hide()
  f.releaseAction()
  await vi.waitFor(() =>
    expect(f.changed).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'verified' }),
      f.workspace,
    ),
  )
  expect(f.activity).toHaveBeenLastCalledWith(false)
  expect(document.getElementById('import-result')!.textContent).toContain('verified')
  expect(button('import-save').disabled).toBe(true)
})

it.each([false, true])(
  'retains hidden compound uncertainty after partial replacement (show before settlement=%s)',
  async (showBefore) => {
    const f = fixture(undefined, true)
    await ready()
    f.uncertain()
    f.holdAction()
    button('import-save').click()
    expect(f.activity).toHaveBeenLastCalledWith(true)
    f.hide()
    const previews = f.calls.filter(
      (call) => call.capability === 'connector.execute',
    ).length
    // The original may already have been replaced; restoration must not preview it again.
    f.preview.source.path = '/already-replaced'
    if (showBefore) {
      f.show()
      expect(f.activity).toHaveBeenLastCalledWith(true)
    }
    f.releaseAction()
    await vi.waitFor(() => expect(f.activity).toHaveBeenLastCalledWith(false))
    if (!showBefore) f.show()
    expect(button('import-reconcile').hidden).toBe(false)
    expect(button('import-save').disabled).toBe(true)
    expect(document.getElementById('import-result')!.textContent).toContain('retained')
    expect(document.getElementById('import-state')!.textContent).toBe(
      'Inspect uncertain save.',
    )
    expect(
      f.calls.filter((call) => call.capability === 'connector.execute'),
    ).toHaveLength(previews)
    expect(
      f.calls.filter((call) => call.input['action'] === 'save-and-use-copy'),
    ).toHaveLength(1)
  },
)
it.each([false, true])(
  'retains a hidden submitted CLI refusal (show before settlement=%s)',
  async (showBefore) => {
    const f = fixture(undefined, true)
    await ready()
    f.refuseAction()
    f.holdAction()
    button('import-save').click()
    f.hide()
    if (showBefore) f.show()
    f.releaseAction()
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledOnce())
    expect(f.changed).toHaveBeenCalledWith(
      undefined,
      f.workspace,
      expect.objectContaining({ message: 'This original changed. Review again.' }),
    )
    if (!showBefore) f.show()
    expect(
      f.calls.filter((call) => call.input['action'] === 'save-and-use-copy'),
    ).toHaveLength(1)
  },
)
