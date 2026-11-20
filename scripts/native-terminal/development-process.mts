import { spawn } from 'node:child_process'

/** Forward signals to the tool, whose own owner settles its compiler/Electron children. */
export async function runDevelopmentProcess(
  args: readonly string[],
  cwd: string,
  env = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd,
      env,
      stdio: 'inherit',
      detached: true,
    })
    let interrupted = false
    let escalation: ReturnType<typeof setTimeout> | undefined
    const interrupt = (signal: NodeJS.Signals) => {
      if (interrupted || !child.pid) return
      interrupted = true
      try {
        process.kill(-child.pid, signal)
        escalation = setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL')
          } catch {
            /* Already settled. */
          }
        }, 10_000)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    const sigint = () => interrupt('SIGINT')
    const sigterm = () => interrupt('SIGTERM')
    process.on('SIGINT', sigint)
    process.on('SIGTERM', sigterm)
    const cleanup = () => {
      if (escalation) clearTimeout(escalation)
      process.off('SIGINT', sigint)
      process.off('SIGTERM', sigterm)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      if (code === 0 && !signal && !interrupted) resolve()
      else reject(new Error(`native-development: child failed (${signal ?? code})`))
    })
  })
}
