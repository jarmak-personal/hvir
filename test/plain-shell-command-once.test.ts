import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { plainShellLaunch } from '../src/main/harness/providers/plain-shell-launch'
import { plainShellProvider } from '../src/main/harness/providers/shell'
import { localPath } from '../src/shared/host-path'
import { PROTECTED_TERMINAL_ENVIRONMENT } from '../src/main/harness/protected-terminal-environment'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('plain shell command-once composition', () => {
  it('preserves every argument and scopes configured environment to the initial command, then starts a login shell after failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hvir-command-once-'))
    roots.push(root)
    const shell = join(root, 'ordinary shell'),
      report = join(root, 'report.json')
    await writeFile(
      shell,
      '#!/bin/sh\nprintf "ordinary:%s:%s\\n" "$1" "${HVIR_TEST_COMMAND_CONFIG-unset}"\n',
      { mode: 0o755 },
    )
    const args = [
      '',
      'with spaces',
      "single'quote",
      '$(touch should-not-exist)',
      '`touch should-not-exist`',
      '; exit 99',
      '\nnew line',
      '雪',
    ]
    const command = {
      executable: process.execPath,
      args: [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({args:process.argv.slice(2),env:process.env.HVIR_TEST_COMMAND_CONFIG}));process.exit(7)',
        report,
        ...args,
      ],
      environment: { HVIR_TEST_COMMAND_CONFIG: 'a value; $(unsafe)' },
    }
    const spec = plainShellLaunch(shell, command)
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolve, reject) => {
        const child = spawn(spec.file, [...spec.args], { cwd: root, env: process.env })
        let output = ''
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString()
        })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, output }))
      },
    )
    expect(result).toEqual({ code: 0, output: 'ordinary:-l:unset\n' })
    expect(JSON.parse(await readFile(report, 'utf8'))).toEqual({
      args,
      env: 'a value; $(unsafe)',
    })
    await expect(readFile(join(root, 'should-not-exist'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('restores the default plain shell without replay even if a launch context still contains command data', () => {
    const context = {
      sessionId: 'new',
      cwd: localPath('/project'),
      defaultShell: '/bin/zsh',
      commandOnce: {
        executable: '/tool',
        args: ['setup'],
        environment: { TEST: 'value' },
      },
    }
    expect(plainShellProvider.launch(context).file).toBe('/bin/sh')
    expect(plainShellProvider.resume(context)).toEqual({ file: '/bin/zsh', args: ['-l'] })
  })

  it('rejects protected terminal/agent environment overrides and invalid executable data', () => {
    for (const key of PROTECTED_TERMINAL_ENVIRONMENT)
      expect(() =>
        plainShellLaunch('/bin/sh', {
          executable: '/tool',
          args: [],
          environment: { [key]: 'forged' },
        }),
      ).toThrow('Invalid command handoff environment')
    expect(() =>
      plainShellLaunch('/bin/sh', { executable: 'relative', args: [], environment: {} }),
    ).toThrow('absolute')
    expect(() =>
      plainShellLaunch('/bin/sh', {
        executable: '/tool',
        args: ['bad\0arg'],
        environment: {},
      }),
    ).toThrow('absolute')
  })
})
