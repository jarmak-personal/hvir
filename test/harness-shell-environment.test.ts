import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import {
  harnessShellCommandArgs,
  harnessShellProbeArgs,
} from '../src/main/harness/harness-shell-environment'

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
        await writeFile(join(home, '.zprofile'), 'export PATH="$HOME/login-bin:$PATH"\n')
        await writeFile(join(home, '.zshrc'), 'export HVIR_INTERACTIVE_STARTUP=loaded\n')
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

        const launch = spawnSync(
          '/bin/zsh',
          harnessShellCommandArgs('finder-harness', ['literal argument']),
          { encoding: 'utf8', env },
        )
        expect(launch.status, launch.stderr).toBe(0)
        expect(launch.stdout.trim()).toBe('loaded|literal argument')
      } finally {
        await rm(home, { recursive: true })
      }
    },
  )
})
