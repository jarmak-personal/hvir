import { randomUUID } from 'node:crypto'
import { joinHostPath, localPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host'
import { SkillagerCli } from '../skillager/skillager-cli'
import type { SkillagerCliPort } from '../skillager/skillager-port'
import type { SmokeCleanup } from './cleanup'

/** Opt-in real CLI load over an explicitly supplied disposable acceptance fixture. */
export function realSkillagerSmokePort(
  host: ProjectHost,
  cleanup: SmokeCleanup,
): SkillagerCliPort | undefined {
  const fixture = process.env.HVIR_SKILLAGER_SMOKE_FIXTURE
  const release = process.env.HVIR_SKILLAGER_RELEASE
  if (!fixture || !release) return undefined
  const root = localPath(fixture)
  const path = (name: string): string => joinHostPath(root, name).path
  // Public CLI cache selection makes the first search build its own index, even
  // when the retained acceptance catalog has already been searched by another run.
  const searchCache = path(`electron-cache-${randomUUID()}`)
  const environment = {
    HOME: path('home'),
    XDG_CONFIG_HOME: path('config'),
    XDG_CACHE_HOME: path('cache'),
    XDG_DATA_HOME: path('data'),
    XDG_STATE_HOME: path('state'),
    CODEX_HOME: path('codex-home'),
    CLAUDE_CONFIG_DIR: path('claude'),
    SKILLAGER_CATALOG_STATE_DIR: path('catalog'),
    SKILLAGER_CACHE_DIR: searchCache,
    PYTHONDONTWRITEBYTECODE: '1',
    SKILLAGER_NO_UPDATE_CHECK: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path('gitconfig'),
  }
  const unsetEnv = Object.keys(process.env).filter(
    (key) =>
      key.startsWith('SKILLAGER_') ||
      ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'CONDA_PREFIX'].includes(key),
  )
  const cli = new SkillagerCli(
    {
      hostId: host.hostId,
      defaultShell: () => Promise.resolve('/bin/sh'),
      realpath: (value) => host.realpath(value),
      exec: (command, args, options) =>
        host.exec(command, args, {
          ...options,
          unsetEnv,
          env: { ...environment, ...options?.env },
        }),
    },
    joinHostPath(root, 'scratch'),
  )
  cleanup.defer('real Skillager CLI', () => cli.dispose())
  return {
    probe: (executable, signal) =>
      cli.probe(
        executable ?? joinHostPath(localPath(release), '.venv/bin/skillager'),
        signal,
      ),
    validate: (selection, signal) => cli.validate(selection, signal),
    inventory: (selection, signal) => cli.inventory(selection, signal),
    search: (selection, request, signal) => cli.search(selection, request, signal),
    exposures: (selection, request, signal) => cli.exposures(selection, request, signal),
  }
}
