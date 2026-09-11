import { SkillagerExposureCommands } from './skillager-exposure-commands'
import type { SkillagerExposureRequest } from '../../shared/skillager-exposure'
import type { SkillagerExposureSnapshot } from './skillager-exposure-port'
import { SkillagerReviewCommands } from './skillager-review-commands'
import type { SkillagerSnapshotHost } from './skillager-review-snapshot'
import type { SkillagerReviewSnapshot } from './skillager-review-port'
import { SkillagerError } from './skillager-port'
import { randomUUID } from 'node:crypto'
import {
  hostPathEquals,
  joinHostPath,
  localPath,
  type HostPath,
} from '../../shared/host-path'
import type {
  SkillagerLibrary,
  SkillagerMetadata,
  SkillagerRequest,
  SkillagerSearchRequest,
  SkillagerWorkspaceExposure,
} from '../../shared/skillager'
import type { ProjectHost } from '../project-host/project-host'
import {
  parseSkillagerInventory,
  parseSkillagerJson,
  parseSkillagerLibrary,
  parseSkillagerSearch,
  parseSkillagerExposures,
} from './skillager-cli-metadata'
import {
  SkillagerProcess,
  SKILLAGER_PROBE_LIMITS,
  SKILLAGER_SEARCH_LIMITS,
  SKILLAGER_INVENTORY_LIMITS,
} from './skillager-process'

import type { SkillagerCliPort, SkillagerCliSelection } from './skillager-port'

const MARKER = '\x1ehvir-skillager-probe\x1f'
// Only this fixed command is interpreted by the login shell. The selected path
// remains environment data; POSIX expansion belongs to the explicit /bin/sh child.
const RESOLVE = `/bin/sh -c 'printf "\\036hvir-skillager-probe\\037"; resolved=$(command -v -- "$HVIR_SKILLAGER_PROBE_EXECUTABLE" || true); printf "%s\\0" "$resolved" "\${SKILLAGER_CATALOG_STATE_DIR:-\${XDG_CONFIG_HOME:-$HOME/.config}/skillager}"; /usr/bin/env -0'`

/** Local CLI mechanics. Its private cwd is never presented as a workspace destination. */
export class SkillagerCli implements SkillagerCliPort {
  private readonly process: SkillagerProcess
  private readonly context: HostPath
  private prepared?: Promise<void>
  private disposed = false
  private contextRequested = false
  private readonly operations = new Set<Promise<unknown>>()
  private disposal?: Promise<void>

  constructor(
    private readonly host: SkillagerSnapshotHost & Pick<ProjectHost, 'defaultShell'>,
    stateParent: HostPath,
  ) {
    if (host.hostId !== 'local' || stateParent.hostId !== 'local')
      throw new Error('Skillager requires the local host.')
    this.process = new SkillagerProcess(host)
    this.context = joinHostPath(stateParent, `skillager-${randomUUID()}`)
  }

  probe(
    selected: HostPath | undefined,
    signal: AbortSignal,
  ): Promise<SkillagerCliSelection> {
    return this.operate(() => this.probeLocal(selected, signal))
  }
  validate(selection: SkillagerCliSelection, signal: AbortSignal): Promise<void> {
    return this.operate(() => this.validateLocal(selection, signal))
  }
  inventory(
    selection: SkillagerCliSelection,
    signal: AbortSignal,
  ): Promise<readonly SkillagerMetadata[]> {
    return this.operate(() => this.inventoryLocal(selection, signal))
  }
  search(
    selection: SkillagerCliSelection,
    request: SkillagerSearchRequest,
    signal: AbortSignal,
  ): Promise<readonly SkillagerMetadata[]> {
    return this.operate(() => this.searchLocal(selection, request, signal))
  }
  exposures(
    selection: SkillagerCliSelection,
    request: SkillagerRequest,
    signal: AbortSignal,
  ): Promise<readonly SkillagerWorkspaceExposure[] | undefined> {
    return this.operate(() => this.exposuresLocal(selection, request, signal))
  }

  review(selection: SkillagerCliSelection, skillId: string, signal: AbortSignal) {
    return this.operate(() => this.reviewCommands().review(selection, skillId, signal))
  }
  history(selection: SkillagerCliSelection, skillId: string, signal: AbortSignal) {
    return this.operate(() => this.reviewCommands().history(selection, skillId, signal))
  }
  diff(
    selection: SkillagerCliSelection,
    snapshot: SkillagerReviewSnapshot,
    fromHash: string | undefined,
    signal: AbortSignal,
  ) {
    return this.operate(() =>
      this.reviewCommands().diff(selection, snapshot, fromHash, signal),
    )
  }
  accept(
    selection: SkillagerCliSelection,
    snapshot: SkillagerReviewSnapshot,
    signal: AbortSignal,
  ) {
    return this.operate(() => this.reviewCommands().accept(selection, snapshot, signal))
  }
  previewExposure(
    selection: SkillagerCliSelection,
    request: SkillagerExposureRequest,
    signal: AbortSignal,
  ) {
    return this.operate(() =>
      this.exposureCommands().previewExposure(selection, request, signal),
    )
  }
  updateSourceHash(
    selection: SkillagerCliSelection,
    snapshot: SkillagerExposureSnapshot,
    signal: AbortSignal,
  ) {
    return this.operate(() =>
      this.exposureCommands().updateSourceHash(selection, snapshot, signal),
    )
  }
  applyExposure(
    selection: SkillagerCliSelection,
    snapshot: SkillagerExposureSnapshot,
    signal: AbortSignal,
  ) {
    return this.operate(() =>
      this.exposureCommands().applyExposure(selection, snapshot, signal),
    )
  }
  private exposureCommands(): SkillagerExposureCommands {
    return new SkillagerExposureCommands(this.host, this.process, (selection, signal) =>
      this.validateLocal(selection, signal),
    )
  }

