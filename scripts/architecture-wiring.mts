import { isDeepStrictEqual } from 'node:util'
import { parse } from 'yaml'
import type { Buffer } from 'node:buffer'

export const ARCHITECTURE_MODULES = [
  'scripts/architecture-hotspots.mjs',
  'scripts/architecture-hotspots.mts',
  'scripts/architecture-policy.mts',
  'scripts/architecture-inventory.mts',
  'scripts/architecture-authorization.mts',
  'scripts/architecture-github.mts',
  'scripts/architecture-wiring.mts',
] as const
export const ARCHITECTURE_TESTS = [
  'test/architecture-hotspots.test.ts',
  'test/architecture-policy.test.ts',
  'test/architecture-history.test.ts',
  'test/architecture-github.test.ts',
  'test/architecture-wiring.test.ts',
  'test/fixtures/architecture/repository.ts',
] as const
const WIRING_PATHS = ['package.json', '.github/workflows/ci.yml', 'eslint.config.mjs']
export function policyOnlyPath(path: string): boolean {
  return (
    path === 'scripts/architecture-hotspots.json' ||
    path === 'docs/architecture-budgets.md' ||
    [...ARCHITECTURE_MODULES, ...ARCHITECTURE_TESTS, ...WIRING_PATHS].includes(path)
  )
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed architecture verification wiring')
  return value as Record<string, unknown>
}
function equal(before: unknown, after: unknown): void {
  if (!isDeepStrictEqual(before, after))
    throw new Error('Policy proposal includes unrelated verification wiring changes')
}
function verifyCommands(value: unknown): string[] {
  if (typeof value !== 'string') throw new Error('Missing normal verify command')
  return value.split('&&').map((command) => command.trim())
}
export function assertPackageArchitectureGate(value: unknown): void {
  const scripts = object(object(value).scripts)
  if (
    verifyCommands(scripts.verify).filter(
      (command) => command === 'npm run architecture:check',
    ).length !== 1 ||
    scripts['architecture:check'] !==
      'node scripts/architecture-hotspots.mjs --enforce' ||
    scripts['architecture:report'] !== 'node scripts/architecture-hotspots.mjs'
  )
    throw new Error('Architecture package gate must remain blocking')
}
function admitPackage(beforeBytes: Buffer, afterBytes: Buffer): void {
  const before = object(JSON.parse(beforeBytes.toString())),
    after = object(JSON.parse(afterBytes.toString()))
  assertPackageArchitectureGate(after)
  const oldScripts = object(before.scripts),
    newScripts = object(after.scripts)
  equal(
    verifyCommands(oldScripts.verify).filter(
      (command) => command !== 'npm run architecture:check',
    ),
    verifyCommands(newScripts.verify).filter(
      (command) => command !== 'npm run architecture:check',
    ),
  )
  for (const key of ['verify', 'architecture:check', 'architecture:report']) {
    if (Object.hasOwn(oldScripts, key)) newScripts[key] = oldScripts[key]
    else delete newScripts[key]
  }
  equal(before, after)
}
function verificationJob(workflow: unknown): Record<string, unknown> {
  return object(object(object(workflow).jobs).verify)
}
function steps(job: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(job.steps)) throw new Error('Missing verification steps')
  return job.steps.map(object)
}
function verificationStep(job: Record<string, unknown>): Record<string, unknown> {
  const matches = steps(job).filter((step) => step.run === 'npm run verify')
  if (matches.length !== 1)
    throw new Error('Architecture CI needs one normal verification step')
  return matches[0]!
}
function checkout(job: Record<string, unknown>): Record<string, unknown> {
  const matches = steps(job).filter(
    (step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'),
  )
  if (matches.length !== 1)
    throw new Error('Architecture CI needs one merge-ref checkout')
  return matches[0]!
}
export function assertCiArchitectureGate(workflow: unknown): void {
  const job = verificationJob(workflow),
    permissions = object(job.permissions)
  for (const name of ['actions', 'contents', 'issues', 'pull-requests']) {
    if (permissions[name] !== 'read')
      throw new Error('Architecture CI requires bounded read-only evidence permissions')
  }
  if (object(verificationStep(job).env).HVIR_REPO_TOKEN !== '${{ github.token }}')
    throw new Error('Architecture CI requires its repository evidence token')
  const input = object(checkout(job).with)
  if (input['fetch-depth'] !== 0 || input.ref !== undefined)
    throw new Error(
      'Architecture CI must retain complete history and the PR merge-ref checkout',
    )
  const trigger = object(object(workflow).on)
  if (!Object.hasOwn(trigger, 'pull_request'))
    throw new Error('Architecture CI requires the pull_request event inputs')
}
function admitCi(beforeBytes: Buffer, afterBytes: Buffer): void {
  const before = object(parse(beforeBytes.toString())),
    after = object(parse(afterBytes.toString()))
  assertCiArchitectureGate(after)
  const oldJob = verificationJob(before),
    newJob = verificationJob(after)
  const oldPermissions =
    oldJob.permissions === undefined ? {} : object(oldJob.permissions)
  equal(newJob.permissions, {
    ...oldPermissions,
    actions: 'read',
    contents: 'read',
    issues: 'read',
    'pull-requests': 'read',
  })
  if (oldJob.permissions === undefined) delete newJob.permissions
  else newJob.permissions = oldJob.permissions
  const oldStep = verificationStep(oldJob),
    newStep = verificationStep(newJob)
  const oldEnvironment = oldStep.env === undefined ? {} : object(oldStep.env)
  equal(newStep.env, { ...oldEnvironment, HVIR_REPO_TOKEN: '${{ github.token }}' })
  if (oldStep.env === undefined) delete newStep.env
  else newStep.env = oldStep.env
  const oldInput = object(checkout(oldJob).with),
    newInput = object(checkout(newJob).with)
  if (Object.hasOwn(oldInput, 'fetch-depth'))
    newInput['fetch-depth'] = oldInput['fetch-depth']
  else delete newInput['fetch-depth']
  equal(before, after)
}
function admitEslint(before: Buffer, after: Buffer): void {
  // The only lint adapter change is adding these exact contributor owners to the
  // established native-primitive exemption list. No rule or other file can change.
  const marker = "      'scripts/run-smoke-scenarios.mts',\n"
  const added = ARCHITECTURE_MODULES.filter((path) => path.endsWith('.mts'))
    .map((path) => `      '${path}',\n`)
    .join('')
  const oldText = before.toString(),
    newText = after.toString()
  if (!oldText.includes(marker))
    throw new Error('Missing established contributor lint exemption seam')
  if (oldText === newText) return
  equal(oldText.replace(marker, marker + added), newText)
}
export function admitArchitectureWiring(
  path: string,
  before: Buffer | null,
  after: Buffer | null,
): void {
  if (!WIRING_PATHS.includes(path)) return
  if (!before || !after)
    throw new Error('Policy proposal cannot add or remove an entire verification owner')
  if (path === 'package.json') admitPackage(before, after)
  else if (path === '.github/workflows/ci.yml') admitCi(before, after)
  else admitEslint(before, after)
}
