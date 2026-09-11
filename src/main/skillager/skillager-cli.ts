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
const RESOLVE = `printf '\\036hvir-skillager-probe\\037'; command -v -- "$1" || true; printf '%s\\n' "\${SKILLAGER_CATALOG_STATE_DIR:-\${XDG_CONFIG_HOME:-$HOME/.config}/skillager}"`

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
    private readonly host: Pick<
      ProjectHost,
      'hostId' | 'exec' | 'realpath' | 'defaultShell'
    >,
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
    const output = await this.process.run(
      shell,
      ['-lic', RESOLVE, 'hvir-skillager', selected?.path || 'skillager'],
      { cwd: this.context, signal },
      SKILLAGER_PROBE_LIMITS,
    )
    const marker = output.lastIndexOf(MARKER)
    const lines = output
      .slice(marker + MARKER.length)
      .trim()
      .split('\n')
    if (marker < 0 || lines.length < 1)
      throw new SkillagerError(
        'command-failed',
        'Could not resolve the local Skillager environment.',
      )
    if (lines.length !== 2 || !lines[0]?.startsWith('/')) {
      throw new SkillagerError(
        selected ? 'invalid-executable' : 'missing',
        selected
          ? 'The selected Skillager executable was not found.'
          : 'Skillager was not found.',
      )
    }
    const executable = await this.host.realpath(localPath(lines[0]))
    const catalog = localPath(lines[1]!)
    if (!catalog.path.startsWith('/'))
      throw new SkillagerError(
        'unsupported',
        'Skillager returned an unsupported catalog location.',
      )
    const version = (
      await this.process.run(
        executable.path,
        ['--version'],
        { cwd: this.context, signal },
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
      { cwd: this.context, signal },
      SKILLAGER_PROBE_LIMITS,
    )
    if (!['--scope', '--full-json', '--limit'].every((flag) => help.includes(flag)))
      throw new SkillagerError(
        'unsupported',
        'Skillager does not support the required search contract.',
      )
    const selection = { executable, catalog, version }
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
    const output = await this.process
      .run(
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
        { cwd: this.context, signal },
        SKILLAGER_INVENTORY_LIMITS,
      )
      .finally(() => this.removeState(state))
    await this.validateLocal(selection, signal)
    return parseSkillagerInventory(parseSkillagerJson(output), selection.library!)
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
        request.query,
        '--scope',
        request.scope,
        '--agent',
        request.agent,
        '--limit',
        '50',
        '--json',
        '--full-json',
      ],
      { cwd: personal ? this.context : request.workspaceRoot, signal },
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
      { cwd: request.workspaceRoot, signal },
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
    selection: Pick<SkillagerCliSelection, 'executable' | 'catalog'>,
    signal: AbortSignal,
  ): Promise<SkillagerLibrary | undefined> {
    const output = await this.process.run(
      selection.executable.path,
      ['--catalog-state-dir', selection.catalog.path, 'collection', 'list', '--json'],
      { cwd: this.context, signal },
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
