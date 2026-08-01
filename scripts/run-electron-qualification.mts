import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, dirname, join, relative, resolve } from 'node:path'

import {
  combineElectronQualificationResults,
  createElectronQualificationPartitionResult,
  createElectronQualificationPlan,
  electronQualificationMatrixBatches,
  formatElectronQualificationSummary,
  type ElectronQualificationAttempt,
  type ElectronQualificationMode,
  type ElectronQualificationPartitionResult,
  type ElectronQualificationPlan,
  type ElectronQualificationPlanEntry,
  type ElectronQualificationSummary,
} from './electron-qualification.mts'
import { parseRequiredElectronPlatform } from './required-electron-suites.mts'
import { runRequiredElectronSuites } from './run-required-electron-suite.mts'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

export async function runElectronQualificationPartition(options: {
  readonly mode: ElectronQualificationMode
  readonly sourceSha: string
  readonly entry: ElectronQualificationPlanEntry
  readonly outputDirectory: string
}): Promise<ElectronQualificationPartitionResult> {
  assertFixedCleanSource(options.sourceSha)
  await mkdir(options.outputDirectory, { recursive: true })
  const attempts: ElectronQualificationAttempt[] = []
  let result = createElectronQualificationPartitionResult(options, options.entry)
  await writeJsonAtomically(join(options.outputDirectory, 'partition.json'), result)
  for (let offset = 0; offset < options.entry.attemptCount; offset += 1) {
    const number = options.entry.attemptStart + offset
    const artifactDirectory = join(
      options.outputDirectory,
      'failures',
      `invocation-${number}`,
    )
    const startedAt = performance.now()
    try {
      const invocation = await runRequiredElectronSuites(options.entry.platform, {
        cwd: repositoryRoot,
        artifactDirectory,
      })
      attempts.push({
        number,
        status: invocation.status,
        durationMs: performance.now() - startedAt,
        failure: invocation.status === 'passed' ? null : 'suite-failure',
        suites: invocation.suites,
        failureArtifacts: await relativeJsonFiles(
          artifactDirectory,
          options.outputDirectory,
        ),
      })
    } catch {
      attempts.push({
        number,
        status: 'failed',
        durationMs: performance.now() - startedAt,
        failure: 'runner-error',
        suites: [],
        failureArtifacts: await relativeJsonFiles(
          artifactDirectory,
          options.outputDirectory,
        ),
      })
    }
    result = createElectronQualificationPartitionResult(options, options.entry, attempts)
    await writeJsonAtomically(join(options.outputDirectory, 'partition.json'), result)
  }
  return result
}

export function assertFixedCleanSource(sourceSha: string): void {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
  if (head !== sourceSha)
    throw new Error('Qualification checkout does not match the fixed SHA')
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  }).trim()
  if (dirty !== '') throw new Error('Qualification requires a clean source checkout')
}

async function relativeJsonFiles(root: string, base: string): Promise<readonly string[]> {
  const files = await findNamedFiles(root, (name) => name.endsWith('.json'))
  return files.map((path) => relative(base, path)).sort()
}

async function findNamedFiles(
  root: string,
  include: (name: string) => boolean,
): Promise<readonly string[]> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await findNamedFiles(path, include)))
    else if (entry.isFile() && include(entry.name)) files.push(path)
  }
  return files
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, path)
}

async function planCommand(): Promise<void> {
  const mode = qualificationMode(requiredEnvironment('HVIR_QUALIFICATION_MODE'))
  const sourceSha = requiredEnvironment('HVIR_QUALIFICATION_SOURCE_SHA')
  const reviewedSourceSha = requiredEnvironment('HVIR_QUALIFICATION_REVIEWED_SHA')
  const runAttempt = positiveIntegerEnvironment('HVIR_QUALIFICATION_RUN_ATTEMPT')
  const outputPath = requiredEnvironment('HVIR_QUALIFICATION_PLAN_PATH')
  const plan = createElectronQualificationPlan({
    mode,
    sourceSha,
    reviewedSourceSha,
    runAttempt,
  })
  await writeJsonAtomically(outputPath, plan)
  const githubOutput = process.env.GITHUB_OUTPUT
  if (githubOutput) {
    const batches = electronQualificationMatrixBatches(plan)
    const batchOutputs = batches.flatMap((batch, index) => [
      `matrix_${index + 1}=${JSON.stringify(batch)}`,
      `matrix_${index + 1}_active=${String(batch.include.length > 0)}`,
    ])
    await appendFile(
      githubOutput,
      `${[...batchOutputs, `mode=${plan.mode}`, `source_sha=${plan.sourceSha}`].join(
        '\n',
      )}\n`,
      'utf8',
    )
  }
  console.log(
    `[electron:qualification:plan] mode=${plan.mode} source=${plan.sourceSha} partitions=${plan.matrix.include.length} invocations-per-platform=${plan.invocationsPerPlatform}`,
  )
}

