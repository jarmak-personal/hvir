/* global TextEncoder */
import {
  registeredLibrary,
  sameLibrary,
  removalPreview,
  digest,
} from './management-contract.mjs'
import { syncArgs, removalArgs } from './management-argv.mjs'
import { syncObservation } from './management-library.mjs'
import { exposureFacts } from './exposure-reconcile.mjs'
import { prepareCopy } from './management-copy.mjs'

/** Public present-state facts establish safe next operations, never historical completion. */
export async function reconciliationFacts(io, record, workspace) {
  const operation = record.operation,
    library = registeredLibrary(await io.run(['library', 'status', '--json']))
  let current
  if (operation.action === 'initialize-library') {
    if (
      operation.selection.location === 'custom' &&
      library.root.path !== operation.selection.root.path
    )
      throw new Error(
        'The selected initialization location is not the registered current library. Inspect/repair that location through ordinary file tools and the public CLI; original completion remains unknown.',
      )
    current = {
      action: operation.action,
      registered: library,
      originalCompletion: 'unknown',
      ...(operation.selection.location === 'default'
        ? {
            target: 'unknown',
            safeNext:
              'Current registration is observed; original default initialization completion and any partial files remain unknown. Do not replay it automatically.',
          }
        : {}),
    }
  } else {
    sameLibrary(operation.library, library)
    if (operation.action === 'change-exposure') {
      current = await exposureFacts(io, operation, workspace, library)
    } else if (operation.action === 'accept-version') {
      const value = await io.run(['library', 'status', operation.source.id, '--json'])
      sameLibrary(library, registeredLibrary(value))
      const skill = value.skill
      if (
        skill?.id !== operation.source.id ||
        skill.path !== operation.source.root.path ||
        !['pending', 'accepted'].includes(skill.acceptance)
      )
        throw new Error(
          'Supported current canonical acceptance state is unavailable; repair through public CLI before reconciliation',
        )
      digest(skill.working_hash)
      if (skill.accepted_hash !== null) digest(skill.accepted_hash)
      current = {
        action: operation.action,
        registered: library,
        source: operation.source.root,
        workingHash: skill.working_hash,
        acceptedHash: skill.accepted_hash,
        acceptance: skill.acceptance,
        safeNext:
          'Original completion remains unknown. Any new acceptance requires complete current-tree reading and a fresh exact manifest/token decision.',
      }
    } else if (operation.action === 'sync-library') {
      const observed = syncObservation(await io.run(syncArgs(library)), library)
      if (
        !observed.coverage.complete ||
        observed.candidates.some(
          (item) =>
            ![
              'eligible-create',
              'eligible-update',
              'current',
              'skipped',
              'conflict',
            ].includes(item.state),
        )
      )
        throw new Error(
          'Supported complete synchronization observations do not yet establish safe repeat facts. Follow public CLI repair guidance; original completion remains unknown.',
        )
      current = {
        action: operation.action,
        registered: library,
        coverage: observed.coverage,
        candidates: observed.candidates.map((item) => [
          item.source_identity,
          item.canonical_skill_id,
          item.state,
          item.reason_code,
        ]),
      }
    } else {
      if (
        workspace?.id !== operation.workspace?.id ||
        workspace?.host !== operation.workspace?.host ||
        workspace?.root?.path !== operation.workspace?.root?.path
      )
        throw new Error(
          'Reconcile in the exact originally admitted host-qualified workspace',
        )
      const observed = await io.run([
        'expose',
        '--list',
        '--agent',
        operation.agent,
        '--scope',
        'project',
        '--json',
      ])
      if (
        observed.schema !== 'skillager.exposures.v1' ||
        !Array.isArray(observed.exposures)
      )
        throw new Error('Current managed-target observations are unavailable')
      const matches = observed.exposures.filter(
        (item) =>
          item.exposure_id === operation.exposureId &&
          item.agent === operation.agent &&
          item.scope === 'project',
      )
      if (matches.length > 1) throw new Error('Managed-target identity is ambiguous')
      if (matches.length) {
        const request = {
          workspace,
          agent: operation.agent,
          exposureId: operation.exposureId,
          target: operation.target,
        }
        const plan = removalPreview(await io.run(removalArgs(request)), request)
        current = {
          action: operation.action,
          target: operation.target,
          state: 'managed',
          exposureId: operation.exposureId,
          mode: matches[0].mode,
          currentHash: matches[0].current_hash,
          targetState: plan.preview.target_state_hash,
          token: plan.token,
        }
      } else if (operation.action === 'remove-copy') {
        current = {
          action: operation.action,
          target: operation.target,
          state: 'managed-record-absent',
          safeNext:
            'Remove has no current managed target. A new Add must independently prove an absent create-only destination.',
        }
      } else {
        const prepared = await prepareCopy(
          io,
          {
            library,
            skillId: operation.source.id,
            agent: operation.agent,
            mode: operation.mode,
          },
          workspace,
          false,
          true,
        )
        if (prepared.plan.target !== operation.target.path)
          throw new Error(
            'Current create-only destination differs from the uncertain operation',
          )
        current = {
          action: operation.action,
          target: operation.target,
          state: 'create-only-absent',
          source: prepared.request.source,
          token: prepared.plan.token,
        }
      }
    }
  }
  const observation = JSON.stringify(current)
  if (new TextEncoder().encode(observation).length > 6144)
    throw new Error(
      'Complete safe-repeat observations exceed the action bound. Reconcile through the public CLI; no partial acknowledgment is accepted.',
    )
  return observation
}
