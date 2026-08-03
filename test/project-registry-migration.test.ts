import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ProjectHostCatalog } from '../src/main/project-host'
import { ProjectRegistry } from '../src/main/project-registry'
import { localPath } from '../src/shared'

const cleanups: string[] = []
const catalogs: ProjectHostCatalog[] = []

afterEach(async () => {
  await Promise.all(catalogs.splice(0).map((catalog) => catalog.dispose()))
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('ProjectRegistry persistence compatibility', () => {
  it.each([1, 2, 3] as const)(
    'loads version %i and writes the exact current version 3 shape',
    async (version) => {
      const createdRoot = await mkdtemp(join(tmpdir(), `hvir-registry-v${version}-`))
      cleanups.push(createdRoot)
      const root = await realpath(createdRoot)
      const projectsFile = join(createdRoot, 'projects.json')
      const projectId = `project:local:${root}`
      await writeFile(
        projectsFile,
        JSON.stringify({
          version,
          activeProjectId: projectId,
          projects: [
            {
              hostId: 'local',
              path: root,
              displayName: basename(root),
              activeWorkspacePath: root,
              discoveryBaselineEstablished: true,
              workspaces: [
                {
                  path: root,
                  head: 'a'.repeat(40),
                  branch: 'main',
                  main: true,
                  closed: false,
                  missing: false,
                  repository: true,
                  changedFiles: 2,
                  newlyDiscovered: false,
                },
              ],
            },
          ],
        }),
      )
      const catalog = await ProjectHostCatalog.create({
        prompter: { prompt: () => Promise.resolve(undefined) },
        trustFile: localPath(join(createdRoot, 'known-hosts.json')),
        home: createdRoot,
      })
      catalogs.push(catalog)
      const registry = await ProjectRegistry.create(
        localPath(root),
        catalog,
        projectsFile,
        () => undefined,
      )

      expect(registry.active.root).toEqual(localPath(root))
      expect(registry.projectById(projectId)?.workspaces[0]).toMatchObject({
        root: localPath(root),
        head: 'a'.repeat(40),
        branch: 'main',
        repository: true,
        changedFiles: 2,
      })
      await registry.dispose()
      await catalog.dispose()
      expect(JSON.parse(await readFile(projectsFile, 'utf8'))).toEqual({
        version: 3,
        activeProjectId: projectId,
        projects: [
          {
            hostId: 'local',
            path: root,
            displayName: basename(root),
            discoveryBaselineEstablished: true,
            activeWorkspacePath: root,
            workspaces: [
              {
                path: root,
                head: 'a'.repeat(40),
                branch: 'main',
                main: true,
                closed: false,
                missing: false,
                repository: true,
                changedFiles: 2,
                newlyDiscovered: false,
              },
            ],
          },
        ],
      })
    },
  )
})