async function partitionCommand(): Promise<void> {
  const mode = qualificationMode(requiredEnvironment('HVIR_QUALIFICATION_MODE'))
  rejectQualificationRerun(
    mode,
    positiveIntegerEnvironment('HVIR_QUALIFICATION_RUN_ATTEMPT'),
  )
  const platform = parseRequiredElectronPlatform(
    requiredEnvironment('HVIR_QUALIFICATION_PLATFORM'),
  )
  const entry: ElectronQualificationPlanEntry = {
    platform,
    runner: platform === 'linux-x64' ? 'ubuntu-24.04' : 'macos-15',
    partition: positiveIntegerEnvironment('HVIR_QUALIFICATION_PARTITION'),
    attemptStart: positiveIntegerEnvironment('HVIR_QUALIFICATION_ATTEMPT_START'),
    attemptCount: positiveIntegerEnvironment('HVIR_QUALIFICATION_ATTEMPT_COUNT'),
  }
  const result = await runElectronQualificationPartition({
    mode,
    sourceSha: requiredEnvironment('HVIR_QUALIFICATION_SOURCE_SHA'),
    entry,
    outputDirectory: requiredEnvironment('HVIR_QUALIFICATION_OUTPUT_DIR'),
  })
  if (result.attempts.some((attempt) => attempt.status === 'failed')) process.exitCode = 1
}

async function summarizeCommand(): Promise<void> {
  const plan = await readJson<ElectronQualificationPlan>(
    requiredEnvironment('HVIR_QUALIFICATION_PLAN_PATH'),
  )
  rejectQualificationRerun(
    plan.mode,
    positiveIntegerEnvironment('HVIR_QUALIFICATION_RUN_ATTEMPT'),
  )
  const resultsRoot = requiredEnvironment('HVIR_QUALIFICATION_RESULTS_ROOT')
  const partitionPaths = await findNamedFiles(
    resultsRoot,
    (name) => name === 'partition.json',
  )
  const artifacts: unknown[] = []
  for (const path of partitionPaths) {
    try {
      artifacts.push(await readJson<unknown>(path))
    } catch {
      artifacts.push(null)
    }
  }
  const summary = combineElectronQualificationResults(plan, artifacts)
  const outputDirectory = requiredEnvironment('HVIR_QUALIFICATION_SUMMARY_DIR')
  await mkdir(outputDirectory, { recursive: true })
  await writeJsonAtomically(join(outputDirectory, 'summary.json'), summary)
  const markdown = `${formatElectronQualificationSummary(summary)}\n`
  await writeFile(join(outputDirectory, 'summary.md'), markdown, 'utf8')
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown, 'utf8')
  }
  console.log(markdown)
  if (!summary.passed) process.exitCode = 1
}

async function assertPartitionCommand(): Promise<void> {
  const path = join(
    requiredEnvironment('HVIR_QUALIFICATION_OUTPUT_DIR'),
    'partition.json',
  )
  const result = await readJson<ElectronQualificationPartitionResult>(path)
  if (
    result.attempts.length !== result.expectedAttempts ||
    result.attempts.some((attempt) => attempt.status === 'failed')
  ) {
    throw new Error('Qualification partition did not pass every planned invocation')
  }
}

async function assertSummaryCommand(): Promise<void> {
  const summary = await readJson<ElectronQualificationSummary>(
    join(requiredEnvironment('HVIR_QUALIFICATION_SUMMARY_DIR'), 'summary.json'),
  )
  if (!summary.passed) throw new Error('Electron qualification summary did not pass')
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function qualificationMode(value: string): ElectronQualificationMode {
  if (value === 'qualification' || value === 'sample') return value
  throw new Error('Qualification mode must be qualification or sample')
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function positiveIntegerEnvironment(name: string): number {
  const value = requiredEnvironment(name)
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer`)
  return Number(value)
}

function rejectQualificationRerun(
  mode: ElectronQualificationMode,
  runAttempt: number,
): void {
  if (mode === 'qualification' && runAttempt !== 1) {
    throw new Error('Qualification evidence cannot be replaced by a workflow rerun')
  }
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'plan') await planCommand()
  else if (command === 'partition') await partitionCommand()
  else if (command === 'summarize') await summarizeCommand()
  else if (command === 'assert-partition') await assertPartitionCommand()
  else if (command === 'assert-summary') await assertSummaryCommand()
  else
    throw new Error(`Unknown Electron qualification command ${JSON.stringify(command)}`)
}

if (
  process.argv[1] &&
  basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))
) {
  void main().catch(() => {
    console.error('[electron:qualification] command failed')
    process.exitCode = 1
  })
}
