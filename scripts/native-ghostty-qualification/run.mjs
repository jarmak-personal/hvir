/* global process, console */
import { createRequire } from 'node:module'
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { runSmokeLocked } from '../smoke-run-lock.mts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const electron = require('electron')
const [mode, target, extra, fourth] = process.argv.slice(2)
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
  if (['live', 'live-probe', 'harness-probe', 'resize-probe'].includes(mode)) {
    process.env.HVIR_QUALIFICATION_BRIDGE = bridge(target)
    process.env.HVIR_QUALIFICATION_ROOT = root
    process.env.HVIR_QUALIFICATION_NODE = process.execPath
    const output = join(root, `out/native-ghostty-live-${process.pid}.mjs`)
    await build({
      entryPoints: [join(root, 'scripts/native-ghostty-qualification/live-main.mts')],
      outfile: output,
      bundle: true,
      packages: 'external',
      platform: 'node',
      format: 'esm',
    })
    if (['live-probe', 'harness-probe', 'resize-probe'].includes(mode)) {
      if (!extra) throw new Error('Supply a new live-probe output directory')
      const directory = resolve(extra)
      if (existsSync(directory))
        throw new Error('Live probe output directory must be new')
      mkdirSync(directory, { recursive: true })
      process.env.HVIR_QUALIFICATION_LOG = join(directory, 'probe.json')
      process.env.HVIR_QUALIFICATION_RESIZE_PROBE = mode === 'resize-probe' ? '1' : '0'
      process.env.HVIR_QUALIFICATION_LIVE_PROBE = mode === 'live-probe' ? '1' : '0'
      process.env.HVIR_QUALIFICATION_HARNESS_PROBE = mode === 'harness-probe' ? '1' : '0'
      if (mode === 'harness-probe')
        process.env.HVIR_QUALIFICATION_PROVIDER = 'claude-code'
    } else {
      if (!['plain-shell', 'claude-code'].includes(extra ?? 'plain-shell'))
        throw new Error('Live demo provider must be plain-shell or claude-code')
      process.env.HVIR_QUALIFICATION_PROVIDER = extra ?? 'plain-shell'
      delete process.env.HVIR_QUALIFICATION_LIVE_PROBE
      delete process.env.HVIR_QUALIFICATION_HARNESS_PROBE
      delete process.env.HVIR_QUALIFICATION_RESIZE_PROBE
      delete process.env.HVIR_QUALIFICATION_LOG
    }
    const scratch = mkdtempSync(join(tmpdir(), 'hvir-live-qualification-'))
    process.env.HVIR_QUALIFICATION_LIVE_SCRATCH = scratch
    mkdirSync(join(scratch, 'workspace'))
    writeFileSync(
      join(scratch, 'ghostty-config'),
      'font-family = Menlo\nfont-size = 14\nadjust-cell-width = 1\nadjust-cell-height = -3\nwindow-padding-x = 0\nwindow-padding-y = 0\ncursor-style-blink = false\nshell-integration = none\nscrollback-limit = 10000000\n',
    )
    try {
      await runSmokeLocked(electron, [output])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
      rmSync(output, { force: true })
    }
    if (process.exitCode)
      throw new Error('Live qualification failed; retain its probe.json')
    return
  }

  if (mode === 'probe' && ['native', 'web'].includes(target ?? '')) {
    const requestedOutput = target === 'native' ? fourth : extra
    if (!requestedOutput) throw new Error('Supply a new probe output directory')
    const output = resolve(requestedOutput)
    if (existsSync(output)) throw new Error('Probe output directory must be new')
    if (target === 'native') process.env.HVIR_QUALIFICATION_BRIDGE = bridge(extra)
    mkdirSync(output, { recursive: true })
    process.env.HVIR_QUALIFICATION_INTERACTIVE = '1'
    process.env.HVIR_QUALIFICATION_INTERACTIVE_PROBE = '1'
    process.env.HVIR_QUALIFICATION_SCREENSHOT = join(output, 'viewport')
    await run(target, join(output, 'probe.json'))
    console.log(`Interactive wheel proof and screenshots: ${output}`)
    return
  }
  if (mode === 'demo' && ['native', 'web'].includes(target ?? '')) {
    process.env.HVIR_QUALIFICATION_INTERACTIVE = '1'
    delete process.env.HVIR_QUALIFICATION_INTERACTIVE_PROBE
    delete process.env.HVIR_QUALIFICATION_SCREENSHOT
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
    'Usage: run.mjs live BRIDGE [plain-shell|claude-code] | live-probe BRIDGE NEW_OUTPUT | resize-probe BRIDGE NEW_OUTPUT | harness-probe BRIDGE NEW_OUTPUT | demo native BRIDGE | demo web | probe native BRIDGE NEW_OUTPUT | probe web NEW_OUTPUT | compare BRIDGE NEW_OUTPUT',
  )
}
void mainRun().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
