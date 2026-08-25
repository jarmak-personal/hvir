import { randomUUID } from 'node:crypto'

import {
  hostPathEquals,
  hostPath,
  asHostId,
  isProjectFileEntryName,
  joinHostPath,
  type BrowseHostResponse,
  type HostPath,
  type ProjectFolderPickerLease,
} from '../../shared'
import {
  isProjectPathExistsError,
  type Disposer,
  type ProjectHost,
} from '../project-host'
import type {
  RendererOwner,
  RendererResourceLease,
  RendererResourceScopes,
} from '../renderer-resource-scopes'

export interface ProjectFolderPickerProjects {
  hostById(hostId: string): ProjectHost | undefined
  browseHost(hostId: string, path: string): Promise<BrowseHostResponse>
}

interface PickerRecord {
  readonly id: string
  readonly owner: RendererOwner
  readonly host: ProjectHost
  readonly stopHostState: Disposer
  lease?: RendererResourceLease
  selectionGeneration: number
  selectedParent?: HostPath
  createAbort?: AbortController
  active: boolean
}

/** Owns bounded pre-registration directory authority for the project folder picker. */
export class ProjectFolderPickerCoordinator {
  private readonly activeByOwner = new Map<string, PickerRecord>()

  constructor(
    private readonly projects: ProjectFolderPickerProjects,
    private readonly resources: RendererResourceScopes,
  ) {}

  async start(owner: RendererOwner, hostId: string): Promise<ProjectFolderPickerLease> {
    this.resources.assertCurrent(owner)
    const host = this.projects.hostById(hostId)
    if (!host || host.connectionState !== 'connected') {
      throw new Error(`Connect to ${hostId} before choosing a project folder`)
    }
    await this.closeCurrent(owner)
    this.resources.assertCurrent(owner)
    if (this.projects.hostById(hostId) !== host || host.connectionState !== 'connected') {
      throw stalePickerError()
    }

    let stopHostState: Disposer = () => undefined
    const record: PickerRecord = {
      id: randomUUID(),
      owner,
      host,
      stopHostState: () => stopHostState(),
      selectionGeneration: 0,
      active: true,
    }
    stopHostState = host.onConnectionState((state) => {
      if (state !== 'connected') {
        void record.lease?.dispose().catch(() => undefined)
      }
    })
    try {
      record.lease = this.resources.register(
        owner,
        { lifetime: 'renderer', type: 'project-folder-picker' },
        () => this.revoke(record),
      )
      this.activeByOwner.set(ownerKey(owner), record)
      return { pickerId: record.id }
    } catch (error) {
      await record.stopHostState()
      throw error
    }
  }

  async browse(
    owner: RendererOwner,
    pickerId: string,
    path: string,
  ): Promise<BrowseHostResponse> {
    const record = this.requireCurrent(owner, pickerId)
    if (record.createAbort) throw new Error('A folder is already being created')
    const selectionGeneration = (record.selectionGeneration += 1)
    record.selectedParent = undefined
    const result = await this.projects.browseHost(record.host.hostId, path)
    this.assertStillCurrent(record)
    if (result.path.hostId !== record.host.hostId) throw stalePickerError()
    if (
      record.selectionGeneration !== selectionGeneration ||
      record.createAbort
    ) {
      throw new Error('Select the destination folder again')
    }
    record.selectedParent = result.path
    return result
  }

  async createDirectory(
    owner: RendererOwner,
    pickerId: string,
    destinationParent: HostPath,
    name: string,
  ): Promise<HostPath> {
    if (!isProjectFileEntryName(name)) throw new Error('Invalid directory name')
    const record = this.requireCurrent(owner, pickerId)
    if (
      !destinationParent ||
      typeof destinationParent.hostId !== 'string' ||
      typeof destinationParent.path !== 'string' ||
      destinationParent.hostId !== record.host.hostId ||
      !destinationParent.path.startsWith('/')
    ) {
      throw new Error('Invalid destination folder')
    }
    const requestedParent = hostPath(
      asHostId(destinationParent.hostId),
      destinationParent.path,
    )
    if (
      !record.selectedParent ||
      !hostPathEquals(record.selectedParent, requestedParent)
    ) {
      throw new Error('Select the destination folder again')
    }
    if (record.createAbort) throw new Error('A folder is already being created')

    const abort = new AbortController()
    record.createAbort = abort
    try {
      const canonicalParent = await record.host.realpath(requestedParent)
      this.assertStillCurrent(record)
      if (!hostPathEquals(canonicalParent, record.selectedParent)) {
        throw new Error('Select the destination folder again')
      }
      const parentStat = await record.host.stat(canonicalParent)
      this.assertStillCurrent(record)
      if (parentStat.type !== 'dir') {
        throw new Error('The selected folder is unavailable')
      }

      const destination = joinHostPath(canonicalParent, name)
      await record.host.createDirectoryExclusive(destination, {
        mode: 0o755,
        signal: abort.signal,
      })
      this.assertStillCurrent(record)
      record.selectedParent = destination
      return destination
    } catch (error) {
      if (isProjectPathExistsError(error)) {
        throw new Error('The destination already exists', { cause: error })
      }
      throw error
    } finally {
      if (record.createAbort === abort) record.createAbort = undefined
    }
  }

  async close(owner: RendererOwner, pickerId: string): Promise<void> {
    const record = this.activeByOwner.get(ownerKey(owner))
    if (!record || record.id !== pickerId) return
    await record.lease?.dispose()
  }

  private requireCurrent(owner: RendererOwner, pickerId: string): PickerRecord {
    this.resources.assertCurrent(owner)
    const record = this.activeByOwner.get(ownerKey(owner))
    if (!record || record.id !== pickerId) throw stalePickerError()
    this.assertStillCurrent(record)
    return record
  }

  private assertStillCurrent(record: PickerRecord): void {
    if (
      !record.active ||
      !this.resources.isCurrent(record.owner) ||
      this.activeByOwner.get(ownerKey(record.owner)) !== record ||
      this.projects.hostById(record.host.hostId) !== record.host ||
      record.host.connectionState !== 'connected'
    ) {
      throw stalePickerError()
    }
  }

  private closeCurrent(owner: RendererOwner): Promise<void> {
    return this.activeByOwner.get(ownerKey(owner))?.lease?.dispose() ?? Promise.resolve()
  }

  private async revoke(record: PickerRecord): Promise<void> {
    if (!record.active) return
    record.active = false
    record.selectionGeneration += 1
    record.selectedParent = undefined
    record.createAbort?.abort(stalePickerError())
    record.createAbort = undefined
    await record.stopHostState()
    if (this.activeByOwner.get(ownerKey(record.owner)) === record) {
      this.activeByOwner.delete(ownerKey(record.owner))
    }
  }
}

function ownerKey(owner: RendererOwner): string {
  return `${owner.id}:${owner.generation}`
}

function stalePickerError(): Error {
  return new Error('The project folder picker is no longer active')
}
