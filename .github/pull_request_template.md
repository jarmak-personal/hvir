## Governing issue

Closes #

<!--
For an ordinary PR to main, keep one native `Closes #N` relationship above.

For an epic-child PR, replace the `Closes` line with one exact whole-line trailer outside this
comment. Automation derives the direct epic parent. Example spelling:

Completes-child: #123

Use `Contributes-to: #N` only for partial work that does not complete an issue.
-->

## Outcome

Describe the user or contributor outcome and why it belongs in hvir.

## Design and architecture

Name the owning capability, affected seams, dependency direction, reuse decisions, and any ADR
added or superseded. Explain why the change does not widen a product non-goal.

## Risks and failure modes

Cover security, cleanup/lifecycle, responsiveness, and local/SSH behavior where relevant.

## Verification

Confirm that `npm run verify` and the repository pre-push hook passed after the final changes.
List any additional commands and manual evidence exercised. Call out required environments that
were not available.

## User-visible evidence

Add screenshots or other observable evidence when behavior or presentation changes.
