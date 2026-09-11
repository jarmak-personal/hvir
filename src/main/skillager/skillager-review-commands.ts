import { randomUUID } from 'node:crypto'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type {
  SkillagerAcceptance,
  SkillagerHistory,
  SkillagerReviewDiff,
} from '../../shared/skillager-review'
import { SkillagerError, type SkillagerCliSelection } from './skillager-port'
import {
  SkillagerProcess,
  SKILLAGER_PROBE_LIMITS,
  SKILLAGER_SEARCH_LIMITS,
} from './skillager-process'
import { parseSkillagerJson } from './skillager-cli-metadata'
import {
  parseAcceptancePreview,
  parseReviewAccepted,
  parseReviewDiff,
  parseReviewHistory,
  reviewSkillRoot,
  verifySnapshotLibrary,
  verifySnapshotPreview,
} from './skillager-review-contract'
import {
  captureSkillagerTree,
  type SkillagerSnapshotHost,
} from './skillager-review-snapshot'
import type {
  SkillagerReviewCliPort,
  SkillagerReviewSnapshot,
} from './skillager-review-port'

/** Public CLI composition; original library tokens never become renderer argv. */
export class SkillagerReviewCommands implements SkillagerReviewCliPort {
  constructor(
    private readonly host: SkillagerSnapshotHost,
    private readonly process: SkillagerProcess,
    private readonly context: HostPath,
    private readonly validate: (
      selection: SkillagerCliSelection,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  async review(
    selection: SkillagerCliSelection,
    skillId: string,
    signal: AbortSignal,
  ): Promise<SkillagerReviewSnapshot> {
    await this.validate(selection, signal)
    const root = reviewSkillRoot(selection.library!, skillId)
    const preview = parseAcceptancePreview(
      await this.command(selection, ['library', 'accept', skillId, '--json'], signal),
      skillId,
      root,
    )
    const history = await this.history(selection, skillId, signal)
    const scratch = joinHostPath(this.context, `review-${randomUUID()}`)
    let removed = false
    const dispose = async (): Promise<void> => {
      if (removed) return
      const result = await this.host.exec('rm', ['-rf', '--', scratch.path], {
        signal: AbortSignal.timeout(10_000),
        maxBuffer: 64 * 1024,
      })
      if (result.code !== 0)
        throw new SkillagerError(
          'command-failed',
          'Could not remove the private review snapshot.',
        )
      removed = true
    }
    try {
      await this.process.run(
        'mkdir',
        ['-m', '700', '--', scratch.path],
        { signal },
        SKILLAGER_PROBE_LIMITS,
      )
      const privateInvocation = {
        ...selection,
        catalog: joinHostPath(scratch, 'catalog'),
      }
      const privateLibrary = joinHostPath(scratch, 'library')
      verifySnapshotLibrary(
        await this.command(
          privateInvocation,
          ['library', 'init', '--path', privateLibrary.path, '--no-git', '--json'],
          signal,
        ),
        privateLibrary,
      )
      const snapshotRoot = joinHostPath(privateLibrary, 'skills', skillId.slice(4))
      const captured = await captureSkillagerTree(this.host, root, snapshotRoot, signal)
      const snapshotPreview = await this.command(
        privateInvocation,
        ['library', 'accept', skillId, '--json'],
        signal,
      ).catch((error: unknown) => {
        if (error instanceof SkillagerError && error.reason === 'command-failed')
          throw new SkillagerError(
            'review-refused',
            'Skillager could not verify the captured canonical tree. Check unsupported or excluded entries, then review again.',
          )
        throw error
      })
      verifySnapshotPreview(snapshotPreview, skillId, snapshotRoot, preview.hash)
      await this.validate(selection, signal)
      signal.throwIfAborted()
      // The CLI has verified bytes written from the retained buffers. Delete mutable
      // scratch now; subsequent viewer reads use only those verified buffers.
      await dispose()
      const { confirmationToken: _token, ...publicPreview } = preview
      return {
        detail: { skillId, root, ...publicPreview, files: captured.files, history },
        bytes: captured.bytes,
        confirmationToken: preview.confirmationToken,
        dispose: async () => {
          captured.bytes.clear()
          await dispose()
        },
      }
    } catch (error) {
      try {
        await dispose()
      } catch {
        throw new SkillagerError(
          'command-failed',
          'Review failed and private snapshot cleanup is incomplete. Disconnect Skillager before retrying.',
        )
      }
      throw error
    }
  }

  async history(
    selection: SkillagerCliSelection,
    skillId: string,
    signal: AbortSignal,
  ): Promise<SkillagerHistory> {
    await this.validate(selection, signal)
    const root = reviewSkillRoot(selection.library!, skillId)
    const result = parseReviewHistory(
      await this.command(selection, ['library', 'history', skillId, '--json'], signal),
      skillId,
      root,
    )
    await this.validate(selection, signal)
    return result
  }

  async diff(
    selection: SkillagerCliSelection,
    snapshot: SkillagerReviewSnapshot,
    fromHash: string | undefined,
    signal: AbortSignal,
  ): Promise<SkillagerReviewDiff> {
    await this.validate(selection, signal)
    const { skillId, root, hash, history } = snapshot.detail
    if (!history.available || !history.versions.length)
      throw new SkillagerError(
        'unavailable',
        'No previous version is available. Review the full skill tree.',
      )
    if (fromHash && !history.versions.some((version) => version.hash === fromHash))
      throw new SkillagerError('invalid-request', 'Select a listed library version.')
    const data = await this.command(
      selection,
      ['library', 'diff', skillId, ...(fromHash ? ['--from', fromHash] : []), '--json'],
      signal,
    )
    await this.validate(selection, signal)
    return parseReviewDiff(data, skillId, root, hash)
  }

  async accept(
    selection: SkillagerCliSelection,
    snapshot: SkillagerReviewSnapshot,
    signal: AbortSignal,
  ): Promise<SkillagerAcceptance> {
    await this.validate(selection, signal)
    if (!snapshot.detail.canAccept || !snapshot.confirmationToken)
      throw new SkillagerError(
        'review-refused',
        snapshot.detail.refusal ?? 'This version is already accepted.',
      )
    signal.throwIfAborted()
    const { skillId, root, hash } = snapshot.detail
    let output
    try {
      output = await this.process.runResult(
        selection.executable.path,
        [
          '--catalog-state-dir',
          selection.catalog.path,
          '--state-dir',
          selection.catalog.path,
          'library',
          'accept',
          skillId,
          '--yes',
          '--confirmation-token',
          snapshot.confirmationToken,
          '--json',
        ],
        { cwd: this.context, signal, env: selection.environment },
        SKILLAGER_SEARCH_LIMITS,
      )
    } catch (error) {
      if (error instanceof SkillagerError && error.reason === 'busy') throw error
      throw uncertain()
    }
    if (output.code !== 0) {
      if (/preview is stale|changed since the acceptance preview/.test(output.stderr))
        throw new SkillagerError(
          'stale-review',
          'The library changed since review. Review the new version before accepting.',
        )
      if (
        /requires --override-lint|unresolved conflicts|in-progress .* operation|has staged changes/.test(
          output.stderr,
        )
      )
        throw new SkillagerError(
          'review-refused',
          'Skillager refused acceptance. Resolve scanner, lint, or Git requirements in your local terminal, then review again.',
        )
      throw uncertain()
    }
    try {
      return parseReviewAccepted(parseSkillagerJson(output.stdout), skillId, root, hash)
    } catch {
      throw uncertain()
    }
  }

  private async command(
    selection: SkillagerCliSelection,
    args: readonly string[],
    signal: AbortSignal,
  ): Promise<unknown> {
    return parseSkillagerJson(
      await this.process.run(
        selection.executable.path,
        [
          '--catalog-state-dir',
          selection.catalog.path,
          '--state-dir',
          selection.catalog.path,
          ...args,
        ],
        { cwd: this.context, signal, env: selection.environment },
        SKILLAGER_SEARCH_LIMITS,
      ),
    )
  }
}
function uncertain(): SkillagerError {
  return new SkillagerError(
    'uncertain',
    'Acceptance may have completed. Refresh library state before starting another review; do not retry this confirmation.',
  )
}
