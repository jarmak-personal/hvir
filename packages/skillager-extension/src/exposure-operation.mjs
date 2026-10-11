import {
  registeredLibrary,
  sameLibrary,
  boundedManagementResult,
} from './management-contract.mjs'
import { applyCopy } from './management-copy.mjs'
import {
  exposureRequest,
  planArgs,
  exposurePlan,
  planCompletion,
} from './exposure-contract.mjs'

export async function prepareExposureChange(io, input, workspace) {
  const library = registeredLibrary(await io.run(['library', 'status', '--json']))
  sameLibrary(input.library, library)
  const request = exposureRequest(input.request)
  const selection = { library, agent: input.agent, request }
  const value = await io.run(
    planArgs(input.request, input.agent),
    undefined,
    true,
    (value, code) => {
      if (![0, 2].includes(code) || value.schema !== 'skillager.exposure-plan.v1')
        throw new Error(
          'Installed Skillager has no supported complete exposure-plan response. Install the public contract, then preview again.',
        )
    },
  )
  const plan = exposurePlan(value, selection, workspace)
  // Preserve raw request admission: whitespace/escaping may differ from parsed metadata.
  planArgs(input.request, input.agent, plan.confirmation_token)
  return { input: selection, plan }
}
export function copyChangeInput(input) {
  const { library, agent, token, ...request } = input
  return {
    library,
    agent,
    token,
    request: JSON.stringify({ action: 'update-copy', ...request }),
  }
}
export async function applyExposureChange(io, input, workspace, admit = () => {}) {
  const request = JSON.parse(input.request)
  if (request.action === 'update-copy') {
    // This is the existing direct-copy owner, with a new exported semantic action.
    const selection = { ...request }
    delete selection.action
    return {
      ...(await applyCopy(
        io,
        'update-copy',
        { ...selection, library: input.library, agent: input.agent, token: input.token },
        workspace,
        admit,
      )),
      action: 'change-exposure',
    }
  }
  const prepared = await prepareExposureChange(io, input, workspace),
    plan = prepared.plan
  if (input.token !== plan.confirmation_token)
    throw new Error(
      'The reviewed sources, membership or files changed. Review the complete fresh plan before confirming.',
    )
  const descriptor = {
    action: 'change-exposure',
    library: prepared.input.library,
    workspace,
    agent: input.agent,
    request: prepared.input.request,
    requestRaw: input.request,
    token: input.token,
    targets: plan.targets
      .filter((target) => target.action !== 'keep')
      .map((target) => ({ hostId: 'local', path: target.path })),
    plan,
  }
  admit(descriptor)
  let exit
  const value = await io.run(
    planArgs(input.request, input.agent, input.token),
    descriptor,
    false,
    (_value, code) => {
      exit = code
    },
  )
  await planCompletion(value, exit, plan, prepared.input, workspace)
  const refused =
    value.status === 'refused' &&
    value.results.every(
      (item) =>
        ['refused', 'unchanged'].includes(item.status) && item.recovery_path === null,
    )
  // All outcomes remain in the report even when a successful result exceeds D4's return bound.
  const reply = boundedManagementResult({
    outcome: value.status === 'applied' ? 'verified' : refused ? 'refused' : 'uncertain',
    action: 'change-exposure',
    operation: plan.request.action,
    results: value.results.map(
      ({ target_id, path, status, reason_code, recovery_path }) => ({
        targetId: target_id,
        target: { hostId: 'local', path },
        status,
        reason: reason_code,
        recoveryPath: recovery_path ? { hostId: 'local', path: recovery_path } : null,
      }),
    ),
    message:
      value.status === 'applied'
        ? 'Every selected skill-file change was verified by Skillager. Restart the agent to use the new files.'
        : refused
          ? 'Skillager refused the exact plan before changing skill files. Resolve the reported conflict and preview a fresh complete plan before another explicit change.'
          : 'Skillager reported incomplete changes. Inspect every target and retained recovery location; do not repeat the mutation.',
  })
  if (value.status === 'applied' || refused) io.verified()
  return reply
}
