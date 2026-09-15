import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { SkillagerReviewOwner } from '../src/main/skillager/skillager-review-owner'
import { joinHostPath, localPath } from '../src/shared/host-path'
import type { SkillagerContentRequest } from '../src/shared/skillager-content'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'

async function fixture(kind: 'library' | 'project-original', accepted = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-document-adapter-')))
  const host = new LocalHost()
  const library = {
    id: '4f0467b4-bf3e-4c85-a11e-aac0f6071398',
    root: localPath(join(root, 'library')),
    skillsRoot: localPath(join(root, 'library/skills')),
  }
  const workspace = localPath(join(root, 'project'))
  const relocated = {
    ...library,
    root: localPath(join(root, 'relocated')),
    skillsRoot: localPath(join(root, 'relocated/skills')),
  }
  const skill = joinHostPath(
    kind === 'library' ? library.skillsRoot : workspace,
    'example',
  )
  const body = '# Literal selected body\n'
  const request: SkillagerContentRequest = {
    connectionId: 'connection',
    requestId: 1,
    agent: 'codex',
    workspaceRoot: workspace,
    selection: {
      kind,
      skillId: kind === 'library' ? 'lib/example' : 'project/example',
      root: skill,
      path: joinHostPath(skill, 'SKILL.md'),
      libraryId: kind === 'library' ? library.id : undefined,
      expectedHash: accepted ? 'a'.repeat(64) : undefined,
    },
  }
  let registered: typeof library | undefined = library
  let unavailable = false
  const calls: string[][] = []
  const exec = host.exec.bind(host)
  vi.spyOn(host, 'exec').mockImplementation((command, args, options) => {
    if (command !== '/fixture/skillager') return exec(command, args, options)
    calls.push([...args])
    if (unavailable) return Promise.reject(Error('CLI executable unavailable'))
    const value = args.includes('show')
      ? {
          skill: {
            id: request.selection.skillId,
            root: skill.path,
            entrypoint: request.selection.path.path,
            trust: 'reviewed',
            content_hash: request.selection.expectedHash,
            source: { library_id: library.id },
          },
          content: body,
        }
      : {
          collections: registered
            ? {
                lib: {
                  kind: 'library',
                  library_id: registered.id,
                  library_root: registered.root.path,
                  path: registered.skillsRoot.path,
                },
              }
            : {},
        }
    return Promise.resolve({
      code: 0,
      signal: null,
      stdout: JSON.stringify(value),
      stderr: '',
    })
  })
  const cli = new SkillagerCli(host, localPath(join(root, 'scratch')))
  const resources = createRendererResourceFixture(),
    owner = resources.activateOwner()
  const reviews = new SkillagerReviewOwner(
    cli,
    resources.scopes,
    {
      create: () => {
        throw Error('Unexpected HTML')
      },
      release: () => {},
    },
    cli,
  )
  const grant = {
    selection: {
      executable: localPath('/fixture/skillager'),
      catalog: localPath(join(root, 'catalog')),
      environment: {},
      version: '0.9.2',
      library,
    },
    assertCurrent: () => {},
  }
  onTestFinished(async () => {
    await reviews.revoke()
    await cli.dispose()
    await host.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await mkdir(library.skillsRoot.path, { recursive: true })
  await mkdir(relocated.skillsRoot.path, { recursive: true })
  await mkdir(skill.path, { recursive: true })
  await writeFile(request.selection.path.path, body)
  return {
    host,
    calls,
    library,
    relocated,
    request,
    reviews,
    owner,
    body,
    open: () =>
      reviews.openDocument(owner, request, grant, cli, () =>
        Promise.resolve({
          host,
          root: workspace,
          assertCurrent: grant.assertCurrent,
        }),
      ),
    changeRegistration: (value?: typeof library) => {
      registered = value
    },
    loseExecutable: () => {
      unavailable = true
    },
  }
}

it.each([
  ['library', false, ['list', 'list']],
  ['library', true, ['list', 'show', 'list']],
  ['project-original', false, []],
  ['project-original', true, ['list', 'show', 'list']],
] as const)(
  'reads %s (accepted: %s) using only required public CLI checks',
  async (kind, accepted, commands) => {
    const f = await fixture(kind, accepted)
    const opened = await f.open()
    expect(opened.content.text).toBe(f.body)
    expect(f.calls.map((args) => (args.includes('show') ? 'show' : 'list'))).toEqual(
      commands,
    )
    if (accepted)
      expect(f.calls.find((args) => args.includes('show'))?.slice(-5)).toEqual([
        'show',
        '--content',
        '--full-json',
        '--',
        f.request.selection.skillId,
      ])
  },
)

it('reads a current project occurrence when the local CLI is unavailable', async () => {
  const f = await fixture('project-original')
  f.loseExecutable()
  expect((await f.open()).content.text).toBe(f.body)
  expect(f.calls).toEqual([])
})

it.each(['removed', 'uuid', 'root'] as const)(
  'refuses %s library registration before the file stream opens',
  async (change) => {
    const f = await fixture('library')
    f.changeRegistration(
      change === 'removed'
        ? undefined
        : {
            ...f.library,
            ...(change === 'uuid'
              ? { id: 'ff0467b4-bf3e-4c85-a11e-aac0f6071398' }
              : f.relocated),
          },
    )
    const read = vi.spyOn(f.host.fileTransfer, 'readFileChunksNoFollow')
    await expect(f.open()).rejects.toMatchObject({ reason: 'library-changed' })
    expect(read).not.toHaveBeenCalled()
  },
)

it.each([false, true])(
  'refuses a same-path replacement UUID during reading (accepted: %s)',
  async (accepted) => {
    const f = await fixture('library', accepted)
    const read = f.host.fileTransfer.readFileChunksNoFollow!.bind(f.host.fileTransfer)
    vi.spyOn(f.host.fileTransfer, 'readFileChunksNoFollow').mockImplementation(
      async function* (path, options) {
        yield* read(path, options)
        f.changeRegistration({ ...f.library, id: 'ff0467b4-bf3e-4c85-a11e-aac0f6071398' })
      },
    )
    await expect(f.open()).rejects.toMatchObject({ reason: 'library-changed' })
    expect(f.calls.filter((args) => args.includes('list'))).toHaveLength(2)
  },
)

it('keeps a renderer-supplied leading-dash project ID after all show options', async () => {
  const f = await fixture('project-original', true)
  Object.assign(f.request.selection, { skillId: '--help' })
  expect((await f.open()).content.text).toBe(f.body)
  expect(f.calls.find((args) => args.includes('show'))?.slice(-5)).toEqual([
    'show',
    '--content',
    '--full-json',
    '--',
    '--help',
  ])
})
