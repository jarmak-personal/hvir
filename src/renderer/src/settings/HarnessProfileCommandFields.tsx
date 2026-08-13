import type { ReactElement } from 'react'

import type { HarnessProviderDescriptor } from '../../../shared'
import type { HarnessProfileDraft } from './harness-profile-draft'

export function HarnessProfileCommandFields({
  draft,
  provider,
  onArguments,
}: {
  readonly draft: HarnessProfileDraft
  readonly provider?: HarnessProviderDescriptor
  readonly onArguments: (value: string) => void
}): ReactElement {
  return (
    <>
      <label className="settings-profile-argv">
        <span>
          Arguments <small>spaces or newlines separate values</small>
        </span>
        <textarea
          aria-describedby="harness-arguments-help"
          spellCheck={false}
          value={draft.argvText}
          placeholder="--add-dir {binding:monorepo}"
          onChange={(event) => onArguments(event.currentTarget.value)}
        />
        <small id="harness-arguments-help">
          Shell-style quoting only; no expansion or command execution. Parsed as{' '}
          {draft.input.args.length} argv values. The launch preview below is exact.
        </small>
      </label>
      {provider?.profileGuidance.reservedArguments.length ? (
        <p className="settings-profile-note">
          Provider-owned session tokens:{' '}
          {provider.profileGuidance.reservedArguments.join(', ')}. Use Custom if you need
          to own those semantics.
        </p>
      ) : null}
    </>
  )
}