  private reviewCommands(): SkillagerReviewCommands {
    return new SkillagerReviewCommands(
      this.host,
      this.process,
      this.context,
      (selection, signal) => this.validateLocal(selection, signal),
    )
  }

  private operate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed)
      return Promise.reject(new SkillagerError('cancelled', 'Skillager is disconnected.'))
    const task = operation()
    this.operations.add(task)
    void task.then(
      () => this.operations.delete(task),
      () => this.operations.delete(task),
    )
    return task
  }

  private async probeLocal(
    selected: HostPath | undefined,
    signal: AbortSignal,
  ): Promise<SkillagerCliSelection> {
    if (
      selected &&
      (selected.hostId !== 'local' ||
        !selected.path.startsWith('/') ||
        selected.path.includes('\0') ||
        selected.path.length > 16_384)
    ) {
      throw new SkillagerError(
        'invalid-executable',
        'Choose an absolute local Skillager executable path.',
      )
    }
    await this.prepare(signal)
    const shell = await this.host.defaultShell()
    const csh = /(?:^|\/)(?:csh|tcsh)$/.test(shell)
    const output = await this.process.run(
      shell,
      csh ? ['-l'] : ['-lic', RESOLVE],
      {
        cwd: this.context,
        signal,
        input: csh ? `${RESOLVE}\n` : undefined,
        env: { HVIR_SKILLAGER_PROBE_EXECUTABLE: selected?.path || 'skillager' },
      },
      SKILLAGER_PROBE_LIMITS,
    )
    const marker = output.lastIndexOf(MARKER)
    const [resolved, catalogPath, ...exports] = output
      .slice(marker + MARKER.length)
      .split('\0')
    if (marker < 0 || !catalogPath || !exports.length)
      throw new SkillagerError(
        'command-failed',
        'Could not resolve the local Skillager environment.',
      )
    if (!resolved?.startsWith('/')) {
      throw new SkillagerError(
        selected ? 'invalid-executable' : 'missing',
        selected
          ? 'The selected Skillager executable was not found.'
          : 'Skillager was not found.',
      )
    }
    const environment: Record<string, string> = {}
    for (const entry of exports) {
      const separator = entry.indexOf('=')
      const key = entry.slice(0, separator)
      if (
        separator < 1 ||
        !/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) ||
        ['PWD', 'OLDPWD', 'SHLVL', '_', 'HVIR_SKILLAGER_PROBE_EXECUTABLE'].includes(key)
      )
        continue
      environment[key] = entry.slice(separator + 1)
    }
    const executable = await this.host.realpath(localPath(resolved))
    const catalog = localPath(catalogPath)
    if (!catalog.path.startsWith('/'))
      throw new SkillagerError(
        'unsupported',
        'Skillager returned an unsupported catalog location.',
      )
    const version = (
      await this.process.run(
        executable.path,
        ['--version'],
        { cwd: this.context, signal, env: environment },
        SKILLAGER_PROBE_LIMITS,
      )
    ).trim()
    if (!/^skillager 0\.(?:9|[1-9]\d)\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
      throw new SkillagerError(
        'unsupported',
        'This Skillager version is unsupported. Install a compatible version in your local terminal.',
      )
    }
    const help = await this.process.run(
      executable.path,
      ['search', '--help'],
      { cwd: this.context, signal, env: environment },
      SKILLAGER_PROBE_LIMITS,
    )
    if (!['--scope', '--full-json', '--limit'].every((flag) => help.includes(flag)))
      throw new SkillagerError(
        'unsupported',
        'Skillager does not support the required search contract.',
      )
    const selection = { executable, catalog, version, environment }
    const library = await this.registration(selection, signal)
    return { ...selection, library }
  }

  private async validateLocal(
    selection: SkillagerCliSelection,
    signal: AbortSignal,
  ): Promise<void> {
    const library = await this.registration(selection, signal)
    if (
      !library ||
      !selection.library ||
      library.id !== selection.library.id ||
      !hostPathEquals(library.root, selection.library.root) ||
      !hostPathEquals(library.skillsRoot, selection.library.skillsRoot)
    ) {
      throw new SkillagerError(
        'library-changed',
        'The Skillager library changed. Reconnect to continue.',
      )
    }
  }

  private async inventoryLocal(
    selection: SkillagerCliSelection,
    signal: AbortSignal,
  ): Promise<readonly SkillagerMetadata[]> {
    await this.validateLocal(selection, signal)
    const state = joinHostPath(this.context, randomUUID())
    const outcome = await (async () => {
      const output = await this.process.run(
        selection.executable.path,
        [
          '--catalog-state-dir',
          selection.catalog.path,
          '--state-dir',
          state.path,
          'collection',
          'refresh',
          'lib',
          '--json',
        ],
        { cwd: this.context, signal, env: selection.environment },
        SKILLAGER_INVENTORY_LIMITS,
      )
      await this.validateLocal(selection, signal)
      return parseSkillagerInventory(parseSkillagerJson(output), selection.library!)
    })().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    try {
      await this.removeState(state)
    } catch (error) {
      if (outcome.ok) throw error
      const primary = outcome.error
      throw new SkillagerError(
        primary instanceof SkillagerError ? primary.reason : 'command-failed',
        `${primary instanceof SkillagerError ? primary.message : 'Skillager request failed.'} Temporary state cleanup also failed.`,
      )
    }
    if (!outcome.ok) throw outcome.error
    return outcome.value
  }

  private async searchLocal(
    selection: SkillagerCliSelection,
    request: SkillagerSearchRequest,
    signal: AbortSignal,
  ): Promise<readonly SkillagerMetadata[]> {
    await this.validateLocal(selection, signal)
    const personal = request.scope === 'library'
    const output = await this.process.run(
      selection.executable.path,
      [
        '--catalog-state-dir',
        selection.catalog.path,
        ...(personal ? ['--state-dir', selection.catalog.path] : []),
        'search',
        '--scope',
        request.scope,
        '--agent',
        request.agent,
        '--limit',
        '50',
        '--json',
        '--full-json',
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
    await this.validateLocal(selection, signal)
    return parseSkillagerSearch(parseSkillagerJson(output), selection.library!, personal)
  }

  private async exposuresLocal(
    selection: SkillagerCliSelection,
    request: SkillagerRequest,
    signal: AbortSignal,
  ): Promise<readonly SkillagerWorkspaceExposure[] | undefined> {
    if (request.workspaceRoot.hostId !== 'local') return undefined
    const output = await this.process.run(
      selection.executable.path,
      [
        '--catalog-state-dir',
        selection.catalog.path,
        'expose',
        '--list',
        '--agent',
        request.agent,
        '--scope',
        'project',
        '--json',
      ],
      { cwd: request.workspaceRoot, signal, env: selection.environment },
      SKILLAGER_INVENTORY_LIMITS,
    )
    return parseSkillagerExposures(
      parseSkillagerJson(output),
      request.workspaceRoot,
      request.agent,
    )
  }

  dispose(): Promise<void> {
    this.disposed = true
    this.disposal ??= (async () => {
      await this.process.dispose()
      await Promise.allSettled([...this.operations])
      if (this.contextRequested) await this.removeState(this.context)
    })()
    return this.disposal
  }

  private prepare(signal: AbortSignal): Promise<void> {
    this.contextRequested = true
    this.prepared ??= this.process
      .run(
        'mkdir',
        ['-p', '-m', '700', '--', this.context.path],
        { signal },
        SKILLAGER_PROBE_LIMITS,
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.prepared = undefined
        throw error
      })
    return this.prepared
  }

  private async registration(
    selection: Pick<SkillagerCliSelection, 'executable' | 'catalog' | 'environment'>,
    signal: AbortSignal,
  ): Promise<SkillagerLibrary | undefined> {
    const output = await this.process.run(
      selection.executable.path,
      ['--catalog-state-dir', selection.catalog.path, 'collection', 'list', '--json'],
      { cwd: this.context, signal, env: selection.environment },
      SKILLAGER_PROBE_LIMITS,
    )
    const library = parseSkillagerLibrary(parseSkillagerJson(output))
    if (!library) return undefined
    const root = await this.host.realpath(library.root)
    const skillsRoot = await this.host.realpath(library.skillsRoot)
    if (
      !hostPathEquals(root, library.root) ||
      !hostPathEquals(skillsRoot, library.skillsRoot)
    ) {
      throw new SkillagerError(
        'library-changed',
        'The registered Skillager library path changed. Check it in your terminal.',
      )
    }
    return library
  }

  private async removeState(state: HostPath): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SKILLAGER_PROBE_LIMITS.deadlineMs)
    try {
      const result = await this.host.exec('rm', ['-rf', '--', state.path], {
        signal: controller.signal,
        maxBuffer: SKILLAGER_PROBE_LIMITS.stderr,
      })
      if (result.code !== 0)
        throw new SkillagerError(
          'command-failed',
          'Could not remove the temporary Skillager context.',
        )
    } finally {
      clearTimeout(timer)
    }
  }
}
