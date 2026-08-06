import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ProjectFileOperationCoordinator,
  type ProjectFileOperationResourcePort,
} from '../src/main/project-file-operations'
import { LocalHost } from '../src/main/project-host/local-host'
import type { ProjectHost } from '../src/main/project-host/project-host'
import type { RendererOwner } from '../src/main/renderer-resource-scopes'
import {
  joinHostPath,
  localPath,
  type HostPath,
  type ProjectFileOperationProgress,
} from '../src/shared'

const owner: RendererOwner = { id: 71, generation: 1 }

describe('project file deletion coordinator', () => {
  let directory: string
  let root: HostPath
  let host: LocalHost
  let resources: DeletionResources
  let coordinator: ProjectFileOperationCoordinator

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'hvir-delete-coordinator-'))
    root = localPath(directory)
    host = new LocalHost({ trashItem: (path) => rename(path.path, `${path.path}.trash`) })
    await host.connect()
    resources = new DeletionResources()
    coordinator = createCoordinator(host, resources, root)
  })

  afterEach(async () => {
    await coordinator.dispose()
    await host.dispose()
    await rm(directory, { recursive: true, force: true })
  })

  it('discloses the exact recoverable target and rejects the workspace root', async () => {
    const source = joinHostPath(root, 'entry.txt')
    await writeFile(source.path, 'entry')

    await expect(coordinator.discloseDeletion(owner, root, source)).resolves.toEqual({
      outcome: 'available',
      workspaceRoot: root,
      source,
      recovery: 'recoverable',
    })
    await expect(coordinator.discloseDeletion(owner, root, root)).resolves.toEqual({
      outcome: 'unavailable',
      workspaceRoot: root,
      source: root,
      reason: 'The workspace root cannot be deleted',
    })
  })

  it('publishes a truthful deletion only after returning its operation identity', async () => {
    const source = joinHostPath(root, 'entry.txt')
    await writeFile(source.path, 'entry')
    const publish = progressPublisher()

    const started = await coordinator.delete({
      owner,
      request: { workspaceRoot: root, source, confirmedRecovery: 'recoverable' },
      publish,
    })

    expect(started).toMatchObject({
      outcome: 'started',
      operationId: 'delete-1',
      generation: 1,
    })
    expect(publish).not.toHaveBeenCalled()
    const completed = await publish.waitForPhase('completed')
    expect(completed.result?.items[0]).toMatchObject({
      status: 'completed',
      effect: 'trashed-entry',
    })
    await expect(readFile(source.path)).rejects.toThrow()
    await expect(readFile(`${source.path}.trash`, 'utf8')).resolves.toBe('entry')
  })

  it('cancels during preflight before any destructive primitive begins', async () => {
    const source = joinHostPath(root, 'cancelled.txt')
    await writeFile(source.path, 'retained')
    const gate = deferred<void>()
    let sourceStats = 0
    const delayed = wrapHost(host, {
      stat: async (path) => {
        if (path.path.endsWith('/cancelled.txt') && (sourceStats += 1) === 2) {
          gate.start()
          await gate.promise
        }
        return host.stat(path)
      },
    })
    await coordinator.dispose()
    coordinator = createCoordinator(delayed, resources, root)
    const publish = progressPublisher()
    const started = await coordinator.delete({
      owner,
      request: { workspaceRoot: root, source, confirmedRecovery: 'recoverable' },
      publish,
    })
    if (started.outcome !== 'started') throw new Error(started.reason)
    await gate.started

    expect(coordinator.cancel(owner, started.operationId, started.generation)).toBe(true)
    gate.resolve()
    const completed = await publish.waitForPhase('completed')

    expect(completed.result?.items[0]).toMatchObject({
      status: 'cancelled',
      effect: 'none',
    })
    await expect(readFile(source.path, 'utf8')).resolves.toBe('retained')
  })

  it('fails closed on replaced workspace authority and a changed recovery guarantee', async () => {
    const source = joinHostPath(root, 'retained.txt')
    await writeFile(source.path, 'retained')
    let workspaceId = 'workspace-1'
    await coordinator.dispose()
    coordinator = new ProjectFileOperationCoordinator({
      resolveWorkspace: () => ({
        projectId: 'project-1',
        workspaceId,
        root,
        host,
      }),
      resources,
      createOperationId: () => 'delete-replaced',
    })
    const gate = deferred<void>()
    const originalStat = host.stat.bind(host)
    let sourceStats = 0
    host.stat = async (path) => {
      if (path.path.endsWith('/retained.txt') && (sourceStats += 1) === 2) {
        gate.start()
        await gate.promise
      }
      return originalStat(path)
    }
    const publish = progressPublisher()
    await coordinator.delete({
      owner,
      request: { workspaceRoot: root, source, confirmedRecovery: 'recoverable' },
      publish,
    })
    await gate.started
    workspaceId = 'workspace-2'
    gate.resolve()
    const replaced = await publish.waitForPhase('completed')
    expect(replaced.result?.items[0]).toMatchObject({ status: 'failed', effect: 'none' })
    await expect(readFile(source.path, 'utf8')).resolves.toBe('retained')

    const mismatchPublish = progressPublisher()
    await coordinator.delete({
      owner,
      request: { workspaceRoot: root, source, confirmedRecovery: 'permanent' },
      publish: mismatchPublish,
    })
    const mismatch = await mismatchPublish.waitForPhase('completed')
    expect(mismatch.result?.items[0]).toMatchObject({
      status: 'failed',
      effect: 'none',
    })
    expect(mismatch.result?.items[0]?.reason).toContain('guarantee changed')
    await expect(readFile(source.path, 'utf8')).resolves.toBe('retained')
  })

  it('suppresses late publication after renderer revocation without retargeting trash', async () => {
    const source = joinHostPath(root, 'late.txt')
    await writeFile(source.path, 'late')
    const gate = deferred<void>()
    await coordinator.dispose()
    await host.dispose()
    host = new LocalHost({
      trashItem: async (path) => {
        gate.start()
        await gate.promise
        await rename(path.path, `${path.path}.trash`)
      },
    })
    await host.connect()
    resources = new DeletionResources()
    coordinator = createCoordinator(host, resources, root)
    const publish = progressPublisher()
    await coordinator.delete({
      owner,
      request: { workspaceRoot: root, source, confirmedRecovery: 'recoverable' },
      publish,
    })
    await gate.started

    resources.revoke()
    gate.resolve()
    await coordinator.dispose()

    expect(publish.mock.calls.map(([event]) => event.phase)).toEqual(['deleting'])
    await expect(readFile(source.path)).rejects.toThrow()
    await expect(readFile(`${source.path}.trash`, 'utf8')).resolves.toBe('late')
  })
})

