import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { repository } from './artifacts.mts'
import { readDevelopmentRuntime } from './development-runtime.mts'
import { runDevelopmentProcess } from './development-process.mts'

export function developmentLaunchArguments(
  args: string[],
  environment: NodeJS.ProcessEnv,
  platform: string = process.platform,
): string[] {
  const forwarded = [...args]
  const ozone = environment.HVIR_NATIVE_TERMINAL_OZONE ?? environment.XDG_SESSION_TYPE
  if (platform === 'linux' && ['wayland', 'x11'].includes(ozone ?? '')) {
    if (!forwarded.includes('--')) forwarded.push('--')
    if (!forwarded.some((arg) => arg.startsWith('--ozone-platform=')))
      forwarded.push(`--ozone-platform=${ozone}`)
    environment.HVIR_NATIVE_TERMINAL_OZONE = ozone
  }
  return ['dev', ...forwarded]
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const legacy = args[0] === '--legacy'
  if (legacy) args.shift()
  const environment = { ...process.env }
  if (legacy) delete environment.HVIR_NATIVE_TERMINAL_LIBRARY
  else if (environment.HVIR_NATIVE_TERMINAL_LIBRARY === undefined)
    environment.HVIR_NATIVE_TERMINAL_LIBRARY = (
      await readDevelopmentRuntime(repository)
    ).library
  if (!legacy && !environment.HVIR_NATIVE_TERMINAL_LIBRARY)
    throw new Error(
      'Native library selection is empty. Run npm run native:prepare or use npm run dev:legacy.',
    )
  const cli = join(
    dirname(fileURLToPath(import.meta.resolve('electron-vite/package.json'))),
    'bin/electron-vite.js',
  )
  await runDevelopmentProcess(
    [cli, ...developmentLaunchArguments(args, environment)],
    repository,
    environment,
  )
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
