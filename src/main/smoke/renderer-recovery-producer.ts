import type { ManagedPty, PtySupervisor } from '../pty/pty-supervisor'
import { waitForPtyOutput, type PtyOutputWaitProgress } from './pty-lifecycle'

/** Readiness/stopped evidence must be emitted by the shell, never its echoed command. */
export async function startPtyProducer(
  supervisor: Pick<PtySupervisor, 'attach' | 'write' | 'get'>,
  fixture: { readonly terminal: ManagedPty },
  label: 'local' | 'ssh',
): Promise<() => Promise<void>> {
  // At most eight scalar-only lines per wait, regardless of output volume.
  // These progress logs are not part of the failure-artifact allowlist.
  const report = (operation: 'start' | 'stop', progress: PtyOutputWaitProgress) =>
    console.log(
      `[smoke:producer-progress] ${JSON.stringify({ producer: label, operation, ...progress })}`,
    )
  const marker = `hvir-${label}-producer-ready`
  // Install the foreground child's interrupt handler before acknowledging readiness.
  // Its trap acknowledges shutdown, without queuing input during Ctrl-C's flush.
  const script = `trap 'printf "hvir-%s-producer-stopped\\n" "${label}"; exit 0' INT; printf 'hvir-%s-producer-ready\\n' '${label}'; while :; do printf 'hvir-${label}-active\\n'; sleep 0.01; done`
  await waitForPtyOutput({
    supervisor,
    terminal: fixture.terminal,
    expected: marker,
    scenario: `renderer recovery ${label} producer`,
    onProgress: (progress) => report('start', progress),
    trigger: () =>
      supervisor.write(
        fixture.terminal.id,
        fixture.terminal.ownerId,
        `/bin/sh -c '${script.replaceAll("'", "'\\''")}'\n`,
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
      onProgress: (progress) => report('stop', progress),
      trigger: () =>
        supervisor.write(
          terminal.id,
          terminal.ownerId,
          '\u0003',
          terminal.ownerGeneration,
        ),
    })
  }
}
