import { joinHostPath, type HostPath } from '../../shared/host-path'

/** One isolation policy for real-CLI integration and Electron acceptance fixtures. */
export function skillagerFixtureEnvironment(
  root: HostPath,
  inherited: NodeJS.ProcessEnv,
  searchCache = joinHostPath(root, 'cache/skillager'),
) {
  const path = (name: string): string => joinHostPath(root, name).path
  return {
    env: {
      HOME: path('home'),
      XDG_CONFIG_HOME: path('config'),
      XDG_CACHE_HOME: path('cache'),
      XDG_DATA_HOME: path('data'),
      XDG_STATE_HOME: path('state'),
      CODEX_HOME: path('codex-home'),
      CLAUDE_CONFIG_DIR: path('claude'),
      SKILLAGER_CATALOG_STATE_DIR: path('catalog'),
      SKILLAGER_CACHE_DIR: searchCache.path,
      PYTHONDONTWRITEBYTECODE: '1',
      SKILLAGER_NO_UPDATE_CHECK: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path('gitconfig'),
    },
    unsetEnv: Object.keys(inherited).filter(
      (key) =>
        key.startsWith('SKILLAGER_') ||
        ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'CONDA_PREFIX'].includes(key),
    ),
  }
}
