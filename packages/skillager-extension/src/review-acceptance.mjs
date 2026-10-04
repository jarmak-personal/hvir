import {
  registeredLibrary,
  sameLibrary,
  acceptedSource,
  digest,
  boundedManagementResult,
} from './management-contract.mjs'
import { exactReviewManifest } from './review-contract.mjs'
import { acceptanceArgs } from './management-argv.mjs'

/** This action cannot obtain bodies; the ordinary human view already reviewed every bound file. */
export async function acceptReviewedVersion(io, input, invocation, admit) {
  if (invocation.caller === 'agent')
    throw new Error(
      'Exact instruction acceptance is human-only; agent body gates remain unchanged',
    )
  digest(input.hash)
  digest(input.token)
  const library = registeredLibrary(await io.run(['library', 'status', '--json']))
  sameLibrary(input.library, library)
  const current = exactReviewManifest(await io.run(acceptanceArgs(input.skillId)), {
    library,
    skillId: input.skillId,
    hash: input.hash,
  })
  if (!current.eligible || current.manifest.confirmation_token !== input.token)
    throw new Error(
      current.gate ??
        'The exact human-reviewed version/token changed; read and confirm a fresh complete review.',
    )
  const root = { hostId: 'local', path: current.manifest.skill_root }
  admit({
    action: 'accept-version',
    library,
    source: { id: input.skillId, hash: input.hash, root },
  })
  const value = await io.run(acceptanceArgs(input.skillId, input.token), {
    action: 'accept-version',
    library,
    source: { id: input.skillId, hash: input.hash, root },
    token: input.token,
  })
  if (
    value.schema !== 'skillager.library-accept.v1' ||
    value.status !== 'accepted' ||
    value.skill?.id !== input.skillId ||
    value.skill.working_hash !== input.hash ||
    value.skill.path !== root.path
  )
    throw new Error(
      'Submitted acceptance has no complete exact accepted result. Reconcile public status; original completion is unknown.',
    )
  const observed = acceptedSource(
    await io.run(['library', 'status', input.skillId, '--json']),
    library,
    input.skillId,
    input.hash,
  )
  const reply = boundedManagementResult({
    outcome: 'verified',
    action: 'accept-version',
    library,
    source: observed,
  })
  io.verified()
  return reply
}
