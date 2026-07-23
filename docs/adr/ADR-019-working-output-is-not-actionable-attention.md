# ADR-019: Working output is not actionable attention

## Context

ADR-009 established provider-independent terminal attention from generic input, output, idle,
and bell events. It treated output after a submitted turn as unseen new output and included every
unseen terminal in workspace and project rollups, while limiting the OS badge to idle and bell.

Agent harnesses can stream output for most of a turn. Marking that expected progress as new
attention makes parent counts persist while no terminal needs a response and obscures the
idle-after-submission Ready signal that tells the user a turn may need review.

## Decision

Ongoing output after a submitted terminal-input boundary is a low-salience Working state, not
actionable attention. The terminal row displays Working while the submitted turn is producing
output. When output remains quiet for the configured idle threshold, Ready replaces Working.
Signal priority remains Ready, then explicit bell, then Working, so later output cannot weaken an
unseen actionable signal.

Workspace, project, and OS attention counts include only distinct terminals with unseen Ready or
bell signals. Working remains visible only on its terminal row and does not contribute to a
parent count.

Terminal focus remains the only clearing rule. Focusing a workspace or project does not clear a
child terminal, and startup, recovery, repaint, or control output still cannot manufacture a
submitted turn. The policy continues to use generic terminal input, output, idle timing, and bell
events. It does not inspect screen contents or depend on provider telemetry, so bundled providers,
custom commands, Bare Shell, and local or SSH sessions share the same behavior.

This record supersedes only ADR-009's classification of ongoing post-submission output as new
attention and its inclusion in workspace and project rollups. ADR-009's submission boundary,
focus clearing, signal ordering, OS focus behavior, and accessible presentation rules remain in
force.

## Consequences

Users can see that a background terminal is active without accumulating project-level
notification noise. Parent and OS counts now share one actionable definition, while Ready
remains the strongest visible result of a completed output burst.

Working is intentionally heuristic: a submitted command that emits periodic output continues to
look active, and a quiet command becomes Ready after the configured threshold. Provider-specific
turn knowledge could be more precise for one harness but would make generic attention behavior
inconsistent or require screen parsing.

## Rejected alternatives

- Continue counting Working terminals in workspace and project rollups; this preserves the noise
  that hides actionable Ready and bell signals.
- Hide ongoing output entirely; that removes useful low-salience evidence that a background
  terminal is making progress.
- Use provider turn telemetry or parse terminal screen contents; provider support is optional,
  and screen interpretation would leak harness behavior past its adapter.
- Clear child state when a workspace or project is focused; terminal focus remains the one
  visible clearing rule.
