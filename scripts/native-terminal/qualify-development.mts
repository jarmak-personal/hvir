import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, relative, sep } from 'node:path'
import { repository } from './artifacts.mts'
import { readDevelopmentRuntime } from './development-runtime.mts'
import { runDevelopmentProcess } from './development-process.mts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (
    args.length !== 2 ||
    args[0] !== '--refresh-hz' ||
    !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(args[1] ?? '') ||
    !Number.isFinite(Number(args[1])) ||
    Number(args[1]) <= 0
  )
    throw new Error('Usage: npm run native:qualify -- --refresh-hz ACTUAL_MONITOR_HZ')
  const runtime = await readDevelopmentRuntime(repository)
  const output = await mkdtemp(join(homedir(), 'hvir-linux-native-results-'))
  const sourceRelative = relative(repository, resolve(output))
  if (!sourceRelative.startsWith(`..${sep}`))
    throw new Error('Qualification results must be outside the source checkout.')
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HVIR_NATIVE_TERMINAL_LIBRARY: runtime.library,
  }
  if (
    !environment.HVIR_NATIVE_TERMINAL_OZONE &&
    ['x11', 'wayland'].includes(environment.XDG_SESSION_TYPE ?? '')
  )
    environment.HVIR_NATIVE_TERMINAL_OZONE = environment.XDG_SESSION_TYPE
  const npm = process.env.npm_execpath
  if (!npm) throw new Error('Run this command through npm run native:qualify.')
  await writeFile(
    join(output, 'runtime.json'),
    JSON.stringify(runtime.receipt, null, 2) + '\n',
  )
  console.log(`Qualification results: ${output}`)
  console.log(
    'Close the dev app first; keep the desktop otherwise idle. Governance remains a separate authenticated CI/contributor check.',
  )
  const scripts = [
    'check-seams',
    'check-adrs',
    'lint',
    'typecheck',
    'test',
    'smoke',
    'smoke:native-terminal',
    'performance:capacity',
  ]
  for (const script of scripts) {
    console.log(`Qualification: ${script}`)
    await runDevelopmentProcess([npm, 'run', script], repository, environment)
  }
  // Capacity built the smoke app once; comparison owns its unmodified paired protocol.
  await runDevelopmentProcess(
    [
      npm,
      'run',
      'performance:terminal-comparison',
      '--',
      '--output',
      join(output, 'comparison'),
      '--native-library',
      runtime.library,
      '--refresh-hz',
      args[1]!,
    ],
    repository,
    environment,
  )
  console.log(`Credential-free runtime qualification complete: ${output}`)
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
