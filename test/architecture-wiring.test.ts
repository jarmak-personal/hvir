import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import {
  admitArchitectureWiring,
  assertCiArchitectureGate,
  assertPackageArchitectureGate,
  policyOnlyPath,
} from '../scripts/architecture-wiring.mts'
import { budget, ordinaryPolicy, repository } from './fixtures/architecture/repository.ts'

const fixtures: ReturnType<typeof repository>[] = []
afterEach(() => {
  for (const r of fixtures.splice(0)) r.dispose()
})
const json = (value: unknown) => Buffer.from(JSON.stringify(value))
const yaml = (value: unknown) => Buffer.from(stringify(value))
function packageFixture() {
  return {
    dependencies: { renderer: '1.0' },
    scripts: { verify: 'npm run lint && npm test', build: 'original build' },
  }
}
function admittedPackage() {
  const value = packageFixture()
  return {
    ...value,
    scripts: {
      ...value.scripts,
      verify: 'npm run lint && npm run architecture:check && npm test',
      'architecture:check': 'node scripts/architecture-hotspots.mjs --enforce',
      'architecture:report': 'node scripts/architecture-hotspots.mjs',
    },
  }
}
function workflow() {
  return {
    name: 'CI',
    on: { pull_request: {} },
    jobs: {
      verify: {
        steps: [
          { uses: 'actions/checkout@fixed', with: { 'fetch-depth': 0 } },
          { run: 'npm run verify' },
        ],
      },
      smoke: { steps: [{ run: 'npm run smoke' }] },
    },
  }
}
function admittedWorkflow() {
  const value = workflow()
  return {
    ...value,
    jobs: {
      ...value.jobs,
      verify: {
        ...value.jobs.verify,
        permissions: {
          actions: 'read',
          contents: 'read',
          issues: 'read',
          'pull-requests': 'read',
        },
        steps: [
          value.jobs.verify.steps[0]!,
          { run: 'npm run verify', env: { HVIR_REPO_TOKEN: '${{ github.token }}' } },
        ],
      },
    },
  }
}
describe('architecture verification and bounded proposal wiring', () => {
  it('keeps the real local gate and required CI token, permissions, and merge-ref inputs', () => {
    const manifest: unknown = JSON.parse(readFileSync('package.json', 'utf8'))
    const ci: unknown = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
    expect(() => assertPackageArchitectureGate(manifest)).not.toThrow()
    expect(() => assertCiArchitectureGate(ci)).not.toThrow()
  })
  it('admits only the required package gate changes', () => {
    expect(() =>
      admitArchitectureWiring(
        'package.json',
        json(packageFixture()),
        json(admittedPackage()),
      ),
    ).not.toThrow()
    for (const after of [
      { ...admittedPackage(), dependencies: { renderer: '2.0' } },
      {
        ...admittedPackage(),
        scripts: { ...admittedPackage().scripts, build: 'unrelated product build' },
      },
      {
        ...admittedPackage(),
        scripts: { ...admittedPackage().scripts, verify: 'npm run architecture:check' },
      },
      {
        ...admittedPackage(),
        scripts: {
          ...admittedPackage().scripts,
          'architecture:check': 'node scripts/architecture-hotspots.mjs',
        },
      },
    ])
      expect(() =>
        admitArchitectureWiring('package.json', json(packageFixture()), json(after)),
      ).toThrow()
  })
  it('admits required CI evidence wiring but rejects unrelated jobs, commands, and authority', () => {
    expect(() =>
      admitArchitectureWiring(
        '.github/workflows/ci.yml',
        yaml(workflow()),
        yaml(admittedWorkflow()),
      ),
    ).not.toThrow()
    for (const mutate of [
      (value: ReturnType<typeof admittedWorkflow>) => {
        value.jobs.smoke.steps[0]!.run = 'skip smoke'
      },
      (value: ReturnType<typeof admittedWorkflow>) => {
        value.jobs.verify.permissions.actions = 'write'
      },
      (value: ReturnType<typeof admittedWorkflow>) => {
        value.jobs.verify.steps.push({ run: 'npm run unrelated' })
      },
      (value: ReturnType<typeof admittedWorkflow>) => {
        value.jobs.verify.steps[0] = {
          uses: 'other/checkout@fixed',
          with: { 'fetch-depth': 0 },
        }
      },
    ]) {
      const after = admittedWorkflow()
      mutate(after)
      expect(() =>
        admitArchitectureWiring(
          '.github/workflows/ci.yml',
          yaml(workflow()),
          yaml(after),
        ),
      ).toThrow()
    }
    const extra = {
      ...admittedWorkflow(),
      jobs: {
        ...admittedWorkflow().jobs,
        unrelated: { steps: [{ run: 'echo unrelated' }] },
      },
    }
    expect(() =>
      admitArchitectureWiring('.github/workflows/ci.yml', yaml(workflow()), yaml(extra)),
    ).toThrow()
  })
  it.each([
    'scripts/architecture-product.mts',
    'test/architecture-unrelated.test.ts',
    'test/fixtures/architecture/product.ts',
    'vitest.config.ts',
  ])('rejects invented policy-only identity %s', (path) => {
    expect(policyOnlyPath(path)).toBe(false)
  })
  it('rejects unrelated package work through complete Git proposal admission', async () => {
    const r = repository()
    fixtures.push(r)
    r.source(1400)
    r.write('package.json', json(packageFixture()).toString())
    const base = r.commit()
    const policy = ordinaryPolicy()
    policy.budgets.push(budget())
    r.policy(policy)
    r.write(
      'package.json',
      json({ ...admittedPackage(), dependencies: { renderer: '2.0' } }).toString(),
    )
    await expect(r.check(base)).rejects.toThrow(/unrelated verification wiring/)
  })
})
