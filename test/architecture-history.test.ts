import type { ArchitectureBudget } from '../scripts/architecture-policy.mts'
import type { authorizeCandidate } from '../scripts/architecture-authorization.mts'
import { afterEach, describe, expect, it } from 'vitest'
import { budget, ordinaryPolicy, repository } from './fixtures/architecture/repository.ts'

const fixtures: ReturnType<typeof repository>[] = []
function repo() {
  const r = repository()
  fixtures.push(r)
  return r
}
afterEach(() => {
  for (const r of fixtures.splice(0)) r.dispose()
})

function bootstrap(
  r: ReturnType<typeof repository>,
  kind: ArchitectureBudget['kind'] = 'transitional',
  maximum = 1400,
) {
  r.source(1400)
  const base = r.commit()
  const policy = ordinaryPolicy()
  policy.budgets.push(budget(kind, maximum))
  r.policy(policy)
  return { base, policy }
}
function row(report: Awaited<ReturnType<typeof authorizeCandidate>>) {
  return report.rows.find((e) => e.path === 'src/owner.ts')!
}

describe('architecture accepted Git history', () => {
  it('adopts stricter main policy during cumulative replay and rejects the superseded epic ceiling', async () => {
    const r = repo(),
      initial = ordinaryPolicy()
    initial.budgets.push(budget('durable', 1400))
    r.policy(initial)
    r.source(900)
    const main = r.commit()
    r.git('switch', '-c', 'epic/733-fixture')
    r.git('switch', '-c', 'policy-child')
    const epicPolicy = ordinaryPolicy()
    epicPolicy.budgets.push(budget('durable', 1500))
    r.policy(epicPolicy)
    r.commit()
    r.integrate('policy-child', main)
    r.git('switch', 'main')
    const tighter = ordinaryPolicy()
    tighter.budgets.push(budget('stricter', 900))
    r.policy(tighter)
    const freshMain = r.commit()
    r.git('switch', 'epic/733-fixture')
    r.git('merge', '-s', 'ours', '--no-ff', 'main', '-m', 'fixture main integration')
    await expect(r.check(freshMain, 'cumulative')).rejects.toThrow(
      /independently changed main/,
    )
    r.policy(tighter)
    expect(row(await r.check(freshMain, 'cumulative'))).toMatchObject({
      status: 'ok',
      effectiveLimit: 900,
      governingRule: 'stricter',
    })
  })
  it.each(['ordinary', 'epic-child'] as const)(
    'admits the unchanged bootstrap only as a %s policy proposal',
    async (kind) => {
      const r = repo(),
        { base } = bootstrap(r)
      const report = await r.check(base, kind)
      expect(report.admission.kind).toBe('policy-proposal')
      expect(row(report)).toMatchObject({ status: 'ok', effectiveLimit: 1400 })
      r.source(1300, 'src/unspecified.ts')
      await expect(r.check(base, kind)).rejects.toThrow(/policy-only/)
    },
  )
  it('rejects an untouched unspecified over-default sibling', async () => {
    const r = repo()
    r.source(1300, 'src/unspecified.ts')
    const { base } = bootstrap(r)
    const report = await r.check(base)
    expect(report.violations.map((e) => e.path)).toEqual(['src/unspecified.ts'])
  })
  it.each([false, true])(
    'rejects source self-authorization with separate commits=%s',
    async (separate) => {
      const r = repo(),
        { base } = bootstrap(r)
      if (separate) r.commit()
      r.source(1401)
      if (separate) r.commit()
      await expect(r.check(base)).rejects.toThrow(/policy-only/)
    },
  )
  it('rejects a checker authorizing its own exception even in the policy-only surface', async () => {
    const r = repo()
    r.source(1100, 'scripts/architecture-inventory.mts')
    const base = r.commit()
    const policy = ordinaryPolicy()
    policy.budgets.push(budget('durable', 1200, 'scripts/architecture-inventory.mts'))
    r.policy(policy)
    r.source(1150, 'scripts/architecture-inventory.mts')
    await expect(r.check(base)).rejects.toThrow(/newly authorized source/)
  })
  it.each(['ordinary', 'epic-child'] as const)(
    'ratchets a sequential accepted %s refactor and rejects regrowth',
    async (kind) => {
      const r = repo()
      bootstrap(r)
      const accepted = r.commit()
      r.source(1200)
      expect(row(await r.check(accepted, kind)).status).toBe('ok')
      const reduced = r.commit()
      r.source(1250)
      expect(row(await r.check(reduced, kind))).toMatchObject({
        effectiveLimit: 1200,
        status: 'over',
      })
    },
  )
  it('retains an established ratchet across deletion and reintroduction', async () => {
    const r = repo()
    bootstrap(r)
    r.commit()
    r.source(1200)
    r.commit()
    r.remove('src/owner.ts')
    const deleted = r.commit()
    r.source(1250)
    expect(row(await r.check(deleted))).toMatchObject({
      effectiveLimit: 1200,
      status: 'over',
    })
  })
  it('allows durable growth within an accepted maximum, and rejects excess or mixed ceiling increases', async () => {
    const r = repo(),
      { policy } = bootstrap(r, 'durable', 1600)
    const base = r.commit()
    r.source(1500)
    expect(row(await r.check(base)).status).toBe('ok')
    r.source(1601)
    expect(row(await r.check(base)).status).toBe('over')
    policy.budgets[0]!.maxLines = 1700
    r.policy(policy)
    await expect(r.check(base)).rejects.toThrow(/policy-only/)
  })
  it('reserves a durable new exact path before adding its source', async () => {
    const r = repo(),
      base = r.initial,
      policy = ordinaryPolicy()
    policy.budgets.push(budget('durable', 1600))
    r.policy(policy)
    expect((await r.check(base)).admission.kind).toBe('policy-proposal')
    r.source(1400)
    await expect(r.check(base)).rejects.toThrow(/policy-only/)
  })
  it('rejects a missing transitional base and governs a renamed path by default', async () => {
    const r = repo(),
      policy = ordinaryPolicy()
    policy.budgets.push(budget())
    r.policy(policy)
    const base = r.commit()
    r.source(1200)
    await expect(r.check(base)).rejects.toThrow(/Missing comparison-base/)
    r.remove('src/owner.ts')
    r.source(1200, 'src/renamed.ts')
    expect((await r.check(base)).violations.map((e) => e.path)).toEqual([
      'src/renamed.ts',
    ])
  })
  it('allows retiring a transitional cap as a consuming tightening without reopening space', async () => {
    const r = repo()
    bootstrap(r)
    const base = r.commit()
    r.source(900)
    r.policy(ordinaryPolicy())
    expect(row(await r.check(base))).toMatchObject({
      status: 'ok',
      governingRule: 'ordinary',
    })
    const policy = ordinaryPolicy()
    policy.budgets.push(budget())
    r.policy(policy)
    const reduced = r.commit()
    r.policy(ordinaryPolicy())
    r.source(950)
    await expect(r.check(reduced)).rejects.toThrow(/policy-only/)
  })
  it('blocks removing a stricter cap or switching to durable while consuming new space', async () => {
    const r = repo(),
      policy = ordinaryPolicy()
    policy.budgets.push(budget('stricter', 100))
    r.policy(policy)
    r.source(90)
    const base = r.commit()
    r.policy(ordinaryPolicy())
    r.source(101)
    await expect(r.check(base)).rejects.toThrow(/policy-only/)
  })
  it('fails stale or missing exact bases', async () => {
    const r = repo()
    r.source(1)
    const later = r.commit()
    r.git('checkout', '--detach', r.initial)
    await expect(r.check(later)).rejects.toThrow(/Stale comparison base/)
    await expect(r.check('f'.repeat(40))).rejects.toThrow()
  })
  it('replays separate accepted bootstrap and refactor integrations for cumulative delivery', async () => {
    const r = repo()
    r.source(1400)
    const main = r.commit()
    r.git('switch', '-c', 'epic/733-fixture')
    r.git('switch', '-c', 'policy-child')
    const policy = ordinaryPolicy()
    policy.budgets.push(budget())
    r.policy(policy)
    r.commit()
    const accepted = r.integrate('policy-child', main)
    r.git('switch', '-c', 'refactor-child')
    r.source(1200)
    r.commit()
    r.integrate('refactor-child', accepted)
    expect(row(await r.check(main, 'cumulative'))).toMatchObject({
      status: 'ok',
      effectiveLimit: 1200,
    })
    r.source(1250)
    expect(row(await r.check(main, 'cumulative'))).toMatchObject({
      status: 'over',
      effectiveLimit: 1200,
    })
    r.evidence.clear()
    await expect(r.check(main, 'cumulative')).rejects.toThrow(/Missing accepted/)
  })
  it('replays a consuming policy tightening and exception removal', async () => {
    const r = repo()
    r.source(1400)
    const main = r.commit()
    r.git('switch', '-c', 'epic/733-fixture')
    r.git('switch', '-c', 'policy-child')
    const policy = ordinaryPolicy()
    policy.budgets.push(budget())
    r.policy(policy)
    r.commit()
    const accepted = r.integrate('policy-child', main)
    r.git('switch', '-c', 'refactor-child')
    r.source(900)
    r.policy(ordinaryPolicy())
    r.commit()
    r.integrate('refactor-child', accepted)
    expect(row(await r.check(main, 'cumulative'))).toMatchObject({
      status: 'ok',
      effectiveLimit: 1000,
    })
  })
  it.each(['wrong-epic', 'wrong-head', 'direct-policy'])(
    'rejects cumulative %s provenance',
    async (defect) => {
      const r = repo()
      r.source(1400)
      const main = r.commit()
      r.git('switch', '-c', 'epic/733-fixture')
      r.git('switch', '-c', 'policy-child')
      const policy = ordinaryPolicy()
      policy.budgets.push(budget('durable', 1600))
      r.policy(policy)
      r.commit()
      if (defect !== 'direct-policy') {
        const merge = r.integrate('policy-child', main),
          evidence = r.evidence.get(merge)!
        if (defect === 'wrong-epic') evidence.epic = 'epic/999-other'
        else evidence.head = main
      }
      await expect(r.check(main, 'cumulative')).rejects.toThrow(/evidence/)
    },
  )
  it('does not overwrite an independently tightened main rule using older epic approval', async () => {
    const r = repo()
    r.source(1400)
    const main = r.commit()
    r.git('switch', '-c', 'epic/733-fixture')
    r.git('switch', '-c', 'policy-child')
    const policy = ordinaryPolicy()
    policy.budgets.push(budget('durable', 1600))
    r.policy(policy)
    r.commit()
    r.integrate('policy-child', main)
    r.git('switch', 'main')
    policy.budgets = [budget('durable', 1500)]
    r.policy(policy)
    const freshMain = r.commit()
    r.git('switch', 'epic/733-fixture')
    // Deliberately retain the epic's 1600 policy in the merge to exercise conflict rejection.
    r.git('merge', '-s', 'ours', '--no-ff', 'main', '-m', 'fixture main integration')
    await expect(r.check(freshMain, 'cumulative')).rejects.toThrow(
      /conflicts with independently changed main/,
    )
  })
})
