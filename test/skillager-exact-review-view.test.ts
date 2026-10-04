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
    hold: (() => void) | undefined,
    holding = false
  const calls: string[] = [],
    actions: Array<{ id: string; input: unknown }> = [],
    messages: string[] = []
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
        return Promise.resolve({
          outcome: 'completed',
          code: 0,
          receipt,
          truncated: false,
        })
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
        return new Promise((resolve) => {
          hold = () => resolve(data)
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
    await ready(/complete supported bytes verified/)
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
    release: () => hold?.(),
    hidden: () => {
      visible = false
      for (const listener of listeners)
        listener({ kind: 'context', context: { visible: false } })
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
  await f.ready(/manifest loaded/)
  for (const path of ['SKILL.md', 'support.sh']) {
    await f.read(path)
    f.button('acknowledge-file').click()
    await f.ready(/acknowledged/)
  }
  f.button('prepare-acceptance').click()
  await f.ready(/fresh complete manifest\/token matches/)
}
it.each(['input', 'programmatic', 'context'])(
  'cannot prepare or accept an old complete review after %s retargeting',
  async (mode) => {
    const f = fixture()
    await completeReview(f)
    const before = f.calls.length
    if (mode === 'context') {
      f.hidden()
      f.revealRow('lib/different')
    } else {
      f.input.value = 'lib/different'
      if (mode === 'input') f.input.dispatchEvent(new Event('input'))
    }
    f.button('prepare-acceptance').click()
    await f.ready(/Read and acknowledge every/)
    f.button('accept-version').dispatchEvent(new Event('click'))
    await f.ready(/Prepare one fresh exact/)
    expect(f.calls).toHaveLength(before)
    expect(f.actions).toEqual([])
    expect(f.button('accept-version').disabled).toBe(true)
    f.revealRow(f.value.skill.id)
    f.button('prepare-acceptance').click()
    await f.ready(/Read and acknowledge every/)
    expect(f.actions).toEqual([])
  },
)
it('requires every complete file/page acknowledgment and fresh identical manifest before human acceptance', async () => {
  const f = fixture('x'.repeat(40000))
  f.button('start-review').click()
  await f.ready(/manifest loaded/)
  expect(f.calls).not.toContain('source.select')
  expect(document.querySelectorAll('[data-review-path]')).toHaveLength(2)
  f.button('prepare-acceptance').click()
  await f.ready(/Read and acknowledge every/)
  expect(f.button('accept-version').disabled).toBe(true)
  await f.read('SKILL.md')
  f.button('acknowledge-file').click()
  await f.ready(/1 of 2/)
  await f.read('support.sh')
  expect(f.button('acknowledge-file').disabled).toBe(true)
  f.button('review-next').click()
  await vi.waitFor(() => expect(f.button('acknowledge-file').disabled).toBe(false))
  f.button('acknowledge-file').click()
  await f.ready(/2 of 2/)
  f.button('prepare-acceptance').click()
  await f.ready(/fresh complete manifest\/token matches/)
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
it('refuses executable drift after complete human reads and never sends acceptance', async () => {
  const f = fixture()
  f.button('start-review').click()
  await f.ready(/manifest loaded/)
  for (const path of ['SKILL.md', 'support.sh']) {
    await f.read(path)
    f.button('acknowledge-file').click()
    await f.ready(/acknowledged/)
  }
  f.value.review_manifest.files[1]!.executable = false
  f.button('prepare-acceptance').click()
  await f.ready(/manifest\/token changed after reading/)
  expect(f.button('accept-version').disabled).toBe(true)
  expect(f.actions).toEqual([])
})
it('keeps unsupported binary in the complete manifest and refuses readiness with an achievable route', async () => {
  const f = fixture('binary\0content')
  f.button('start-review').click()
  await f.ready(/manifest loaded/)
  ;(
    document.querySelector('[data-review-path="support.sh"]') as HTMLButtonElement
  ).click()
  await f.ready(/support.sh:.*nonimage binary.*public Skillager CLI/)
  expect(document.querySelectorAll('[data-review-path]')).toHaveLength(2)
  expect(f.button('accept-version').disabled).toBe(true)
  expect(f.actions).toEqual([])
})
it('rejects held read after hide and clears prepared authority when the selected skill field changes', async () => {
  const f = fixture()
  f.button('start-review').click()
  await f.ready(/manifest loaded/)
  f.hold()
  ;(document.querySelector('[data-review-path="SKILL.md"]') as HTMLButtonElement).click()
  await vi.waitFor(() => expect(f.calls).toContain('source.read'))
  f.hidden()
  f.release()
  await f.ready(/partial or hidden/)
  expect(f.button('acknowledge-file').disabled).toBe(true)
  f.input.value = 'lib/different'
  f.input.dispatchEvent(new Event('input'))
  expect(f.button('accept-version').disabled).toBe(true)
  expect(f.actions).toEqual([])
})
