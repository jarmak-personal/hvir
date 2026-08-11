import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { GitEngine } from '../src/main/git/git-engine'
import { ProjectHostCatalog } from '../src/main/project-host'
import { ProjectRegistry } from '../src/main/project-registry'
import {
  WorkspaceCoordinator,
  type WorkspaceWatchPort,
} from '../src/main/workspace-coordinator'
import { WorkspaceRemovalCoordinator } from '../src/main/workspace-removal-coordinator'
import { localPath } from '../src/shared'

describe('missing workspace removal flow', () => {
  it('removes a deleted worktree from the real registry and releases its resources', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'hvir-workspace-removal-'))
    const repository = join(fixture, 'repository')
    const linked = join(fixture, 'linked')
    await mkdir(repository)
    git(repository, ['init', '-b', 'main'])
    git(repository, ['config', 'user.email', 'hvir@example.test'])
    git(repository, ['config', 'user.name', 'hvir test'])
    await writeFile(join(repository, 'tracked.txt'), 'tracked\n')
    git(repository, ['add', 'tracked.txt'])
    git(repository, ['commit', '-m', 'initial'])
    git(repository, ['worktree', 'add', '-b', 'feature', linked])

    const root = localPath(await realpath(repository))
    const linkedRoot = await realpath(linked)
    const catalog = await ProjectHostCatalog.create({
      prompter: { prompt: () => Promise.resolve(undefined) },
      trustFile: localPath(join(fixture, 'known-hosts.json')),
      home: fixture,
    })
    const registry = await ProjectRegistry.create(
      root,
      catalog,
      join(fixture, 'projects.json'),
      () => undefined,
    )
    const engine = new GitEngine(catalog.local, root)
    const sessions = new Set<string>()
    const scopes = new Set<string>()
    const webPanes = new Set<string>()
    const htmlPreviews = new Set<string>()
    const cleanupOrder: string[] = []
    const removal = new WorkspaceRemovalCoordinator(registry, {
      forgetWorkspaceSessions: (candidate) => {
        cleanupOrder.push('forget-sessions')
        sessions.delete(candidate.path)
        return Promise.resolve()
      },
      revokeWorkspace: (candidate) => {
        cleanupOrder.push('revoke-workspace')
        scopes.delete(candidate.path)
        return Promise.resolve()
      },
      closeWorkspaceWebPanes: (candidate) => {
        cleanupOrder.push('close-web-panes')
        webPanes.delete(candidate.path)
        return Promise.resolve()
      },
      releaseHtmlPreviews: (candidate) => {
        cleanupOrder.push('release-html-previews')
        htmlPreviews.delete(candidate.path)
      },
    })
    const coordinator = new WorkspaceCoordinator({
      registry,
      discovery: {
        discover: (candidate) => engine.worktrees(candidate),
        workspaceActivity: (candidate, related) =>
          engine.workspaceActivity(candidate, related),
      },
      removal,
      emitWatch: () => undefined,
      createWatch: (target): WorkspaceWatchPort => ({
        target,
        updateInterests: () => undefined,
        dispose: () => Promise.resolve(),
      }),
    })

    try {
      const projectId = registry.state().activeProjectId
      await coordinator.refresh(projectId)
      const linkedWorkspace = registry
        .projectById(projectId)!
        .workspaces.find((workspace) => workspace.root.path === linkedRoot)!
      for (const owner of [sessions, scopes, webPanes, htmlPreviews]) {
        owner.add(linkedWorkspace.root.path)
      }
      expect(registry.projectById(projectId)?.workspaces).toHaveLength(2)
      expect([sessions, scopes, webPanes, htmlPreviews].map(({ size }) => size)).toEqual([
        1, 1, 1, 1,
      ])

      await rm(linked, { recursive: true })
      await coordinator.refresh(projectId)

      expect(registry.projectById(projectId)?.workspaces).toEqual([
        expect.objectContaining({ root, missing: false }),
      ])
      expect(cleanupOrder).toEqual([
        'forget-sessions',
        'revoke-workspace',
        'close-web-panes',
        'release-html-previews',
      ])
      expect(
        [sessions, scopes, webPanes, htmlPreviews].every((owner) => owner.size === 0),
      ).toBe(true)
      const stored = JSON.parse(
        await readFile(join(fixture, 'projects.json'), 'utf8'),
      ) as { projects: readonly { workspaces: readonly { path: string }[] }[] }
      expect(stored.projects[0]?.workspaces.map(({ path }) => path)).toEqual([root.path])
    } finally {
      await coordinator.dispose()
      await registry.dispose()
      await catalog.dispose()
      await rm(fixture, { recursive: true })
    }
  })
})

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}
