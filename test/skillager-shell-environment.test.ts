import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LocalHost } from '../src/main/project-host/local-host'
import { SkillagerCli } from '../src/main/skillager/skillager-cli'
import { localPath } from '../src/shared/host-path'

// Use installed alternate shells; never install one to satisfy this contract.
for (const shell of ['/bin/zsh', '/bin/tcsh']) {
  it.runIf(existsSync(shell))(
    `uses ${shell} login exports for resolution AND later CLI calls, keeping selected paths as data`,
    async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'hvir-skillager-shell-')))
      const home = join(root, 'home')
      const bin = join(root, 'login-bin')
      const catalog = join(root, 'catalog from login')
      const weird = join(root, 'skillager \' $(touch injected) `touch injected2`; " !')
      const host = new LocalHost()
      const cli = new SkillagerCli(
        {
          hostId: host.hostId,
          defaultShell: () => Promise.resolve(shell),
          realpath: (path) => host.realpath(path),
          stat: (path) => host.stat(path),
          readdir: (path) => host.readdir(path),
          fileTransfer: host.fileTransfer,
          createDirectoryExclusive: (path, options) =>
            host.createDirectoryExclusive(path, options),
          exec: (command, args, options) =>
            host.exec(command, args, {
              ...options,
              unsetEnv: ['SKILLAGER_CATALOG_STATE_DIR', 'BASH_ENV', 'ENV'],
              env: { HOME: home, ZDOTDIR: home, ...options?.env },
            }),
        },
        localPath(root),
      )
      try {
        await Promise.all([home, bin].map((directory) => mkdir(directory)))
        const profile = shell.endsWith('tcsh')
          ? `setenv SKILLAGER_CATALOG_STATE_DIR "${catalog}"\nsetenv PATH "${bin}:$PATH"\nsetenv HVIR_LOGIN_SENTINEL "from private login"\n`
          : `export SKILLAGER_CATALOG_STATE_DIR='${catalog}'\nexport PATH='${bin}':$PATH\nexport HVIR_LOGIN_SENTINEL='from private login'\n`
        await writeFile(
          join(home, shell.endsWith('tcsh') ? '.login' : '.zprofile'),
          profile,
        )
        await writeFile(join(bin, 'login-helper'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
        const script = `#!/bin/sh
[ "$HVIR_LOGIN_SENTINEL" = "from private login" ] || exit 70
command -v login-helper >/dev/null || exit 71
case "$1" in
  --version) printf 'skillager 0.9.0\\n' ;;
  search) printf '%s\\n' '--scope --full-json --limit' ;;
  *) printf '%s\\n' '{"collections":{}}' ;;
esac
`
        await Promise.all(
          [join(bin, 'skillager'), weird].map((path) =>
            writeFile(path, script, { mode: 0o700 }),
          ),
        )
        const signal = AbortSignal.timeout(15_000)
        const found = await cli.probe(undefined, signal)
        expect(found.executable).toEqual(localPath(join(bin, 'skillager')))
        expect(found.catalog).toEqual(localPath(catalog))
        expect(found.environment.HVIR_LOGIN_SENTINEL).toBe('from private login')
        expect(found.environment.PATH?.startsWith(`${bin}:`)).toBe(true)
        expect(found.environment.HVIR_SKILLAGER_PROBE_EXECUTABLE).toBeUndefined()
        expect((await cli.probe(localPath(weird), signal)).executable).toEqual(
          localPath(weird),
        )
        expect(
          (await readdir(root, { recursive: true })).some((path) =>
            /(?:^|\/)injected2?$/.test(path),
          ),
        ).toBe(false)
      } finally {
        await cli.dispose()
        await host.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
}
