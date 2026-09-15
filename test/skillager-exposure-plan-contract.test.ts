import { expect, it } from 'vitest'
import {
  parsePlanApplied,
  parsePlanPreview,
} from '../src/main/skillager/skillager-exposure-plan-contract'
import { validateLifecycleSelection } from '../src/main/skillager/skillager-exposure-plan-selection'
import {
  planApplied,
  planRequest,
  planResponse,
  planSelection,
  planToken,
} from './fixtures/skillager-plan-fixture'

it('projects complete target modes/effects and source evidence while keeping the aggregate token in main', () => {
  const snapshot = parsePlanPreview(planResponse(), 0, planSelection, planRequest)
  expect(
    snapshot.detail.targets.map((target) => [
      target.kind,
      target.before,
      target.after?.mode,
      target.effects.length,
    ]),
  ).toEqual([
    ['tags', null, 0o644, 1],
    ['router', null, 0o755, 2],
  ])
  expect(snapshot.detail.sources[0]).toContain('"evidence_id"')
  expect(JSON.stringify(snapshot.detail)).not.toContain(planToken)
  expect(snapshot.confirmationToken).toBe(planToken)
  expect(parsePlanApplied(planApplied(), 0, snapshot).status).toBe('applied')
})
it.each([
  'project',
  'library',
  'agent',
  'command',
  'target',
  'duplicate',
  'effects',
  'modes',
  'members',
  'staging',
] as const)('refuses mismatched %s preview authority', (kind) => {
  const raw = planResponse()
  if (kind === 'project') raw.project = '/other'
  if (kind === 'library') raw.library_id = 'foreign'
  if (kind === 'agent') raw.agent = 'claude'
  if (kind === 'command') raw.next_command_argv.push('--force')
  if (kind === 'target') raw.targets[0]!.path = '/outside/tags.json'
  if (kind === 'duplicate') raw.targets.push(raw.targets[0]!)
  if (kind === 'effects') raw.targets[1]!.file_effects[0]!.path = '../SKILL.md'
  if (kind === 'modes') raw.targets[0]!.after.mode = -1
  if (kind === 'members') raw.group.after_members = ['lib/foreign']
  if (kind === 'staging') raw.staging.peak_bytes++
  expect(() => parsePlanPreview(raw, 0, planSelection, planRequest)).toThrow()
})
it('treats a public pre-mutation stale refusal distinctly even when its rebuilt payload changed', () => {
  const snapshot = parsePlanPreview(planResponse(), 0, planSelection, planRequest)
  for (const raw of [
    {
      schema: 'skillager.exposure-plan.v1',
      status: 'refused',
      reason_code: 'target-changed',
      results: [],
    },
    {
      ...planApplied(),
      status: 'refused',
      plan_hash: undefined,
      sources: [],
      results: planApplied().results.map((item) => ({ ...item, status: 'refused' })),
    },
  ])
    expect(() => parsePlanApplied(raw, 2, snapshot)).toThrow(
      'Skillager refused this action',
    )
  expect(() =>
    parsePlanApplied({ ...planApplied(), status: 'refused' }, 2, snapshot),
  ).toThrow('invalid or incomplete')
})
it('preserves every partial result, including rollback, actual observations and retained recovery paths', () => {
  const snapshot = parsePlanPreview(planResponse(), 0, planSelection, planRequest)
  const raw = {
    ...planApplied(),
    status: 'partial',
    reason_code: 'cleanup-failed',
    results: planApplied().results.map((result, i) => ({
      ...result,
      status: i ? 'recovery_required' : 'rolled_back',
      observed_state_hash: null,
      recovery_path: i ? '/workspace/.agents/skills/.stage/previous' : null,
      reason_code: 'cleanup-failed',
    })),
  }
  expect(parsePlanApplied(raw, 2, snapshot)).toMatchObject({
    kind: 'plan',
    status: 'partial',
    targets: [
      { status: 'rolled_back', observedHash: null },
      {
        status: 'recovery_required',
        recoveryPath: {
          hostId: 'local',
          path: '/workspace/.agents/skills/.stage/previous',
        },
      },
    ],
  })
  expect(() => parsePlanApplied({ ...raw, targets: [] }, 2, snapshot)).toThrow()
  expect(() =>
    parsePlanApplied({ ...raw, results: raw.results.slice(0, 1) }, 2, snapshot),
  ).toThrow()
})
it('requires each completed target presence to agree with its admitted after-state while allowing generated hashes to differ', () => {
  const snapshot = parsePlanPreview(planResponse(), 0, planSelection, planRequest)
  const absentCreation = {
    ...planApplied(),
    results: planApplied().results.map((item) => ({
      ...item,
      observed_state_hash: null,
    })),
  }
  expect(() => parsePlanApplied(absentCreation, 0, snapshot)).toThrow()
  const generated = {
    ...planApplied(),
    results: planApplied().results.map((item) => ({
      ...item,
      observed_state_hash: 'f'.repeat(64),
    })),
  }
  expect(parsePlanApplied(generated, 0, snapshot).status).toBe('applied')
  const removal = {
    ...snapshot,
    detail: {
      ...snapshot.detail,
      targets: snapshot.detail.targets.map((item) => ({ ...item, after: null })),
    },
  }
  expect(() =>
    parsePlanApplied({ ...planApplied(), status: 'partial' }, 2, removal),
  ).toThrow()
})
it('preserves an untouched absent target in a complete partial outcome', () => {
  const snapshot = parsePlanPreview(planResponse(), 0, planSelection, planRequest)
  const raw = {
    ...planApplied(),
    status: 'partial',
    results: planApplied().results.map((item) => ({
      ...item,
      status: 'unchanged',
      observed_state_hash: null,
    })),
  }
  expect(parsePlanApplied(raw, 2, snapshot).targets).toEqual([
    expect.objectContaining({ status: 'unchanged', observedHash: null }),
    expect.objectContaining({ status: 'unchanged', observedHash: null }),
  ])
  expect(() =>
    parsePlanApplied(
      {
        ...raw,
        results: raw.results.map((item) => ({
          ...item,
          observed_state_hash: 'f'.repeat(64),
        })),
      },
      2,
      snapshot,
    ),
  ).toThrow()
})
it('rejects unsupported schemas and finite request/target/effect bounds without partial disclosure', () => {
  expect(() =>
    parsePlanPreview({ schema: 'legacy' }, 0, planSelection, planRequest),
  ).toThrow('not supported')
  expect(() =>
    validateLifecycleSelection(
      {
        ...planRequest,
        plan: {
          schema: 'skillager.exposure-request.v1',
          action: 'group',
          name: 'x',
          library_id: planSelection.library.id,
          members: Array.from({ length: 65 }, (_, i) => `lib/item${i}`),
          replace: [],
        },
      },
      planSelection,
    ),
  ).toThrow()
  const targets = planResponse()
  targets.targets = Array.from({ length: 129 }, () => targets.targets[0]!)
  expect(() => parsePlanPreview(targets, 0, planSelection, planRequest)).toThrow()
  const effects = planResponse()
  Object.assign(effects.targets[1]!, {
    file_effects: Array.from(
      { length: 2049 },
      () => effects.targets[1]!.file_effects[0]!,
    ),
  })
  expect(() => parsePlanPreview(effects, 0, planSelection, planRequest)).toThrow()
})