function createCoordinator(
  host: ProjectHost,
  resources: DeletionResources,
  root: HostPath,
): ProjectFileOperationCoordinator {
  return new ProjectFileOperationCoordinator({
    resolveWorkspace: (candidate) =>
      candidate.path === root.path
        ? { projectId: 'project-1', workspaceId: 'workspace-1', root, host }
        : undefined,
    resources,
    createOperationId: () => 'delete-1',
  })
}

class DeletionResources implements ProjectFileOperationResourcePort {
  current = true
  private revokeOperation?: () => void

  isRendererCurrent(): boolean {
    return this.current
  }

  registerOperation(
    _owner: RendererOwner,
    _root: HostPath,
    _operationId: string,
    revoke: () => void,
  ) {
    this.revokeOperation = revoke
    return { release: () => undefined }
  }

  revoke(): void {
    this.current = false
    this.revokeOperation?.()
  }
}

function wrapHost(host: LocalHost, overrides: Partial<ProjectHost>): ProjectHost {
  return new Proxy(host, {
    get(target, property) {
      const override = overrides[property as keyof ProjectHost]
      if (override !== undefined) return override
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function'
        ? (...args: readonly unknown[]): unknown => Reflect.apply(value, target, args)
        : value
    },
  })
}

function progressPublisher() {
  const waiters = new Map<
    ProjectFileOperationProgress['phase'],
    (progress: ProjectFileOperationProgress) => void
  >()
  const publish = vi.fn<(progress: ProjectFileOperationProgress) => void>((progress) => {
    waiters.get(progress.phase)?.(progress)
    waiters.delete(progress.phase)
  })
  return Object.assign(publish, {
    waitForPhase(
      phase: ProjectFileOperationProgress['phase'],
    ): Promise<ProjectFileOperationProgress> {
      const observed = publish.mock.calls.find(([progress]) => progress.phase === phase)
      if (observed) return Promise.resolve(observed[0])
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${phase}`)),
          2_000,
        )
        waiters.set(phase, (progress) => {
          clearTimeout(timer)
          resolve(progress)
        })
      })
    },
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let startedResolve!: () => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  const started = new Promise<void>((settle) => {
    startedResolve = settle
  })
  return {
    promise,
    started,
    start: startedResolve,
    resolve: (value?: T) => resolve(value as T),
  }
}
