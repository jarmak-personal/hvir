import { skillagerContentSelection } from '../src/renderer/src/skillager/skillager-content-model'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ExecOptions } from '../src/main/project-host/project-host'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { SkillagerReviewOwner } from '../src/main/skillager/skillager-review-owner'
import {
  localPath,
  joinHostPath,
  asHostId,
  hostPath,
  type HostPath,
} from '../src/shared/host-path'
import { skillagerFixtureEnvironment } from '../src/main/smoke/skillager-fixture-environment'
import { createRendererResourceFixture } from './fixtures/renderer-resource-fixture'
import type { SkillagerContentRequest } from '../src/shared/skillager-content'
const executable = process.env.HVIR_SKILLAGER_EXECUTABLE
it.runIf(Boolean(executable))(
  'reads accepted library and projected project bodies, refuses stale versions, and keeps pending reads separate from acceptance',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-document-cli-')))
    const environment = skillagerFixtureEnvironment(localPath(root), process.env)
    const calls: string[][] = []
    const bodyCalls: {
      args: readonly string[]
      cwd?: HostPath
      code: number | null
      missingLiteralId: boolean
    }[] = []
    class FixtureHost extends LocalHost {
      override defaultShell() {
        return Promise.resolve('/bin/sh')
      }
      override async exec(
        command: string,
        args: readonly string[],
        options: ExecOptions = {},
      ) {
        if (command === executable) {
          calls.push([...args])
        }
        const result = await super.exec(command, args, {
          ...options,
          unsetEnv: environment.unsetEnv,
          env: { ...environment.env, ...options.env },
        })
        if (command === executable && args.includes('show') && args.includes('--content'))
          bodyCalls.push({
            args,
            cwd: options.cwd,
            code: result.code,
            missingLiteralId: result.stderr.includes('skill not found: --help'),
          })
        return result
      }
    }
    const host = new FixtureHost(),
      cli = new SkillagerCli(host, localPath(join(root, 'scratch')))
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
    onTestFinished(async () => {
      await reviews.revoke()
      await cli.dispose()
      await host.dispose()
      await rm(root, { recursive: true, force: true })
    })
    await mkdir(join(root, 'home'))
    await mkdir(join(root, 'project'))
    const signal = AbortSignal.timeout(90_000)
    const probe = await cli.probe(localPath(executable!), signal)
    const init = await cli.initializeLibrary(
      probe,
      localPath(join(root, 'library')),
      false,
      signal,
    )
    if (init.kind !== 'ready' || !init.status.library)
      throw Error('Expected initialized private library')
    const selection = { ...probe, library: init.status.library }
    const grant = { selection, assertCurrent: () => signal.throwIfAborted() }
    for (const [name, newline] of [
      ['lf', '\n'],
      ['crlf', '\r\n'],
      ['cr', '\r'],
    ] as const) {
      const skill = joinHostPath(selection.library.skillsRoot, name)
      await mkdir(skill.path)
      const original = [
        '---',
        `name: ${name}`,
        'description: Read an example skill.',
        '---',
        '',
        '# Current body',
        'Read the supporting guidance.',
        '',
      ].join(newline)
      await writeFile(join(skill.path, 'SKILL.md'), original)
      const snapshot = await cli.review(selection, `lib/${name}`, signal)
      expect(snapshot.detail.canAccept).toBe(true)
      await cli.accept(selection, snapshot, signal)
      const hash = snapshot.detail.hash
      await snapshot.dispose()
      let request: SkillagerContentRequest = {
        connectionId: 'test',
        requestId: calls.length + 1,
        agent: 'codex',
        workspaceRoot: hostPath(asHostId('ssh-project'), '/remote/project'),
        selection: {
          kind: 'library',
          skillId: `lib/${name}`,
          libraryId: selection.library.id,
          root: skill,
          path: joinHostPath(skill, 'SKILL.md'),
          expectedHash: hash,
        },
      }
      if (probe.searchView) {
        const found = await cli.search(
          selection,
          {
            ...request,
            workspaceRoot: localPath(join(root, 'project')),
            query: name,
            scope: 'library',
            view: 'skills',
            includeInstalled: true,
          },
          signal,
        )
        const selected = found.rows.find((row) => row.id === request.selection.skillId)
        expect(selected?.search?.occurrence.kind).toBe('library')
        const projected = skillagerContentSelection(
          selected!,
          selection.library,
          request.workspaceRoot,
        )
        expect(projected?.expectedHash).toBe(hash)
        request = { ...request, selection: projected! }
      }
      const begin = calls.length
      const opened = await reviews.openDocument(owner, request, grant, cli, () => {
        throw Error('Local library used SSH project authority')
      })
      expect(opened.content.text).toBe(original)
      expect(await readFile(join(skill.path, 'SKILL.md'), 'utf8')).toBe(original)
      const reads = calls.slice(begin)
      expect(
        reads.some((args) => args.includes('show') && args.includes('--content')),
      ).toBe(true)
      expect(
        reads.some(
          (args) =>
            args.includes('accept') || args.includes('setup') || args.includes('review'),
        ),
      ).toBe(false)
      await reviews.releaseDocument(owner, opened.contentId)
      await writeFile(join(skill.path, 'SKILL.md'), original + '\nPending modification\n')
      await expect(
        reviews.openDocument(
          owner,
          { ...request, requestId: request.requestId + 1 },
          grant,
          cli,
          () => {
            throw Error('Unexpected project')
          },
        ),
      ).rejects.toMatchObject({ reason: 'stale-review' })
      const pendingStart = calls.length
      const pending = await reviews.openDocument(
        owner,
        {
          ...request,
          requestId: request.requestId + 2,
          selection: { ...request.selection, expectedHash: undefined },
        },
        grant,
        cli,
        () => {
          throw Error('Unexpected project')
        },
      )
      expect(pending.content.text).toContain('Pending modification')
      expect(
        calls
          .slice(pendingStart)
          .some((args) => args.includes('show') || args.includes('accept')),
      ).toBe(false)
      await reviews.releaseDocument(owner, pending.contentId)
    }
    // Real argparse must treat this as an unknown literal ID, not the successful help action.
    const parserRoot = localPath(join(root, 'project', 'parser-fixture'))
    await expect(
      cli.validateDocument(
        selection,
        {
          kind: 'project-original',
          skillId: '--help',
          root: parserRoot,
          path: joinHostPath(parserRoot, 'SKILL.md'),
          expectedHash: 'a'.repeat(64),
        },
        localPath(join(root, 'project')),
        Buffer.from('# Current file'),
        signal,
      ),
    ).rejects.toMatchObject({ reason: 'stale-review' })
    expect(bodyCalls.at(-1)?.args.slice(-5)).toEqual([
      'show',
      '--content',
      '--full-json',
      '--',
      '--help',
    ])
    expect(bodyCalls.at(-1)).toMatchObject({ code: 2, missingLiteralId: true })
    if (probe.searchView) {
      const project = localPath(join(root, 'project'))
      await writeFile(
        join(project.path, 'pyproject.toml'),
        '[project]\nname="fixture"\nversion="0.0.0"\n',
      )
      const native = joinHostPath(project, '.claude', 'skills', 'native-reader')
      const body =
        '---\nname: Native reader\ndescription: Read the project original.\n---\n\n# Project original body\nRead nativedocumentneedle here.\n'
      await mkdir(native.path, { recursive: true })
      await writeFile(join(native.path, 'SKILL.md'), body)
      const approval = await host.exec(
        executable!,
        [
          '--catalog-state-dir',
          selection.catalog.path,
          'review',
          'approve',
          'project/native-reader',
          '--json',
        ],
        { cwd: project, signal },
      )
      expect(approval.code).toBe(0)
      const approved = JSON.parse(approval.stdout) as {
        selected: { id: string; trust: string }[]
      }
      expect(approved.selected.map(({ id, trust }) => ({ id, trust }))).toEqual([
        { id: 'project/native-reader', trust: 'reviewed' },
      ])
      const found = await cli.search(
        selection,
        {
          connectionId: 'test',
          requestId: calls.length + 1,
          workspaceRoot: project,
          agent: 'codex',
          browseAgent: 'claude',
          query: 'nativedocumentneedle',
          scope: 'workspace',
          view: 'copies',
          includeInstalled: true,
        },
        signal,
      )
      const row = found.rows.find(
        (item) =>
          item.search?.occurrence.kind === 'project-original' &&
          item.search.occurrence.path.path === native.path,
      )
      expect(
        row?.id,
        JSON.stringify(
          found.rows.map((item) => ({
            id: item.id,
            occurrence: item.search?.occurrence,
          })),
        ),
      ).toBe('project/native-reader')
      const projected = skillagerContentSelection(row!, selection.library, project)
      expect(projected).toMatchObject({
        kind: 'project-original',
        root: native,
        agent: 'claude',
      })
      expect(projected?.expectedHash).toMatch(/^[a-f0-9]{64}$/)
      const request: SkillagerContentRequest = {
        connectionId: 'test',
        requestId: calls.length + 1,
        workspaceRoot: project,
        agent: 'claude',
        selection: projected!,
      }
      const projectAccess = (path: HostPath) => {
        expect(path).toEqual(joinHostPath(native, 'SKILL.md'))
        return Promise.resolve({
          host,
          root: project,
          assertCurrent: grant.assertCurrent,
        })
      }
      const before = calls.length
      const opened = await reviews.openDocument(owner, request, grant, cli, projectAccess)
      expect(opened.content.text).toBe(body)
      expect(bodyCalls.at(-1)?.cwd).toEqual(project)
      expect(bodyCalls.at(-1)?.args).toContain('project/native-reader')
      expect(bodyCalls.at(-1)?.args).not.toContain('--state-dir')
      expect(
        calls
          .slice(before)
          .some((args) =>
            ['approve', 'accept', 'setup', 'review'].some((command) =>
              args.includes(command),
            ),
          ),
      ).toBe(false)
      await reviews.releaseDocument(owner, opened.contentId)
      const modified = body + '\nCurrent project customization.\n'
      await writeFile(join(native.path, 'SKILL.md'), modified)
      await expect(
        reviews.openDocument(
          owner,
          { ...request, requestId: request.requestId + 1 },
          grant,
          cli,
          projectAccess,
        ),
      ).rejects.toMatchObject({ reason: 'stale-review' })
      expect(await readFile(join(native.path, 'SKILL.md'), 'utf8')).toBe(modified)
    }
  },
  120_000,
)
