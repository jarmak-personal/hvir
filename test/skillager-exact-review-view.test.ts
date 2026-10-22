import { connectorOutputFixture } from './fixtures/connector-output'
// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { afterEach, expect, it, vi } from 'vitest'

interface FileEntry {
  path: string
  size: number
  sha256: string
  executable: boolean
}
interface Preview {
  review_manifest: {
    library_id: string
    library_root: string
    skill_id: string
    files: FileEntry[]
    file_count: number
    total_bytes: number
    working_hash: string
    confirmation_token: string
  }
  skill: { path: string; id: string; working_hash: string }
}
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})
function fixture(support = 'owned support\n') {
  const template = document.createElement('template')
  template.innerHTML = readFileSync(
    'packages/skillager-extension/management.html',
    'utf8',
  )
  for (const node of template.content.querySelectorAll('script, link')) node.remove()
  document.body.replaceChildren(template.content.cloneNode(true))
  const value = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-review.json', 'utf8'),
  ) as Preview
  const texts = new Map([
    [
      'SKILL.md',
      readFileSync('test/fixtures/skillager-management/first-review-SKILL.md', 'utf8'),
    ],
    ['support.sh', support],
  ])
  const bytes = Buffer.from(support),
    file = {
      path: 'support.sh',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      executable: true,
    }
  value.review_manifest.files.push(file)
  value.review_manifest.file_count++
  value.review_manifest.total_bytes += bytes.length
  const status = JSON.parse(
    readFileSync('test/fixtures/skillager-management/first-no-git-status.json', 'utf8'),
  ) as unknown
  const controller = new AbortController(),
    listeners = new Set<(message: unknown) => void>(),
    selected = new Map<string, FileEntry>(),
    outputs = new Map<string, unknown>()
  let serial = 0,
    visible = true,
    hold: ((error?: Error) => void) | undefined,
    holding = false
  const calls: string[] = [],
    actions: Array<{ id: string; input: unknown }> = [],
    messages: string[] = []
  const native = connectorOutputFixture()
  const client = {
    alive: true,
    signal: controller.signal,
    listen(listener: (message: unknown) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    request(capability: string, input: Record<string, unknown>) {
      calls.push(capability)
      if (capability === 'connector.execute') {
        const args = input['args'] as string[],
          receipt = `output-${++serial}`
        outputs.set(receipt, args.includes('accept') ? value : status)
        return Promise.resolve(
          native.complete(
            {
              outcome: 'completed',
              code: 0,
              receipt,
              truncated: false,
            },
            JSON.stringify(outputs.get(receipt)),
          ),
        )
      }
      if (capability === 'connector.output') return Promise.resolve(native.read(input))
      if (capability === 'source.request') return Promise.resolve({ granted: true })
      if (capability === 'source.select') {
        const path = input['path'] as { path: string },
          file = value.review_manifest.files.find((file) =>
            path.path.endsWith(`/${file.path}`),
          )!
        const receipt = `file-${++serial}`
        selected.set(receipt, file)
        return Promise.resolve({
          receipt,
          path: input['path'],
          currentFile: true,
          bytes: file.size,
          sha256: file.sha256,
        })
      }
      if (input['release']) return Promise.resolve(null)
      const file = selected.get(String(input['receipt']))!,
        data = { data: texts.get(file.path), nextOffset: null }
      if (holding) {
        holding = false
        return new Promise((resolve, reject) => {
          hold = (error) => {
            hold = undefined
            if (error) reject(error)
            else resolve(data)
          }
        })
      }
      return Promise.resolve(data)
    },
  }
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/review-view.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Module',
    write: false,
  })
  const sandbox = {
    TextEncoder,
    Uint8Array,
    crypto: webcrypto,
    atob,
    Module: undefined as unknown,
  }
  runInNewContext(bundle.outputFiles[0]!.text, sandbox)
  const module = sandbox.Module as {
    bindExactReview(
      document: Document,
      client: unknown,
      ports: unknown,
    ): { dispose(): void }
  }
  const view = module.bindExactReview(document, client, {
    context: () => ({ visible }),
    library: () => ({
      id: value.review_manifest.library_id,
      root: { hostId: 'local', path: value.review_manifest.library_root },
    }),
    say: (message: string) => messages.push(message),
    action: (id: string, input: unknown) => {
      actions.push({ id, input })
      return Promise.resolve({ outcome: 'verified' })
    },
  })
  dispose = () => {
    view.dispose()
    controller.abort()
  }
  const button = (id: string) => document.getElementById(id) as HTMLButtonElement
  const input = document.getElementById('skill-id') as HTMLInputElement
  input.value = value.skill.id
  const ready = async (message: RegExp) =>
    vi.waitFor(() => expect(messages.at(-1)).toMatch(message))
  const read = async (path: string) => {
    ;(document.querySelector(`[data-review-path="${path}"]`) as HTMLButtonElement).click()
    await vi.waitFor(() =>
      expect(document.getElementById('review-file-body')!.textContent).toBe(
        texts.get(path)!.slice(0, 32 * 1024),
      ),
    )
    expect(messages.at(-1)).toBe('')
  }
  return {
    button,
    input,
    ready,
    read,
    calls,
    actions,
    value,
    messages,
    hold: () => {
      holding = true
    },
    held: () => !!hold,
    release: (error?: Error) => hold?.(error),
    hidden: () => {
      visible = false
      for (const listener of listeners)
        listener({ kind: 'context', context: { visible: false } })
    },
    contextRow: (row: unknown) => {
      for (const listener of listeners)
        listener({ kind: 'context', context: { visible: true, input: { row } } })
    },
    revealRow: (id: string) => {
      visible = true
      input.value = id
      for (const listener of listeners)
        listener({ kind: 'context', context: { visible: true, input: { row: { id } } } })
    },
  }
}
async function completeReview(f: ReturnType<typeof fixture>) {
  f.button('start-review').click()
  await vi.waitFor(() => expect(f.button('accept-version').disabled).toBe(false))
}
it.each(['input', 'programmatic', 'context'])(
  'does not accept the former version after %s retargeting',
  async (mode) => {
    const f = fixture()
    await completeReview(f)
    if (mode === 'context') {
      f.hidden()
      f.revealRow('lib/different')
    } else {
      f.input.value = 'lib/different'
      if (mode === 'input') f.input.dispatchEvent(new Event('input'))
    }
    f.button('accept-version').dispatchEvent(new Event('click'))
    await f.ready(/Review the current version/)
    expect(f.actions).toEqual([])
    expect(f.button('accept-version').disabled).toBe(true)
  },
)
it('offers the complete file inventory and accepts once without file visits or acknowledgments', async () => {
  const f = fixture('x'.repeat(40000))
  await completeReview(f)
  expect(document.querySelectorAll('[data-review-path]')).toHaveLength(2)
  expect(f.calls).not.toContain('source.select')
  expect(f.button('accept-version').disabled).toBe(false)
  f.button('accept-version').click()
  await vi.waitFor(() => expect(f.actions).toHaveLength(1))
  expect(f.actions[0]).toMatchObject({
    id: 'accept-version',
    input: {
      hash: f.value.review_manifest.working_hash,
      token: f.value.review_manifest.confirmation_token,
    },
  })
})
it('supports complete optional file pages without changing the acceptance decision', async () => {
  const f = fixture('x'.repeat(40000))
  await completeReview(f)
  await f.read('support.sh')
  expect(document.getElementById('review-file-body')?.textContent).toHaveLength(32768)
  f.button('review-next').click()
  await vi.waitFor(() =>
    expect(document.getElementById('review-file-body')?.textContent).toHaveLength(7232),
  )
  expect(f.button('accept-version').disabled).toBe(false)
})
it('keeps prior file pages unavailable while the next selected file is loading', async () => {
  const f = fixture('previous file\n'.repeat(4000))
  await completeReview(f)
  await f.read('support.sh')
  f.hold()
  ;(document.querySelector('[data-review-path="SKILL.md"]') as HTMLButtonElement).click()
  await vi.waitFor(() => expect(f.held()).toBe(true))
  expect(document.getElementById('review-file-label')?.textContent).toMatch(/^SKILL.md/)
  for (const id of ['review-next', 'review-previous'])
    f.button(id).dispatchEvent(new Event('click'))
  expect(document.getElementById('review-file-body')?.textContent?.length).toBe(0)
  expect(document.getElementById('review-page-label')?.textContent).toBe('')
  expect(f.button('review-next').disabled).toBe(true)
  expect(f.button('review-previous').disabled).toBe(true)
  expect(f.button('accept-version').disabled).toBe(false)

  f.release()
  await f.read('SKILL.md')
  expect(document.getElementById('review-page-label')?.textContent).toBe('')
  await f.read('support.sh')
  f.button('review-next').click()
  expect(document.getElementById('review-file-body')?.textContent).toBe(
    'previous file\n'.repeat(4000).slice(32768),
  )
})
it('does not restore former file pages after a failed read and allows inspection to recover', async () => {
  const f = fixture('previous file\n'.repeat(4000))
  await completeReview(f)
  await f.read('support.sh')
  f.hold()
  ;(document.querySelector('[data-review-path="SKILL.md"]') as HTMLButtonElement).click()
  await vi.waitFor(() => expect(f.held()).toBe(true))
  f.release(new Error('Selected file read failed'))
  await f.ready(/Skillager determines acceptance eligibility/)
  for (const id of ['review-next', 'review-previous'])
    f.button(id).dispatchEvent(new Event('click'))
  expect(
    document
      .getElementById('review-file-body')
      ?.textContent?.startsWith('Preview unavailable.'),
  ).toBe(true)
  expect(document.getElementById('review-file-body')?.textContent).toContain(
    'Selected file read failed',
  )
  expect(document.getElementById('review-file-label')?.textContent).toMatch(/^SKILL.md/)
  expect(document.getElementById('review-page-label')?.textContent).toBe('')
  expect(f.button('review-next').disabled).toBe(true)
  expect(f.button('review-previous').disabled).toBe(true)
  expect(f.button('accept-version').disabled).toBe(false)
  await f.read('SKILL.md')
  expect(document.getElementById('review-page-label')?.textContent).toBe('')
})
it('refuses executable drift in the complete manifest at the one acceptance decision', async () => {
  const f = fixture()
  await completeReview(f)
  f.value.review_manifest.files[1]!.executable = false
  f.button('accept-version').click()
  await f.ready(/manifest\/token changed/)
  expect(f.actions).toEqual([])
  expect(f.button('accept-version').disabled).toBe(true)
})
it('labels unsupported previews without inventing a second acceptance policy', async () => {
  const f = fixture('binary\0content')
  await completeReview(f)
  ;(
    document.querySelector('[data-review-path="support.sh"]') as HTMLButtonElement
  ).click()
  await f.ready(/Skillager determines acceptance eligibility/)
  expect(document.getElementById('review-file-body')?.textContent).toMatch(
    /Preview unavailable.*nonimage binary/s,
  )
  expect(document.querySelectorAll('[data-review-path]')).toHaveLength(2)
  expect(f.button('accept-version').disabled).toBe(false)
})
it.each(['hidden', 'cancelled'])(
  'retires optional file pages and late reads when the review is %s',
  async (retirement) => {
    const f = fixture('previous file\n'.repeat(4000))
    await completeReview(f)
    await f.read('support.sh')
    f.hold()
    ;(
      document.querySelector('[data-review-path="SKILL.md"]') as HTMLButtonElement
    ).click()
    await vi.waitFor(() => expect(f.held()).toBe(true))
    if (retirement === 'hidden') f.hidden()
    else f.button('cancel-review').click()
    const reads = f.calls.filter((call) => call === 'source.read').length
    f.release()
    await vi.waitFor(() =>
      expect(f.calls.filter((call) => call === 'source.read').length).toBeGreaterThan(
        reads,
      ),
    )
    for (const id of ['review-next', 'review-previous'])
      f.button(id).dispatchEvent(new Event('click'))
    expect(document.getElementById('review-file-body')?.textContent?.length).toBe(0)
    expect(document.getElementById('review-file-label')?.textContent).toBe('')
    expect(document.getElementById('review-page-label')?.textContent).toBe('')
    expect(f.button('review-next').disabled).toBe(true)
    expect(f.button('review-previous').disabled).toBe(true)
    expect(f.button('accept-version').disabled).toBe(true)
    expect(f.actions).toEqual([])
  },
)

it('retains a ranked occurrence review by canonical identity and rejects a foreign same-name library', async () => {
  const f = fixture()
  await completeReview(f)
  const row = {
    id: 'ranked-occurrence',
    canonical: {
      skill_id: f.value.skill.id,
      library_id: f.value.review_manifest.library_id,
    },
  }
  f.contextRow(row)
  expect(f.button('accept-version').disabled).toBe(false)
  f.contextRow({ ...row, canonical: { ...row.canonical, library_id: 'foreign-library' } })
  expect(f.button('accept-version').disabled).toBe(true)
  f.button('accept-version').dispatchEvent(new Event('click'))
  await f.ready(/Review the current version/)
  expect(f.actions).toEqual([])
})
