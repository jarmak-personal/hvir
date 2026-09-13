import { createHash, randomUUID } from 'node:crypto'
import {
  containsHostPath,
  hostPathEquals,
  joinHostPath,
  localPath,
  type HostPath,
} from '../../shared/host-path'
import type {
  SkillagerAgent,
  SkillagerRequest,
  SkillagerWorkspaceExposure,
} from '../../shared/skillager'
import { parseSkillagerJson, parseSkillagerShow } from './skillager-cli-metadata'
import { SkillagerError, type SkillagerCliSelection } from './skillager-port'
import {
  SkillagerProcess,
  SKILLAGER_PROBE_LIMITS,
  SKILLAGER_SEARCH_LIMITS,
} from './skillager-process'
import {
  captureSkillagerTree,
  type SkillagerSnapshotHost,
} from './skillager-review-snapshot'
import type { SkillagerReviewCliPort } from './skillager-review-port'
import type {
  SkillagerNativePort,
  SkillagerNativeSnapshot,
} from './skillager-native-port'
import { safeExposureId } from './skillager-exposure-selection'

const SIDECAR = 'skillager.materialized.yaml'

/** Released public native projection, proven against D4's retained CLI-verified tree. */
export class SkillagerNativeCommands implements SkillagerNativePort {
  constructor(
    private readonly host: SkillagerSnapshotHost,
    private readonly process: SkillagerProcess,
    private readonly context: HostPath,
    private readonly review: Pick<SkillagerReviewCliPort, 'review'>,
    private readonly validate: (
      selection: SkillagerCliSelection,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly exposures: (
      selection: SkillagerCliSelection,
      request: SkillagerRequest,
      signal: AbortSignal,
    ) => Promise<readonly SkillagerWorkspaceExposure[] | undefined>,
  ) {}

  async nativeSnapshot(
    selection: SkillagerCliSelection,
    skillId: string,
    agent: SkillagerAgent,
    signal: AbortSignal,
  ): Promise<SkillagerNativeSnapshot> {
    const verified = await this.review.review(selection, skillId, signal)
    const scratch = joinHostPath(this.context, `native-${randomUUID()}`)
    let created = false
    const cleanup = async (): Promise<void> => {
      if (!created) return
      const result = await this.host.exec(
        'rm',
        ['-rf', '--', scratch.path],
        { signal: AbortSignal.timeout(10_000), maxBuffer: 4096 },
      )
      if (result.code !== 0) throw new Error('Native scratch cleanup failed')
      created = false
    }
    try {
      if (
        verified.detail.canAccept ||
        verified.bytes.has(SIDECAR) ||
        verified.bytes.has('.hvir-skillager.json')
      )
        refuse(
          'Accept the current canonical version first, and remove any reserved delivery record from the source.',
        )
      const metadata = await this.source(selection, skillId, signal)
      if (metadata.row.contentHash !== verified.detail.hash) stale()
      await this.process.run(
        'mkdir',
        ['-m', '700', '--', scratch.path],
        { signal },
        SKILLAGER_PROBE_LIMITS,
      )
      created = true
      const workspace = joinHostPath(scratch, 'workspace')
      await this.host.createDirectoryExclusive(workspace, { mode: 0o755, signal })
      const output = await this.command(
        selection,
        [
          'expose',
          skillId,
          '--mode',
          'native',
          '--agent',
          agent,
          '--scope',
          'project',
          '--json',
        ],
        workspace,
        joinHostPath(scratch, 'state'),
        signal,
      )
      const projected = projection(output, workspace, skillId, agent)
      const captured = await captureSkillagerTree(
        this.host,
        projected.target,
        joinHostPath(scratch, 'captured'),
        signal,
      )
      try {
        const expectedDirectories = new Set([''])
        for (const file of verified.detail.files) {
          const parts = file.entry.split('/')
          for (let length = 1; length < parts.length; length++)
            expectedDirectories.add(parts.slice(0, length).join('/'))
        }
        if (
          captured.entries.some(
            (entry) =>
              entry.type === 'directory' && !expectedDirectories.has(entry.relativePath),
          )
        )
          refuse('The native projection contains unexpected directories.')
        const projectedFiles = captured.files.filter((file) => file.entry !== SIDECAR)
        if (
          projectedFiles.length !== verified.detail.files.length ||
          !captured.bytes.has(SIDECAR)
        )
          refuse('The native projection file set does not match the verified source.')
        for (const file of verified.detail.files) {
          const actual = projectedFiles.find(
            (candidate) => candidate.entry === file.entry,
          )
          if (
            !actual ||
            actual.size !== file.size ||
            actual.executable !== file.executable ||
            !Buffer.from(verified.bytes.get(file.entry)!).equals(
              Buffer.from(captured.bytes.get(file.entry)!),
            )
          )
            refuse(
              'The native projection differs from the verified source bytes or modes.',
            )
        }
        const listed = await this.exposures(
          selection,
          {
            connectionId: 'native-staging',
            requestId: 0,
            workspaceRoot: workspace,
            agent,
          },
          signal,
        )
        const matches =
          listed?.filter((entry) => hostPathEquals(entry.target, projected.target)) ?? []
        if (
          matches.length !== 1 ||
          matches[0]!.id !== projected.id ||
          matches[0]!.skillId !== skillId ||
          matches[0]!.mode !== 'native' ||
          matches[0]!.status !== 'current' ||
          matches[0]!.currentHash !== verified.detail.hash
        )
          refuse(
            'Skillager could not verify the native projection at the accepted source version.',
          )
        await this.validateNativeSource(
          selection,
          { skillId, sourceHash: verified.detail.hash },
          false,
          signal,
        )
        await cleanup()
        return {
          skillId,
          sourceHash: verified.detail.hash,
          pinned: metadata.row.trust === 'pinned',
          targetEntry: projected.target.path.slice(workspace.path.length + 1),
          exposureId: projected.id,
          tree: {
            files: verified.detail.files.map((file) => ({
              entry: file.entry,
              mode: file.executable ? 0o755 : 0o644,
              size: file.size,
              sha256: createHash('sha256')
                .update(verified.bytes.get(file.entry)!)
                .digest('hex'),
            })),
          },
          bytes: verified.bytes,
          declarations: metadata.declarations,
          dispose: () => verified.dispose(),
        }
      } finally {
        captured.bytes.clear()
      }
    } catch (error) {
      await Promise.allSettled([
        Promise.resolve().then(() => verified.dispose()),
        cleanup(),
      ])
      throw error
    }
  }

  async validateNativeSource(
    selection: SkillagerCliSelection,
    snapshot: Pick<SkillagerNativeSnapshot, 'skillId' | 'sourceHash'>,
    advancing: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const { row } = await this.source(selection, snapshot.skillId, signal)
    if (row.contentHash !== snapshot.sourceHash) stale()
    if (advancing && row.trust === 'pinned')
      refuse(
        'Pinned source · update unavailable. Manage source pins in your local terminal.',
      )
  }

  private async source(
    selection: SkillagerCliSelection,
    skillId: string,
    signal: AbortSignal,
  ) {
    await this.validate(selection, signal)
    const result = parseSkillagerShow(
      await this.command(
        selection,
        ['show', skillId, '--json', '--full-json'],
        this.context,
        selection.catalog,
        signal,
      ),
      selection.library!,
    )
    if (
      result.row.id !== skillId ||
      !['reviewed', 'trusted', 'pinned'].includes(result.row.trust)
    )
      refuse('The canonical source is unavailable or requires acceptance.')
    await this.validate(selection, signal)
    return result
  }

  private async command(
    selection: SkillagerCliSelection,
    args: readonly string[],
    cwd: HostPath,
    state: HostPath,
    signal: AbortSignal,
  ): Promise<unknown> {
    return parseSkillagerJson(
      await this.process.run(
        selection.executable.path,
        [
          '--catalog-state-dir',
          selection.catalog.path,
          '--state-dir',
          state.path,
          ...args,
        ],
        { cwd, signal, env: selection.environment },
        SKILLAGER_SEARCH_LIMITS,
      ),
    )
  }
}

function projection(
  payload: unknown,
  workspace: HostPath,
  skillId: string,
  agent: SkillagerAgent,
) {
  if (!Array.isArray(payload) || payload.length !== 1)
    refuse('Skillager returned an unsupported native projection.')
  const row = payload[0] as Record<string, unknown>
  if (
    row.schema !== 'skillager.exposure-result.v1' ||
    row.status !== 'exposed' ||
    row.skill_id !== skillId ||
    row.agent !== agent ||
    row.scope !== 'project' ||
    row.mode !== 'native' ||
    typeof row.target !== 'string' ||
    !safeExposureId(row.exposure_id)
  )
    refuse(
      'Skillager did not expose this skill for the selected agent. Check source acceptance and declared compatibility.',
    )
  const target = localPath(row.target)
  if (
    target.path !== row.target ||
    !containsHostPath(workspace, target) ||
    target.path === workspace.path ||
    target.path.split('/').at(-1) !== row.exposure_id
  )
    refuse('Skillager returned an invalid native target.')
  return { target, id: row.exposure_id }
}
function refuse(message: string): never {
  throw new SkillagerError('review-refused', message)
}
function stale(): never {
  throw new SkillagerError(
    'stale-review',
    'The canonical source changed. Start a fresh preview.',
  )
}
