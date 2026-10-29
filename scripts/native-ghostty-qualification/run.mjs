/* global process, console */
import { createRequire } from 'node:module'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSmokeLocked } from '../smoke-run-lock.mts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const electron = require('electron')
const [mode, target, extra] = process.argv.slice(2)
const main = join(root, 'scripts/native-ghostty-qualification/main.cjs')
function bridge(path) {
  if (!path || !existsSync(resolve(path)))
    throw new Error('Supply the compiled bridge.node path')
  return resolve(path)
}
async function run(engine, log) {
  process.env.HVIR_QUALIFICATION_ENGINE = engine
  if (log) process.env.HVIR_QUALIFICATION_LOG = log
  else delete process.env.HVIR_QUALIFICATION_LOG
  await runSmokeLocked(electron, [main])
  if (process.exitCode)
    throw new Error(`${engine} experiment failed; retain its output and log`)
}
async function mainRun() {
  if (mode === 'demo' && ['native', 'web'].includes(target ?? '')) {
    process.env.HVIR_QUALIFICATION_INTERACTIVE = '1'
    delete process.env.HVIR_QUALIFICATION_INTERACTIVE_PROBE
    if (target === 'native') process.env.HVIR_QUALIFICATION_BRIDGE = bridge(extra)
    console.log(
      `${target} replay-only demo: wheel/trackpad, PageUp/PageDown, Top/Bottom; close to clean up.`,
    )
    await run(target)
    return
  }
  if (mode === 'compare' && extra) {
    process.env.HVIR_QUALIFICATION_BRIDGE = bridge(target)
    delete process.env.HVIR_QUALIFICATION_INTERACTIVE
    delete process.env.HVIR_QUALIFICATION_INTERACTIVE_PROBE
    const output = resolve(extra)
    if (existsSync(output)) throw new Error('Comparison output directory must be new')
    mkdirSync(output, { recursive: true })
    const records = []
    let failed = false
    // Counterbalance ordering; run all six fresh processes sequentially, without retries.
    for (let repeat = 1; repeat <= 3; repeat++) {
      const order = repeat % 2 ? ['native', 'web'] : ['web', 'native']
      for (const engine of order) {
        const log = join(output, `${engine}-${repeat}.json`)
        console.log(`Comparison ${repeat}/3: ${engine}`)
        try {
          await run(engine, log)
        } catch {
          failed = true
          process.exitCode = 0
        }
        records.push({
          engine,
          repeat,
          artifact: log.split('/').at(-1),
          ...(existsSync(log)
            ? JSON.parse(readFileSync(log, 'utf8'))
            : { exitCode: 1, missingArtifact: true }),
        })
      }
    }
    writeFileSync(
      join(output, 'comparison.json'),
      JSON.stringify(
        {
          schema: 1,
          repetitions: 3,
          order: 'native/web, web/native, native/web',
          timing:
            'API service and renderer draw-scheduling observations; not physical presentation latency',
          records,
        },
        null,
        2,
      ) + '\n',
    )
    console.log(`Raw comparison artifacts: ${output}`)
    if (failed)
      throw new Error(
        'At least one scheduled run failed; all six results were retained without retries',
      )
    return
  }
  throw new Error(
    'Usage: run.mjs demo native BRIDGE | demo web | compare BRIDGE NEW_OUTPUT_DIRECTORY',
  )
}
void mainRun().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
