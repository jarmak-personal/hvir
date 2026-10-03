import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { validateExtensionViewInput } from '../src/shared/extensions/view-input'
interface Metadata {
  requireVersion(text: string): void
  libraryStatus(value: unknown): { initialized: boolean; count: number }
  libraryPage(value: unknown): { rows: Record<string, unknown>[]; next: string | null }
  searchPage(value: unknown): { rows: Record<string, unknown>[]; next: string | null }
  searchArgs(query: string, options?: Record<string, unknown>): string[]
  detailInputFor(row: Record<string, unknown>): { row: Record<string, unknown> }
  projectInventory(value: unknown): { rows: Record<string, unknown>[]; coverage: string }
}
function metadata(): Metadata {
  const result = buildSync({
    entryPoints: ['packages/skillager-extension/src/catalog.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Metadata',
    write: false,
  })
  const context = { TextEncoder, Date, Metadata: undefined as unknown }
  runInNewContext(result.outputFiles[0]!.text, context)
  return context.Metadata as Metadata
}
const cli = metadata()
const row = {
  id: 'lib/exact',
  name: 'Exact source',
  description: 'Names/descriptions only',
  status: 'pending',
  skill_file: '/library/exact/SKILL.md',
}
describe('ordinary maintained Skillager package contract', () => {
  it('validates ready assets and declares independent source grants without agent-callable body actions', () => {
    const manifest = validateExtensionManifest(
      JSON.parse(
        readFileSync('packages/skillager-extension/hvir-extension.json', 'utf8'),
      ),
    ).manifest
    expect(manifest.id).toBe('skillager')
    expect(manifest.actions).toEqual([])
    expect(
      manifest.views.map((view) => [view.id, view.placement, view.navigation]),
    ).toEqual([
      ['library', 'application', 'top'],
      ['project', 'workspace', 'left'],
      ['detail', 'application', undefined],
    ])
    for (const view of manifest.views)
      expect(
        readFileSync(`packages/skillager-extension/${view.entry}`, 'utf8'),
      ).toContain('script')
    expect(manifest.access.map((source) => source.context)).toEqual([
      'application',
      'workspace',
    ])
  })
  it('reproduces maintained distribution assets byte for byte', () => {
    for (const [source, output] of [
      ['app', 'skillager'],
      ['updater', 'updater'],
    ]) {
      const result = buildSync({
        entryPoints: [`packages/skillager-extension/src/${source}.mjs`],
        bundle: true,
        platform: 'browser',
        format: 'iife',
        write: false,
        minify: true,
        legalComments: 'none',
        charset: 'utf8',
      })
      expect(result.outputFiles[0]!.text).toBe(
        readFileSync(`packages/skillager-extension/${output}.js`, 'utf8'),
      )
    }
    for (const file of [
      'tokens.css',
      'guest-ui.js',
      'primitives.css',
      'presentation.css',
    ])
      expect(readFileSync(`packages/skillager-extension/${file}`, 'utf8')).toBe(
        readFileSync(`src/shared/presentation/${file}`, 'utf8'),
      )
  })
  it('separates a truthful supported minimum from missing current public capability/schema', () => {
    expect(() => cli.requireVersion('skillager 0.9.3')).not.toThrow()
    expect(() => cli.requireVersion('skillager 0.9.2')).toThrow(/0.9.3/)
    expect(() => cli.libraryPage({ skills: [row] })).toThrow(/public contract/)
    expect(() =>
      cli.searchPage({
        schema: 'skillager.search.v1',
        status: 'unavailable',
        reason_code: 'installed-state-unknown',
      }),
    ).toThrow(/installed-state-unknown/)
    expect(
      cli.libraryStatus({ schema: 'skillager.library-status.v1', initialized: false }),
    ).toEqual({ initialized: false, count: 0 })
  })
  it('follows full public inventory cursors without imposing a first-page library limit', () => {
    const ids = new Set()
    for (let cursor = 0; cursor < 5000; cursor += 100) {
      const page = cli.libraryPage({
        schema: 'skillager.list.v1',
        scope: 'library',
        skills: Array.from({ length: 100 }, (_, offset) => ({
          ...row,
          id: `lib/${cursor + offset}`,
        })),
        next_cursor: cursor + 100 < 5000 ? String(cursor + 100) : null,
      })
      for (const item of page.rows) ids.add(item.id)
      expect(page.next).toBe(cursor + 100 < 5000 ? String(cursor + 100) : null)
    }
    expect(ids.size).toBe(5000)
  })
  it('keeps ranked CLI occurrences and pre-limit grouping/filter flags without replacing current Stub/Router/Full paths', () => {
    const results = ['stub', 'router-member', 'full', 'project-original', 'library'].map(
      (kind, index) => ({
        id: `lib/skill-${index}`,
        name: `Skill ${index}`,
        search: {
          occurrence: {
            id: `copy-${index}`,
            kind,
            entrypoint: `/selected/${kind}/SKILL.md`,
          },
          canonical: { library_id: 'exact-library', skill_id: `lib/skill-${index}` },
          match: { skill_id: `lib/skill-${index}` },
        },
      }),
    )
    const page = cli.searchPage({
      schema: 'skillager.search.v1',
      status: 'completed',
      results,
      next_cursor: 'next-ranked-page',
    })
    expect(page.rows.map((item) => item.path)).toEqual(
      results.map((item) => item.search.occurrence.entrypoint),
    )
    expect(page.rows.map((item) => item.id)).toEqual(
      results.map((item) => item.search.occurrence.id),
    )
    const firstSearch = cli.searchArgs('query')
    expect(firstSearch[firstSearch.indexOf('--cursor') + 1]).toBe('')
    expect(firstSearch[firstSearch.indexOf('--limit') + 1]).toBe('50')
    const args = cli.searchArgs('query', {
      cursor: 'opaque',
      includeInstalled: true,
      separateCopies: true,
      preferredAgent: 'codex',
      installedProject: '/explicit/local/project',
    })
    expect(args).toContain('--include-installed')
    expect(args).toContain('--no-session-record')
    expect(args[args.indexOf('--view') + 1]).toBe('copies')
    expect(args[args.indexOf('--cursor') + 1]).toBe('opaque')
    expect(args[args.indexOf('--installed-project') + 1]).toBe('/explicit/local/project')
  })
  it('omits large unused non-ASCII descriptions from exact bounded detail selections', () => {
    const accepted = cli.libraryPage({
      schema: 'skillager.list.v1',
      scope: 'library',
      skills: [
        {
          ...row,
          name: '📖'.repeat(100),
          description: '界'.repeat(1000),
          skill_file: `/${'x'.repeat(4000)}/SKILL.md`,
        },
      ],
      next_cursor: null,
    }).rows[0]!
    const input = cli.detailInputFor(accepted)
    expect(input.row.path).toBe(accepted.path)
    expect(input.row.source).toBe(accepted.source)
    expect(input.row.description).toBeUndefined()
    expect(() => validateExtensionViewInput(input)).not.toThrow()
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThanOrEqual(6144)
  })
  it('refuses escaped source identities outside the public byte envelope without truncating or retargeting', () => {
    expect(() =>
      cli.libraryPage({
        schema: 'skillager.list.v1',
        scope: 'library',
        skills: [{ ...row, skill_file: `/${'"'.repeat(3000)}/SKILL.md` }],
        next_cursor: null,
      }),
    ).toThrow(/encoded identity/)
    const exact = `/${'"'.repeat(1900)}/SKILL.md`
    const accepted = cli.libraryPage({
      schema: 'skillager.list.v1',
      scope: 'library',
      skills: [{ ...row, skill_file: exact }],
      next_cursor: null,
    }).rows[0]!
    const input = cli.detailInputFor(accepted)
    expect(input.row.path).toBe(exact)
    expect(() => validateExtensionViewInput(input)).not.toThrow()
  })
  it('distinguishes observed empty project metadata from exhaustive coverage and rejects mutation output', () => {
    expect(cli.projectInventory({ selected: [], action: { changed: [] } })).toEqual({
      rows: [],
      coverage: 'observed',
    })
    expect(() =>
      cli.projectInventory({ selected: [], action: { changed: ['mutation'] } }),
    ).toThrow()
  })
})

interface PackageClient {
  request(capability: string, input?: unknown): Promise<unknown>
  dispose(): void
  readonly signal: AbortSignal
}
it('cancels paced public package requests on hide and releases timers/listeners on disposal', async () => {
  vi.useFakeTimers()
  const sent: unknown[] = []
  let receive!: (message: unknown) => void
  const unsubscribe = vi.fn()
  const bundle = buildSync({
    entryPoints: ['packages/skillager-extension/src/bridge.mjs'],
    bundle: true,
    format: 'iife',
    globalName: 'Bridge',
    write: false,
  })
  const context = { Date, AbortController, Bridge: undefined as unknown }
  runInNewContext(bundle.outputFiles[0]!.text, context)
  const module = context.Bridge as {
    guestClient(bridge: unknown, clock: unknown): PackageClient
  }
  const client = module.guestClient(
    {
      onMessage(callback: typeof receive) {
        receive = callback
        return unsubscribe
      },
      send(message: unknown) {
        sent.push(message)
      },
    },
    { setTimeout, clearTimeout },
  )
  try {
    receive({ kind: 'context', context: { visible: true } })
    const first = client.request('source.read', { receipt: 'selected' }),
      second = client.request('source.read', { receipt: 'selected', offset: 2048 })
    const refusedFirst = expect(first).rejects.toThrow(/hidden/),
      refusedSecond = expect(second).rejects.toThrow(/hidden/)
    await vi.advanceTimersByTimeAsync(0)
    expect(
      sent.filter((value) => (value as { kind: string }).kind === 'request'),
    ).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    receive({ kind: 'context', context: { visible: false } })
    await refusedFirst
    await refusedSecond
    receive({ kind: 'context', context: { visible: true } })
    await vi.advanceTimersByTimeAsync(100)
    expect(
      sent.filter((value) => (value as { kind: string }).kind === 'request'),
    ).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    client.dispose()
    client.dispose()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(client.signal.aborted).toBe(true)
    await expect(client.request('source.read')).rejects.toThrow(/closed/)
  } finally {
    client.dispose()
    vi.useRealTimers()
  }
})
