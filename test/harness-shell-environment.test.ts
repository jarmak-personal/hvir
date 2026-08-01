import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { plainShellProvider } from '../src/main/harness/harness-provider'
import {
  harnessShellCommandArgs,
  harnessShellProbeArgs,
} from '../src/main/harness/harness-shell-environment'
import { localPath } from '../src/shared'

describe('harness shell environment', () => {
  it('quotes executable probes and command arguments without shell evaluation', () => {
    expect(harnessShellProbeArgs("provider's-cli")).toEqual([
      '-lic',
      `command -v 'provider'"'"'s-cli' >/dev/null 2>&1`,
    ])
    expect(
      harnessShellCommandArgs('provider', ['literal $HOME', "profile's arg"]),
    ).toEqual(['-lic', `exec 'provider' 'literal $HOME' 'profile'"'"'s arg'`])
  })

  const macosIt = process.platform === 'darwin' ? it : it.skip
  macosIt(
    'loads both login and interactive zsh startup for a GUI-like parent environment',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'hvir-harness-shell-'))
      try {
        const loginBin = join(home, 'login-bin')
        const executable = join(loginBin, 'finder-harness')
        await mkdir(loginBin)
        await writeFile(
          join(home, '.zprofile'),
          'export PATH="$HOME/login-bin:$PATH"\n' +
            'export HVIR_LOGIN_STARTUP="${HVIR_LOGIN_STARTUP:+$HVIR_LOGIN_STARTUP,}login"\n',
        )
        await writeFile(
          join(home, '.zshrc'),
          'export HVIR_INTERACTIVE_STARTUP="${HVIR_INTERACTIVE_STARTUP:+$HVIR_INTERACTIVE_STARTUP,}interactive"\n',
        )
        await writeFile(
          executable,
          '#!/bin/sh\nprintf "%s|%s\\n" "$HVIR_INTERACTIVE_STARTUP" "$1"\n',
        )
        await chmod(executable, 0o755)

        const env = {
          HOME: home,
          LOGNAME: process.env.LOGNAME ?? 'hvir-test',
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          SHELL: '/bin/zsh',
          USER: process.env.USER ?? 'hvir-test',
        }
        const probe = spawnSync('/bin/zsh', harnessShellProbeArgs('finder-harness'), {
          encoding: 'utf8',
          env,
        })
        expect(probe.status, probe.stderr).toBe(0)

        const harnessLaunch = spawnSync(
          '/bin/zsh',
          harnessShellCommandArgs('finder-harness', ['literal argument']),
          { encoding: 'utf8', env },
        )
        expect(harnessLaunch.status, harnessLaunch.stderr).toBe(0)
        expect(harnessLaunch.stdout.trim()).toBe('interactive|literal argument')

        const context = {
          sessionId: 'plain-shell-environment',
          cwd: localPath('/tmp/project'),
          defaultShell: '/bin/zsh',
        }
        const plainShell = plainShellProvider.launch(context)
        const loginInteractive = spawnSync(
          plainShell.file,
          [
            ...plainShell.args,
            '-i',
            '-c',
            'printf "%s|%s|%s|%s|" "$HVIR_LOGIN_STARTUP" "$HVIR_INTERACTIVE_STARTUP" "$options[login]" "$options[interactive]"; command -v finder-harness',
          ],
          { encoding: 'utf8', env },
        )
        expect(loginInteractive.status, loginInteractive.stderr).toBe(0)
        expect(loginInteractive.stdout.trim()).toBe(
          `login|interactive|on|on|${executable}`,
        )
      } finally {
        await rm(home, { recursive: true })
      }
    },
  )
})
