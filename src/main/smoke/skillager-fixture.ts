import { realSkillagerSmokePort } from './skillager-cli-fixture'
import type { ProjectHost } from '../project-host'
import type { SmokeCleanup } from './cleanup'
import { joinHostPath, localPath, type HostPath } from '../../shared/host-path'
import type { SkillagerMetadata } from '../../shared/skillager'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { SkillagerCapability } from '../skillager/skillager-capability'
import { SkillagerError } from '../skillager/skillager-port'

/** Renderer interaction evidence only; real CLI performance has a separate fixture. */
export function createSkillagerSmoke(
  resources: RendererResourceScopes,
  root: HostPath,
  cleanup: SmokeCleanup,
  host: ProjectHost,
) {
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
  const calls: string[] = []
  const capability = new SkillagerCapability(
    realSkillagerSmokePort(host, cleanup) ?? {
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
      exposures() {
        return Promise.resolve([
          {
            id: 'lib-skill-1',
            skillId: 'lib/skill-1',
            target: joinHostPath(root, '.agents/skills/lib-skill-1'),
            mode: 'native',
            status: 'current',
          },
        ])
      },
    },
    resources,
    (candidate) => candidate.hostId === root.hostId && candidate.path === root.path,
  )
  cleanup.defer('Skillager capability', () => capability.dispose())
  return capability
}
