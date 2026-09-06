import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import { waitForPtyOutput } from './pty-lifecycle'

/** Readiness/stopped evidence must be emitted by the shell, never its echoed command. */
export async function startPtyProducer(
  supervisor: Pick<PtySupervisor, 'attach' | 'write' | 'get'>,
  fixture: { readonly terminal: ManagedPty },
  label: 'local' | 'ssh',
): Promise<() => Promise<void>> {
  const marker = `hvir-${label}-producer-ready`
  await waitForPtyOutput({
    supervisor,
    terminal: fixture.terminal,
    expected: marker,
    scenario: `renderer recovery ${label} producer`,
    trigger: () =>
      supervisor.write(
        fixture.terminal.id,
        fixture.terminal.ownerId,
        `printf 'hvir-%s-producer-ready\\n' '${label}'; while :; do printf 'hvir-${label}-active\\n'; sleep 0.01; done\n`,
        fixture.terminal.ownerGeneration,
      ),
  })
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    const terminal = supervisor.get(fixture.terminal.id)
    if (!terminal) return
    const stopped = `hvir-${label}-producer-stopped`
    await waitForPtyOutput({
      supervisor,
      terminal,
      expected: stopped,
      scenario: `renderer recovery ${label} producer cleanup`,
      trigger: () =>
        supervisor.write(
          terminal.id,
          terminal.ownerId,
          `\u0003printf 'hvir-%s-producer-stopped\\n' '${label}'\n`,
          terminal.ownerGeneration,
        ),
    })
  }
}
