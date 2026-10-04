import { joinHostPath, type HostPath } from '../../shared'
import { plainShellLaunch } from '../harness/providers/plain-shell-launch'
import { plainShellProvider } from '../harness/harness-provider'
import type { ProjectHost } from '../project-host/project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import { stopPtyAndWaitForExit, waitForPtyOutput } from './pty-lifecycle'

/** Actual foreground PTY signals must end setup and transfer to an ordinary shell. */
export async function verifyPlainShellInterrupt(
  host: ProjectHost,
  supervisor: PtySupervisor,
  root: HostPath,
): Promise<void> {
  const shell = await host.defaultShell()
  const fixture = joinHostPath(root, '.command-once-default-shell')
  await host.createFileExclusive(fixture, { mode: 0o755 })
  await host.writeFile(
    fixture,
    '#!/bin/sh\nprintf "hvir-command-ordinary-shell\\n"\nexec "$HVIR_INTERRUPT_DEFAULT_SHELL" "$@"\n',
  )
  try {
    for (const [name, key] of [
      ['INT', '\x03'],
      ['QUIT', '\x1c'],
    ] as const) {
      const terminal = await supervisor.spawn({
        host,
        provider: plainShellProvider,
        launchSpec: {
          ...plainShellLaunch(fixture.path, {
            executable: '/bin/sh',
            args: [
              '-c',
              'trap "exit 130" INT; trap "exit 131" QUIT; printf "hvir-command-awaiting-signal\\n"; while :; do :; done',
            ],
            environment: {},
          }),
          env: { HVIR_INTERRUPT_DEFAULT_SHELL: shell },
        },
        cwd: root,
        workspaceRoot: root,
        ownerId: 0,
        sessionId: `command-once-interrupt-${name}`,
        cols: 80,
        rows: 24,
      })
      await waitForPtyOutput({
        supervisor,
        terminal,
        expected: 'hvir-command-awaiting-signal',
        scenario: `command once ${name} ready`,
        trigger: () => {},
      })
      await waitForPtyOutput({
        supervisor,
        terminal,
        expected: 'hvir-command-ordinary-shell',
        scenario: `command once ${name} default shell`,
        trigger: () =>
          supervisor.write(terminal.id, terminal.ownerId, key, terminal.ownerGeneration),
      })
      await waitForPtyOutput({
        supervisor,
        terminal,
        expected: `hvir-shell-input-${name}`,
        scenario: `command once ${name} ordinary input`,
        trigger: () =>
          supervisor.write(
            terminal.id,
            terminal.ownerId,
            `printf 'hvir-shell-input-%s\\n' '${name}'\r`,
            terminal.ownerGeneration,
          ),
      })
      await stopPtyAndWaitForExit({
        supervisor,
        terminal,
        scenario: `command once ${name} cleanup`,
      })
      console.log(`[smoke] Command-once ${name} interruption -> ordinary shell/input OK`)
    }
  } finally {
    await host.exec('rm', ['-f', '--', fixture.path])
  }
}
