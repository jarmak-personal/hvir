import { skillagerExposureFixture } from './skillager-exposure-fixture'
import { skillagerReviewFixture } from './skillager-review-fixture'
import type { HtmlPreviewProtocol } from '../html-preview-protocol'
import { realSkillagerSmokePort } from './skillager-cli-fixture'
import type { IpcProjectAuthorityPort } from '../ipc/authority-port'
import type { SmokeCleanup } from './cleanup'
import { hostPathEquals, localPath, type HostPath } from '../../shared/host-path'
import { skillagerDestinationAvailable } from '../skillager/skillager-destination'
import type { SkillagerMetadata } from '../../shared/skillager'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { SkillagerCapability } from '../skillager/skillager-capability'
import { SkillagerError } from '../skillager/skillager-port'

/** Renderer interaction evidence only; real CLI performance has a separate fixture. */
export function createSkillagerSmoke(
  resources: RendererResourceScopes,
  cleanup: SmokeCleanup,
  projects: Pick<IpcProjectAuthorityPort, 'getProject' | 'getProjectState'>,
  previews: Pick<HtmlPreviewProtocol, 'create' | 'release'>,
) {
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
  const fixtures = new Map<string, ReturnType<typeof skillagerExposureFixture>>()
  const fixtureFor = (at: HostPath) => {
    const key = JSON.stringify([at.hostId, at.path])
    let fixture = fixtures.get(key)
    if (!fixture) {
      fixture = skillagerExposureFixture(at)
      for (const id of acceptedIds) fixture.accepted(id)
      fixtures.set(key, fixture)
    }
    return fixture
  }
  const calls: string[] = []
  const real = realSkillagerSmokePort(host, cleanup)
  const capability = new SkillagerCapability(
    real ?? {
      probe(executable) {
        calls.push('probe')
        if (executable?.path === '/missing')
          return Promise.reject(new SkillagerError('missing', 'Skillager was not found.'))
        return Promise.resolve(selection)
      },
      validate() {
        calls.push('validate')
        return Promise.resolve()
      },
      inventory() {
        calls.push('inventory')
        return Promise.resolve(rows)
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
        return [{ ...rows[4999]!, name: request.query, matchReasons: ['body'] }]
      },
      exposures: () => fixtureFor(root).exposures(),
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
          : fixtureFor(request.workspaceRoot).exposures(),
      destinationAvailable: (destination) =>
        skillagerDestinationAvailable(projects.getProjectState(), destination),
    },
  )
  cleanup.defer('Skillager capability', () => capability.dispose())
  return capability
}
