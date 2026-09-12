import type { HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { SkillagerError } from './skillager-port'
import {
  deploymentKey,
  parseDeploymentFile,
  parseStoredTarget,
  SKILLAGER_MAX_DEPLOYMENTS,
  type SkillagerStoredTarget,
} from './skillager-deployment-record'

const MAX_BYTES = 8 * 1024 * 1024

/** Lazy local authority, atomic persistence, one admitted write and no write queue. */
export class SkillagerDeploymentStore {
  private readonly records = new Map<string, SkillagerStoredTarget>()
  private loading?: Promise<void>
  private write?: Promise<void>
  private unavailable = false
  private disposed = false
  constructor(
    private readonly host: Pick<
      ProjectHost,
      'hostId' | 'readTextFilePrefix' | 'writeFile'
    >,
    private readonly file: HostPath,
  ) {
    if (host.hostId !== 'local' || file.hostId !== 'local')
      throw Error('Deployment authority must be local')
  }
  async read(): Promise<readonly SkillagerStoredTarget[]> {
    await this.load()
    this.available()
    return structuredClone([...this.records.values()])
  }
  async save(
    key: string,
    expectedRevision: number,
    target: Omit<SkillagerStoredTarget, 'revision'> | undefined,
  ): Promise<SkillagerStoredTarget | undefined> {
    await this.load()
    this.available()
    if (this.write)
      throw new SkillagerError(
        'busy',
        'A deployment receipt is being saved. Try again shortly.',
      )
    if ((this.records.get(key)?.revision ?? 0) !== expectedRevision)
      throw new SkillagerError(
        'stale-review',
        'The local deployment record changed. Refresh and preview again.',
      )
    const candidate = target
      ? parseStoredTarget({ ...target, revision: expectedRevision + 1 })
      : undefined
    if (candidate && deploymentKey(candidate.identity) !== key)
      throw new SkillagerError(
        'invalid-request',
        'Deployment destination identity changed.',
      )
    const next = new Map(this.records)
    if (candidate) next.set(key, candidate)
    else next.delete(key)
    if (next.size > SKILLAGER_MAX_DEPLOYMENTS)
      throw new SkillagerError(
        'output-limit',
        'The local deployment record limit was reached.',
      )
    const content = JSON.stringify({ version: 1, targets: [...next.values()] }) + '\n'
    if (Buffer.byteLength(content) > MAX_BYTES)
      throw new SkillagerError(
        'output-limit',
        'The deployment records exceed their supported size.',
      )
    this.write = this.host
      .writeFile(this.file, content, { signal: AbortSignal.timeout(10_000) })
      .then(() => {
        this.records.clear()
        for (const [key, value] of next) this.records.set(key, value)
      })
    try {
      await this.write
      return candidate ? structuredClone(candidate) : undefined
    } catch {
      this.unavailable = true
      throw new SkillagerError(
        'uncertain',
        'The local deployment receipt could not be saved. Reopen the feature after restoring its local records before another action.',
      )
    } finally {
      this.write = undefined
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true
    await this.write?.catch(() => undefined)
    await this.loading?.catch(() => undefined)
    this.records.clear()
  }
  private load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const result = await this.host.readTextFilePrefix(this.file, MAX_BYTES)
        if (!result.complete) throw Error('Deployment store exceeds its bound')
        const targets = parseDeploymentFile(JSON.parse(result.content) as unknown)
        for (const target of targets)
          this.records.set(deploymentKey(target.identity), target)
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'ENOENT'
        )
          this.unavailable = true
      }
    })()
    return this.loading
  }
  private available(): void {
    if (this.disposed)
      throw new SkillagerError('cancelled', 'Deployment records are closed.')
    if (this.unavailable)
      throw new SkillagerError(
        'unavailable',
        'Local deployment records are unavailable or unsupported. Existing remote copies are protected; restore the local records before managing them.',
      )
  }
}
