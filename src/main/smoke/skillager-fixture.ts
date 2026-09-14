import { verifySkillagerScenario } from './skillager'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { skillagerLibrarySyncFixture } from './skillager-library-sync-fixture'
import { skillagerExposureFixture } from './skillager-exposure-fixture'
import { skillagerReviewFixture } from './skillager-review-fixture'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import { realSkillagerSmokePort } from './skillager-cli-fixture'
import type { IpcProjectAuthorityPort } from '../ipc/authority-port'
import type { SmokeCleanup } from './cleanup'
import {
  hostPathEquals,
  joinHostPath,
  localPath,
  type HostPath,
} from '../../shared/host-path'
import { skillagerDestinationAvailable } from '../skillager/skillager-destination'
import type {
  SkillagerLibrary,
  SkillagerMetadata,
  SkillagerSearchRequest,
} from '../../shared/skillager'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { SkillagerCapability } from '../skillager/skillager-capability'
import { SkillagerError } from '../skillager/skillager-port'
import { createSkillagerProjectTerminal } from '../skillager/skillager-project-terminal'
import { skillagerProjectFixture } from './skillager-project-fixture'

/** Renderer interaction evidence only; real CLI performance has a separate fixture. */
export function createSkillagerSmoke(
  dependencies: {
    rendererResources: RendererResourceScopes
    htmlPreviews: Pick<HtmlPreviewProtocol, 'create' | 'release'>
  },
  cleanup: SmokeCleanup,
  projects: Pick<IpcProjectAuthorityPort, 'getProject' | 'getProjectState'>,
  terminal: Pick<
    Parameters<typeof createSkillagerProjectTerminal>[1],
    'profiles' | 'sessions'
  > & { ptys: PtySupervisor },
) {
  const { rendererResources: resources, htmlPreviews: previews } = dependencies
  const { host, root } = projects.getProject()
  const library = {
    id: 'smoke-library',
    root: localPath('/hvir-smoke-library'),
    skillsRoot: localPath('/hvir-smoke-library/skills'),
  }
  const selection = {
    executable: localPath('/hvir-smoke/skillager'),
    catalog: localPath('/hvir-smoke/catalog'),
    version: 'skillager 0.9.0',
    environment: {},
    library,
  }
  const rows: SkillagerMetadata[] = Array.from({ length: 5000 }, (_, index) => ({
    id: `lib/skill-${index}`,
    name: `Skill ${index}`,
    description: 'Metadata fixture',
    trust: index === 0 ? 'discovered' : 'reviewed',
    source: {
      type: 'collection',
      collection: 'lib',
      ownership: 'library',
      libraryId: library.id,
    },
    contentHash: 'a'.repeat(64),
    tags: [],
    matchReasons: [],
    exposure: 'unknown',
  }))
  const acceptedIds = new Set<string>()
  const searchRows = (request: SkillagerSearchRequest): readonly SkillagerMetadata[] => {
    const row = { ...rows[4999]!, name: request.query, matchReasons: ['body'] }
    if (request.query !== 'installed-merge') return [row]
    if (!request.includeInstalled) return []
    const path = joinHostPath(root, '.claude/skills/merge')
    const original = {
      id: 'c'.repeat(64),
      kind: 'project-original' as const,
      path,
      entrypoint: joinHostPath(path, 'SKILL.md'),
      agent: 'claude' as const,
      sourceIdentity: 'd'.repeat(64),
    }
    const canonical: SkillagerMetadata = {
      ...row,
      matchReasons: [],
      search: {
        groupId: 'e'.repeat(64),
        canonical: { libraryId: library.id, skillId: row.id },
        occurrence: {
          id: 'f'.repeat(64),
          kind: 'library',
          path: joinHostPath(library.skillsRoot, 'skill-4999'),
          entrypoint: joinHostPath(library.skillsRoot, 'skill-4999/SKILL.md'),
        },
        groupOccurrences: 2,
        installed: true,
        match: {
          skillId: 'project/merge',
          contentHash: row.contentHash!,
          score: 1,
          reasons: ['body'],
          occurrence: original,
        },
      },
    }
    return request.view === 'copies'
      ? [
          canonical,
          {
            ...canonical,
            id: 'project/merge',
            matchReasons: row.matchReasons,
            source: { type: 'project', ownership: 'external' },
            projectSkill: { path, agent: 'claude', managed: false },
            search: { ...canonical.search!, occurrence: original },
          },
        ]
      : [canonical]
  }
  const fixtures = new Map<string, ReturnType<typeof skillagerExposureFixture>>()
  const fixtureFor = (at: HostPath) => {
    const key = JSON.stringify([at.hostId, at.path])
    let fixture = fixtures.get(key)
    if (!fixture) {
      fixture = skillagerExposureFixture(at, library.id)
      for (const id of acceptedIds) fixture.accepted(id)
      fixtures.set(key, fixture)
    }
    return fixture
  }
  let initializedLibrary: SkillagerLibrary | undefined
  let initializedGit = true
  const calls: string[] = []
  const sync = skillagerLibrarySyncFixture()
  const real = realSkillagerSmokePort(host, cleanup)
  const project = skillagerProjectFixture(host, root, cleanup)
  const capability = new SkillagerCapability(
    real ?? {
      probe(executable) {
        calls.push('probe')
        if (executable?.path === '/hvir-smoke/project-setup')
          return project.selection(selection)
        if (executable?.path === '/hvir-smoke/explorer-capacity')
          return Promise.resolve({ ...selection, executable })
        if (executable?.path === '/missing')
          return Promise.reject(new SkillagerError('missing', 'Skillager was not found.'))
        return Promise.resolve(
          executable?.path === '/hvir-smoke/onboarding'
            ? { ...selection, executable, library: initializedLibrary }
            : selection,
        )
      },
      validate() {
        calls.push('validate')
        return Promise.resolve()
      },
      inventory(selected) {
        calls.push('inventory')
        return Promise.resolve(
          selected.library?.id === 'onboarding-library'
            ? sync.synced
              ? [
                  {
                    ...rows[1]!,
                    source: { ...rows[1]!.source, libraryId: selected.library.id },
                  },
                ]
              : []
            : rows,
        )
      },
      async search(_selection, request, signal) {
        calls.push(`search:${request.query}`)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250)
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
        return {
          rows: searchRows(request),
          search: {
            scope: request.scope,
            browseAgent: request.browseAgent ?? request.agent,
            view: request.view ?? 'skills',
            includeInstalled: request.includeInstalled ?? false,
            installedObservation: 'observed' as const,
            coverage: 'local-project' as const,
          },
        }
      },
      exposures: () => fixtureFor(root).exposures(),
      ...sync.cli,
    },
    resources,
    (candidate) => hostPathEquals(candidate, projects.getProjectState().root),
    {
      cli:
        real ??
        skillagerReviewFixture(library.skillsRoot, (id) => {
          const row = rows.findIndex((item) => item.id === id)
          if (row >= 0) rows[row] = { ...rows[row]!, trust: 'reviewed' }
          acceptedIds.add(id)
          for (const fixture of fixtures.values()) fixture.accepted(id)
        }),
      previews: {
        create: (content, at) => previews.create(content, undefined, at),
        release: (id) => previews.release(id),
      },
    },
    {
      cli: real ?? {
        previewExposure: (selection, request, signal) =>
          fixtureFor(request.destination.root).cli.previewExposure(
            selection,
            request,
            signal,
          ),
        applyExposure: (selection, snapshot, signal) =>
          fixtureFor(snapshot.detail.request.destination.root).cli.applyExposure(
            selection,
            snapshot,
            signal,
          ),
        updateSourceHash: (selection, snapshot, signal) =>
          fixtureFor(snapshot.detail.request.destination.root).cli.updateSourceHash(
            selection,
            snapshot,
            signal,
          ),
      },
      observe: (selection, request, _source, signal) =>
        real
          ? real.exposures(selection, request, signal)
          : selection.executable.path === '/hvir-smoke/explorer-capacity'
            ? Promise.resolve(fixtureFor(request.workspaceRoot).capacity)
            : fixtureFor(request.workspaceRoot).exposures(),
      destinationAvailable: (destination) =>
        skillagerDestinationAvailable(projects.getProjectState(), destination),
      localActions: real ?? {
        syncStatus: (selection, workspace, signal) =>
          sync.cli.syncStatus(selection, workspace, signal),
        previewLocalAction: (selection, request, signal) =>
          fixtureFor(request.destination.root).localActions.previewLocalAction(
            selection,
            request,
            signal,
          ),
        applyLocalAction: (selection, snapshot, signal, submitted) =>
          fixtureFor(
            snapshot.detail.request.destination.root,
          ).localActions.applyLocalAction(selection, snapshot, signal, submitted),
      },
    },
    {
      cli: real ?? {
        defaultLibraryRoot: () =>
          Promise.resolve(localPath('/hvir-smoke/personal library')),
        async initializeLibrary(_selection, root, gitHistory, signal) {
          await new Promise<void>((resolve, reject) => {
            const cancelled = () => {
              clearTimeout(timer)
              reject(new SkillagerError('cancelled', 'Setup cancelled.'))
            }
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', cancelled)
              resolve()
            }, 250)
            signal.addEventListener('abort', cancelled, { once: true })
          })
          initializedLibrary = {
            id: 'onboarding-library',
            root,
            skillsRoot: localPath(root.path + '/skills'),
          }
          initializedGit = gitHistory
          return { kind: 'ready', status: { library: initializedLibrary, gitHistory } }
        },
        libraryStatus: () =>
          Promise.resolve({ library: initializedLibrary, gitHistory: initializedGit }),
      },
      picker: { choose: () => Promise.resolve(localPath('/hvir-smoke/chosen library')) },
    },
    {
      cli: real ?? project.cli,
      terminal: createSkillagerProjectTerminal(host, {
        ptySupervisor: terminal.ptys,
        profiles: terminal.profiles,
        sessions: terminal.sessions,
        rendererResources: resources,
      }),
    },
  )
  cleanup.defer('Skillager capability', () => capability.dispose())
  return {
    capability,
    verify: (
      win: Parameters<typeof verifySkillagerScenario>[0],
      projectFixture: Parameters<typeof verifySkillagerScenario>[2],
      emit: Parameters<typeof verifySkillagerScenario>[3],
    ) =>
      verifySkillagerScenario(win, terminal.ptys, projectFixture, emit, () =>
        sync.holdNextApply(),
      ),
  }
}
