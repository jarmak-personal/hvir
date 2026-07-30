import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GitEngine } from '../src/main/git/git-engine'
import { LocalHost, type ProjectHost } from '../src/main/project-host'
import {
  WorkspaceCoordinator,
  type WorkspaceRegistryPort,
  type WorkspaceWatchPort,
} from '../src/main/workspace-coordinator'
import {
  localPath,
  type ProjectState,
  type WorkspaceActivityResult,
  type WorktreeDiscovery,
} from '../src/shared'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true })))
})

describe('workspace clean-filter polling', () => {
  it('does not turn a stable dirty filter input into an unbounded polling loop', async () => {
    const { rootPath, linkedPath } = await filteredRepository()
    const root = localPath(rootPath)
    const linked = localPath(linkedPath)
    const counter = join(rootPath, '.git', 'clean-count')
    await writeFile(join(linkedPath, 'payload.asset'), 'different payload\n')
    await writeFile(counter, '')
    const host = new LocalHost()
    const engine = new GitEngine(host, root)
    const state = projectState(host, root, linked)
    const updateWorkspaceActivity = vi.fn(() => Promise.resolve(state))
    const registry: WorkspaceRegistryPort = {
      active: {
        host,
        root,
        projectId: 'project-1',
        workspaceId: 'workspace-1',
      },
      state: () => state,
      projectById: (projectId) =>
        state.projects.find((project) => project.id === projectId),
      reconcileWorktrees: vi.fn(() => Promise.resolve(state)),
      updateWorkspaceActivity,
    }
    const discovery = {
      discover: vi.fn((candidate: typeof root): Promise<WorktreeDiscovery> =>
        engine.worktrees(candidate),
      ),
      workspaceActivity: vi.fn(
        (
          candidate: typeof root,
          related: readonly (typeof root)[],
        ): Promise<WorkspaceActivityResult> =>
          engine.workspaceActivity(candidate, related),
      ),
    }
    const coordinator = new WorkspaceCoordinator({
      registry,
      discovery,
      emitWatch: vi.fn(),
      createWatch: (target): WorkspaceWatchPort => ({
        target,
        updateInterests: vi.fn(),
        dispose: vi.fn(() => Promise.resolve()),
      }),
    })

    coordinator.startPolling(10)
    await vi.waitFor(() => expect(updateWorkspaceActivity).toHaveBeenCalledOnce())
    const afterFirstPoll = (await readFile(counter, 'utf8')).length
    expect(afterFirstPoll).toBeGreaterThan(0)
    await vi.waitFor(() =>
      expect(discovery.discover.mock.calls.length).toBeGreaterThan(2),
    )
    coordinator.stopPolling()
    await coordinator.settle()

    expect(discovery.workspaceActivity).toHaveBeenCalledOnce()
    expect((await readFile(counter, 'utf8')).length).toBe(afterFirstPoll)

    await coordinator.refresh('project-1')
    expect((await readFile(counter, 'utf8')).length).toBeGreaterThan(afterFirstPoll)
    await coordinator.dispose()
    await host.dispose()
  })
})

async function filteredRepository(): Promise<{
  readonly rootPath: string
  readonly linkedPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'hvir-workspace-filter-'))
  const linked = `${root}-closed`
  cleanups.push(root)
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.email', 'hvir@example.test'])
  git(root, ['config', 'user.name', 'hvir test'])
  const filterScript = join(root, '.git', 'count-clean.cjs')
  const counter = join(root, '.git', 'clean-count')
  await writeFile(
    filterScript,
    "const fs = require('node:fs')\nfs.appendFileSync(process.argv[2], 'x')\nprocess.stdin.pipe(process.stdout)\n",
  )
  await writeFile(counter, '')
  await writeFile(join(root, '.gitattributes'), '*.asset filter=count-clean\n')
  await writeFile(join(root, 'payload.asset'), 'committed payload\n')
  git(root, [
    'config',
    'filter.count-clean.clean',
    `${JSON.stringify(process.execPath)} ${JSON.stringify(filterScript)} ${JSON.stringify(counter)}`,
  ])
  git(root, ['config', 'filter.count-clean.required', 'true'])
  git(root, ['config', 'filter.count-clean.smudge', 'cat'])
  git(root, ['add', '.gitattributes', 'payload.asset'])
  git(root, ['commit', '-m', 'filtered asset'])
  git(root, ['worktree', 'add', '-b', 'closed', linked])
  cleanups.push(linked)
  return { rootPath: root, linkedPath: linked }
}

function projectState(
  host: ProjectHost,
  root: ReturnType<typeof localPath>,
  linked: ReturnType<typeof localPath>,
): ProjectState {
  return {
    root,
    connectionState: 'connected',
    watchTier: 'native',
    activeProjectId: 'project-1',
    activeWorkspaceId: 'workspace-1',
    projects: [
      {
        id: 'project-1',
        registeredRoot: root,
        displayName: 'filtered',
        connectionState: 'connected',
        watchTier: host.watchTier,
        activeWorkspaceId: 'workspace-1',
        workspaces: [
          {
            id: 'workspace-1',
            root,
            name: 'filtered',
            main: true,
            closed: false,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
          {
            id: 'workspace-2',
            root: linked,
            name: 'closed',
            branch: 'closed',
            main: false,
            closed: true,
            missing: false,
            repository: true,
            changedFiles: 0,
          },
        ],
      },
    ],
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
}
