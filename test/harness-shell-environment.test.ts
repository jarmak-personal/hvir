import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { plainShellProvider } from '../src/main/harness/harness-provider'
import {
  harnessShellCommandArgs,
  harnessShellProbeCommandArgs,
  harnessShellProbeOutput,
  harnessShellProbeArgs,
} from '../src/main/harness/harness-shell-environment'
import { LocalHost } from '../src/main/project-host/local-host'
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
    expect(
      harnessShellProbeCommandArgs('provider', ['literal $HOME', "profile's arg"]),
    ).toEqual([
      '-lic',
      `printf '\\036hvir-provider-output-v1\\037'; exec 'provider' 'literal $HOME' 'profile'"'"'s arg' 2>&1`,
    ])
  })

  const linuxIt = process.platform === 'linux' ? it : it.skip
  linuxIt(
    'keeps provider stderr separate from detached Bash startup diagnostics',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'hvir-harness-probe-shell-'))
      try {
        const bin = join(home, 'bin')
        const executable = join(bin, 'probe-harness')
        await mkdir(bin)
        await writeFile(join(home, '.bash_profile'), 'export PATH="$HOME/bin:$PATH"\n')
        await writeFile(executable, '#!/bin/sh\nprintf "probe 1.2.3\\n" >&2\n')
        await chmod(executable, 0o755)
        const host = new LocalHost()

        const result = await host.exec(
          '/bin/bash',
          harnessShellProbeCommandArgs('probe-harness', ['--version']),
          {
            env: {
              HOME: home,
              PATH: '/usr/bin:/bin',
            },
          },
        )

        expect(result.code).toBe(0)
        expect(harnessShellProbeOutput(result.stdout)?.trim()).toBe('probe 1.2.3')
        expect(result.stderr).not.toContain('probe 1.2.3')
      } finally {
        await rm(home, { recursive: true })
      }
    },
  )

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
