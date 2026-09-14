import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import {
  SKILLAGER_INVENTORY_LIMIT,
  SKILLAGER_SEARCH_LIMIT,
  type SkillagerSearchRequest,
  type SkillagerSearchRows,
  type SkillagerWorkspaceExposure,
} from '../../shared/skillager'
import { skillagerLibrarySkillRoot } from './skillager-library-identity'
import type { ProjectFileTransferPort } from '../project-host/project-host'
import { SkillagerError, type SkillagerCliSelection } from './skillager-port'
import { SkillagerProcess, SKILLAGER_SEARCH_LIMITS } from './skillager-process'
import { parseSkillagerJson, parseSkillagerSearch } from './skillager-cli-metadata'
import { parseSkillagerSearchView } from './skillager-search-contract'

/** One selected CLI request; temporary exclusions contain identities, never SSH paths. */
export class SkillagerSearchCommands {
  constructor(
    private readonly host: {
      readonly fileTransfer?: Pick<ProjectFileTransferPort, 'writeFileChunksExclusive'>
    },
    private readonly process: SkillagerProcess,
    private readonly context: HostPath,
    private readonly validate: (
      selection: SkillagerCliSelection,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly cleanup: (path: HostPath) => Promise<void>,
  ) {}

  async search(
    selection: SkillagerCliSelection,
    request: SkillagerSearchRequest,
    signal: AbortSignal,
    remote?: { readonly exposures: readonly SkillagerWorkspaceExposure[] | undefined },
  ): Promise<SkillagerSearchRows> {
    const legacy = request.view === 'legacy'
    if (!legacy && selection.searchView !== 'skillager.search.v1')
      throw new SkillagerError(
        'search-unsupported',
        'Installed Skillager does not support known-skill grouping and installed filtering. You can explicitly search with its legacy behavior.',
      )
    await this.validate(selection, signal)
    const personal = request.scope === 'library'
    const identities =
      remote && !legacy ? installedIdentities(remote.exposures, selection) : undefined
    let scratch: HostPath | undefined
    const outcome = await (async () => {
      if (identities) {
        if (!this.host.fileTransfer)
          throw new SkillagerError(
            'unavailable',
            'Local search input storage is unavailable.',
          )
        scratch = joinHostPath(this.context, `search-installed-${randomUUID()}.json`)
        const bytes = Buffer.from(
          JSON.stringify({ schema: 'skillager.search-installed.v1', identities }),
        )
        if (bytes.length > 2 * 1024 * 1024)
          throw new SkillagerError(
            'output-limit',
            'Recorded skill identities exceed the search input limit.',
          )
        await this.host.fileTransfer.writeFileChunksExclusive(
          scratch,
          Readable.from([bytes]),
          { mode: 0o644, signal },
        )
      }
      signal.throwIfAborted()
      const output = await this.process.runResult(
        selection.executable.path,
        [
          '--catalog-state-dir',
          selection.catalog.path,
          ...(personal ? ['--state-dir', selection.catalog.path] : []),
          'search',
          '--scope',
          request.scope,
          ...(request.browseAgent === 'all'
            ? []
            : ['--agent', request.browseAgent ?? request.agent]),
          '--limit',
          String(SKILLAGER_SEARCH_LIMIT),
          '--json',
          ...(legacy
            ? ['--full-json']
            : [
                '--view',
                request.view ?? 'skills',
                ...(request.includeInstalled ? ['--include-installed'] : []),
                ...(request.workspaceRoot.hostId === 'local'
                  ? ['--installed-project', request.workspaceRoot.path]
                  : []),
                ...(scratch ? ['--installed-identities', scratch.path] : []),
              ]),
          '--',
          request.query,
        ],
        {
          cwd: personal ? this.context : request.workspaceRoot,
          signal,
          env: selection.environment,
        },
        SKILLAGER_SEARCH_LIMITS,
      )
      await this.validate(selection, signal)
      if (!legacy)
        return parseSkillagerSearchView(
          parseSkillagerJson(output.stdout),
          output.code,
          selection.library!,
          request,
          Boolean(scratch),
        )
      if (output.code !== 0)
        throw new SkillagerError(
          'command-failed',
          'Skillager could not complete the legacy search.',
        )
      return {
        rows: parseSkillagerSearch(
          parseSkillagerJson(output.stdout),
          selection.library!,
          personal,
          request.workspaceRoot,
        ),
        search: {
          scope: request.scope,
          browseAgent: request.browseAgent ?? request.agent,
          view: 'legacy' as const,
          includeInstalled: true,
          installedObservation: 'legacy' as const,
          coverage: 'none' as const,
        },
      }
    })().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    if (scratch) {
      try {
        await this.cleanup(scratch)
      } catch (error) {
        if (outcome.ok) throw error
        throw new SkillagerError(
          outcome.error instanceof SkillagerError
            ? outcome.error.reason
            : 'command-failed',
          `${outcome.error instanceof SkillagerError ? outcome.error.message : 'Search failed.'} Temporary search input cleanup also failed.`,
        )
      }
    }
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }
}

/** Presence covers hvir's recorded deliveries, including modified and older copies. */
function installedIdentities(
  exposures: readonly SkillagerWorkspaceExposure[] | undefined,
  selection: SkillagerCliSelection,
): readonly { library_id: string; skill_id: string }[] | undefined {
  if (!exposures) return undefined
  if (exposures.length > SKILLAGER_INVENTORY_LIMIT)
    throw new SkillagerError(
      'output-limit',
      'Recorded skill identities exceed the search input limit.',
    )
  const result = new Map<string, { library_id: string; skill_id: string }>()
  for (const copy of exposures) {
    if (copy.reconciliation || copy.status === 'uncertain') return undefined
    if (['absent', 'removed'].includes(copy.status)) continue
    if (
      copy.sourceLibraryId !== selection.library!.id ||
      !copy.skillId ||
      copy.mode !== 'native' ||
      ![
        'current',
        'source_update',
        'source_unavailable',
        'source_unverified',
        'local_edit',
      ].includes(copy.status)
    )
      return undefined
    try {
      skillagerLibrarySkillRoot(selection.library!, copy.skillId)
    } catch {
      return undefined
    }
    result.set(copy.skillId, { library_id: copy.sourceLibraryId, skill_id: copy.skillId })
  }
  return [...result.values()]
}
