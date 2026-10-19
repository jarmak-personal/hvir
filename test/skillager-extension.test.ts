import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { buildSync } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'
import { validateExtensionManifest } from '../src/shared/extensions/manifest'
import { validateExtensionViewInput } from '../src/shared/extensions/view-input'
interface Metadata {
  isCanonicalSkillId(value: unknown): boolean
  requireVersion(text: string): void
  libraryStatus(value: unknown): { initialized: boolean; count: number }
  libraryPage(value: unknown): { rows: Record<string, unknown>[]; next: string | null }
  searchPage(
    value: unknown,
    workspace?: Record<string, unknown>,
  ): { rows: Record<string, unknown>[]; next: string | null }
  searchArgs(query: string, options?: Record<string, unknown>): string[]
  detailInputFor(row: Record<string, unknown>): { row: Record<string, unknown> }
  projectInventory(
    value: unknown,
    workspace?: Record<string, unknown>,
  ): { rows: Record<string, unknown>[]; coverage: string }
}
function metadata(): Metadata {
  const result = buildSync({
    stdin: {
      contents: `export * from './packages/skillager-extension/src/catalog.mjs';
      export { isCanonicalSkillId } from './packages/skillager-extension/src/public-metadata.mjs';`,
      resolveDir: process.cwd(),
    },
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
const workspace = {
  id: 'workspace',
  host: 'local',
  root: { hostId: 'local', path: '/selected' },
}
const row = {
  id: 'lib/exact',
  name: 'Exact source',
  description: 'Names/descriptions only',
  status: 'pending',
  skill_file: '/library/exact/SKILL.md',
}
describe('ordinary maintained Skillager package contract', () => {
  it('retains exact public Unicode canonical identities without normalization', () => {
    for (const skill_id of ['lib/保存-𐐨-１２', `lib/${'𐐨'.repeat(64)}`, 'lib/café']) {
      expect(cli.isCanonicalSkillId(skill_id)).toBe(true)
      const canonical = { library_id: '7872ddf0-5e50-4bce-a032-c0fa6eac38a3', skill_id }
      expect(
        cli.detailInputFor({ ...row, host: 'local', source: 'library', canonical }).row[
          'canonical'
        ],
      ).toEqual(canonical)
    }
  })
  it('rejects malformed and over-bound canonical names rather than repairing identity', () => {
    for (const id of [
      null,
      '',
      'lib/',
      'lib/../x',
      'lib/a/b',
      'lib/a\\b',
      'lib/a\u0000b',
      'lib/a\nb',
      'lib/a\u202eb',
      'lib/A',
      'lib/-a',
      'lib/a-',
      'lib/a--b',
      'lib/a_b',
      'lib/a.b',
      'lib/cafe\u0301',
      `lib/${'𐐨'.repeat(65)}`,
    ])
      expect(cli.isCanonicalSkillId(id), String(id)).toBe(false)
  })
  it('validates ready assets and declares independent source grants without agent-callable body actions', () => {
    const manifest = validateExtensionManifest(
      JSON.parse(
        readFileSync('packages/skillager-extension/hvir-extension.json', 'utf8'),
      ),
    ).manifest
    expect(manifest.id).toBe('skillager')
    expect(manifest.railItems ?? []).toEqual([])
    expect(manifest.updater).toBeUndefined()
    expect(
      manifest.connectors?.find((connector) => connector.id === 'project-cli')?.setup,
    ).toEqual({ executable: 'skillager' })
    expect(manifest.requiredCapabilities).not.toContain('contributions.publish')
    expect(manifest.views.find((view) => view.id === 'project')?.navigationIcon).toBe(
      'skillager.svg',
    )
    expect(manifest.actions?.some((action) => /body|instruction/iu.test(action.id))).toBe(
      false,
    )
    expect(
      manifest.views.map((view) => [view.id, view.placement, view.navigation]),
    ).toEqual([
      ['library', 'application', 'top'],
      ['project', 'workspace', 'left'],
      ['detail', 'application', undefined],
      ['management', 'application', undefined],
    ])
    for (const view of manifest.views)
      expect(
        readFileSync(`packages/skillager-extension/${view.entry}`, 'utf8'),
      ).toContain('script')
    expect(manifest.access.map((source) => [source.context, source.mode])).toEqual([
      ['application', 'read-only'],
      ['workspace', 'read-only'],
      ['application', 'delivery-source'],
      ['workspace', 'managed-delivery'],
    ])
  })
  it('reproduces maintained distribution assets byte for byte', () => {
    for (const [source, output] of [
      ['app', 'skillager'],
      ['operations', 'operations'],
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
    const page = cli.searchPage(
      {
        schema: 'skillager.search.v1',
        status: 'completed',
        results,
        next_cursor: 'next-ranked-page',
        context: { project_root: '/selected', installed_observation: 'observed' },
      },
      workspace,
    )
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
  it('pins local occurrences and detail identity instead of relabeling them to SSH or accepting unscoped installed sources', () => {
    const response = {
      schema: 'skillager.search.v1',
      status: 'completed',
      next_cursor: null,
      context: { project_root: '/selected', installed_observation: 'observed' },
      results: [
        {
          id: 'lib/exact',
          search: {
            occurrence: {
              id: 'copy',
              kind: 'stub',
              entrypoint: '/selected/stub/SKILL.md',
            },
          },
        },
      ],
    }
    expect(() => cli.searchPage(response)).toThrow(/unknown/)
    expect(() => cli.searchPage(response, { ...workspace, host: 'ssh' })).toThrow(
      /unknown/,
    )
    expect(() =>
      cli.searchPage(response, {
        ...workspace,
        root: { hostId: 'local', path: '/different' },
      }),
    ).toThrow(/match/)
    const row = cli.searchPage(response, workspace).rows[0]!
    expect(cli.detailInputFor(row).row).toMatchObject({
      host: 'local',
      workspaceId: 'workspace',
      path: '/selected/stub/SKILL.md',
    })
    response.results[0]!.search.occurrence.kind = 'library'
    const library = cli.searchPage(response, { ...workspace, host: 'ssh' }).rows[0]!
    expect(cli.detailInputFor(library).row).toMatchObject({
      host: 'local',
      source: 'library',
    })
    expect(cli.detailInputFor(library).row.workspaceId).toBeUndefined()
    const unknown = cli.searchArgs('query', { includeInstalled: false })
    expect(unknown).toContain('--include-installed')
    expect(unknown).not.toContain('--installed-project')
    const exact = cli.searchArgs('query', {
      includeInstalled: false,
      installedProject: '/selected',
    })
    expect(exact).not.toContain('--include-installed')
    expect(exact[exact.indexOf('--installed-project') + 1]).toBe('/selected')
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
  it('requires the current public project inventory envelope and its exact selected root', () => {
    const empty = {
      schema: 'skillager.list.v1',
      scope: 'project',
      project_root: '/selected',
      observation: { status: 'complete', errors: [], error_count: 0 },
      skills: [],
      next_cursor: null,
    }
    expect(cli.projectInventory(empty, workspace)).toMatchObject({
      rows: [],
      coverage: 'complete',
      next: null,
    })
    for (const data of [
      { selected: [], action: { changed: [] } },
      { ...empty, scope: 'library' },
      { ...empty, project_root: '/other' },
      { ...empty, next_cursor: undefined },
      { ...empty, observation: { status: 'complete', errors: [], error_count: 1 } },
      { ...empty, observation: { status: 'partial', errors: [], error_count: 0 } },
      { ...empty, observation: { status: 'unavailable', errors: [], error_count: 1 } },
    ])
      expect(() => cli.projectInventory(data, workspace)).toThrow()
    expect(() => cli.projectInventory(empty, { ...workspace, host: 'ssh' })).toThrow()
  })
  it.each(['full', 'stub', 'router'])(
    'keeps the authoritative current %s copy separate from its canonical source',
    (kind) => {
      const row = {
        id: kind === 'router' ? 'router/example' : 'lib/example',
        occurrence_id: `managed-${kind}`,
        name: 'Managed copy',
        description: '',
        status: 'present',
        trust: null,
        kind,
        skill_file: `/selected/.agents/skills/${kind}/SKILL.md`,
        native: { scope: 'project', managed: true, agent: 'codex' },
        exposure: {
          schema: 'skillager.exposure.v1',
          exposure_id: `selected-${kind}`,
          skill_id: kind === 'router' ? 'router/example' : 'lib/example',
          scope: 'project',
          agent: 'codex',
          mode: kind === 'full' ? 'native' : kind,
          target: `/selected/.agents/skills/${kind}`,
          ...(kind === 'router'
            ? {
                member_sources: Array.from({ length: 500 }, (_, index) => ({
                  skill_id: `project/member-${index}`,
                  source_library_id: null,
                })),
              }
            : {
                source_library_id: '720e24b1-53e0-45f6-a84e-3df65177b38c',
              }),
        },
      }
      const data = {
        schema: 'skillager.list.v1',
        scope: 'project',
        project_root: '/selected',
        observation: { status: 'complete', errors: [], error_count: 0 },
        skills: [row],
        next_cursor: null,
      }
      const [current] = cli.projectInventory(data, workspace).rows
      expect(current).toMatchObject({
        id: row.occurrence_id,
        path: row.skill_file,
        status: 'present',
      })
      expect(current?.canonical).toEqual(
        kind === 'router'
          ? null
          : {
              library_id: '720e24b1-53e0-45f6-a84e-3df65177b38c',
              skill_id: 'lib/example',
            },
      )
      const selected = cli.detailInputFor(current!).row
      expect(selected).toMatchObject({
        id: row.occurrence_id,
        skillId: row.id,
        path: row.skill_file,
        workspaceId: workspace.id,
        exposure: {
          exposure_id: row.exposure.exposure_id,
          skill_id: row.id,
          target: row.exposure.target,
          agent: 'codex',
          scope: 'project',
          mode: row.exposure.mode,
          ...(kind === 'router'
            ? {}
            : { source_library_id: '720e24b1-53e0-45f6-a84e-3df65177b38c' }),
        },
      })
      expect(selected.exposure).not.toHaveProperty('member_sources')
      expect(() => validateExtensionViewInput({ row: selected })).not.toThrow()
      if (kind === 'router') {
        expect(selected.canonical).toBeUndefined()
        expect(selected.exposure).not.toHaveProperty('source_library_id')
      } else {
        const unknown = cli.projectInventory(
          {
            ...data,
            skills: [{ ...row, exposure: { ...row.exposure, source_library_id: null } }],
          },
          workspace,
        ).rows[0]!
        expect(cli.detailInputFor(unknown).row.exposure).toMatchObject({
          source_library_id: null,
        })
        expect(cli.detailInputFor(unknown).row.canonical).toBeUndefined()
      }
      const second = {
        ...row,
        occurrence_id: `second-${kind}`,
        skill_file: `/selected/.agents/skills/second-${kind}/SKILL.md`,
        exposure: {
          ...row.exposure,
          exposure_id: `second-${kind}`,
          target: `/selected/.agents/skills/second-${kind}`,
        },
      }
      const copies = cli.projectInventory({ ...data, skills: [row, second] }, workspace)
      expect(copies.rows.map((copy) => cli.detailInputFor(copy).row)).toMatchObject([
        { id: row.occurrence_id, exposure: { exposure_id: row.exposure.exposure_id } },
        {
          id: second.occurrence_id,
          exposure: { exposure_id: second.exposure.exposure_id },
        },
      ])
      for (const changed of [
        { agent: 'claude' },
        { exposure_id: null },
        { skill_id: 'lib/other' },
        { target: '/selected/other' },
        { schema: 'unknown' },
      ])
        expect(() =>
          cli.projectInventory(
            { ...data, skills: [{ ...row, exposure: { ...row.exposure, ...changed } }] },
            workspace,
          ),
        ).toThrow()
    },
  )
  it('preserves distinct occurrence identity, current paths, and pending or blocked metadata', () => {
    const original = {
      id: 'project/example',
      name: 'Same name',
      description: 'Observed metadata',
      kind: 'native',
      native: { scope: 'project', managed: false, agent: null },
      exposure: null,
    }
    const skills = ['pending', 'blocked', 'lint_blocked', 'accepted'].map(
      (status, i) => ({
        ...original,
        id: `project/example-${i}`,
        occurrence_id: `occurrence-${i}`,
        status,
        skill_file: `/selected/.agents/skills/example-${i}/SKILL.md`,
      }),
    )
    const page = {
      schema: 'skillager.list.v1',
      scope: 'project',
      project_root: '/selected',
      observation: { status: 'complete', errors: [], error_count: 0 },
      skills,
      next_cursor: null,
    }
    const rows = cli.projectInventory(page, workspace).rows
    expect(rows.map((item) => item.id)).toEqual(skills.map((item) => item.occurrence_id))
    expect(rows.map((item) => item.path)).toEqual(skills.map((item) => item.skill_file))
    expect(rows.map((item) => item.status)).toEqual([
      'pending',
      'blocked',
      'lint_blocked',
      'accepted',
    ])
    const aliasTarget = '/selected/.agents/skills/example-0/instructions.md'
    expect(
      cli.projectInventory(
        {
          ...page,
          skills: [{ ...skills[0], status: 'lint_blocked', skill_file: aliasTarget }],
        },
        workspace,
      ).rows[0]?.path,
    ).toBe(aliasTarget)
    for (const change of [
      { skill_file: '/selected-other/SKILL.md' },
      { skill_file: '/selected/../other/SKILL.md' },
      { native: { scope: 'global', managed: false } },
      { native: { scope: 'project', managed: true } },
      { kind: 'library' },
      { status: 'trusted' },
    ])
      expect(() =>
        cli.projectInventory(
          { ...page, skills: [{ ...skills[0], ...change }] },
          workspace,
        ),
      ).toThrow()
    expect(() =>
      cli.projectInventory({ ...page, skills: [skills[0], skills[0]] }, workspace),
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
    { setTimeout, clearTimeout, performance },
  )
  try {
    receive({ kind: 'context', context: { visible: true } })
    for (let index = 0; index < 23; index++) {
      const completed = client.request('source.read', { receipt: 'selected' })
      await vi.advanceTimersByTimeAsync(0)
      const request = sent.at(-1) as { id: string }
      receive({ kind: 'result', id: request.id, ok: true, value: null })
      await completed
    }
    sent.length = 0
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
    await vi.advanceTimersByTimeAsync(1049)
    expect(
      sent.filter((value) => (value as { kind: string }).kind === 'cancel'),
    ).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(
      sent.filter((value) => (value as { kind: string }).kind === 'request'),
    ).toHaveLength(1)
    expect(
      sent.filter((value) => (value as { kind: string }).kind === 'cancel'),
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
