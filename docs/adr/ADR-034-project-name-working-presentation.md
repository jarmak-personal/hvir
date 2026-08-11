# ADR-034: Project names present low-salience Working state

## Context

ADR-019 made ongoing output after a submitted turn a provider-independent Working state and
removed it from workspace, project, and OS attention counts. Keeping Working only on a terminal
row avoids notification noise, but it also hides background progress when the user has several
projects open and must choose which project to inspect.

The project bar has limited horizontal space. A persistent icon, text label, or count would make
crowded navigation harder to scan and would resemble the actionable attention and Git telemetry
that hvir keeps distinct. Motion can communicate ongoing work without consuming width, but it
must preserve readable names, actionable-signal priority, and reduced-motion access.

## Decision

Project navigation may aggregate the number of child terminals in the existing Working state as
low-salience presentation data. This count remains separate from actionable attention.

When a project has at least one Working terminal and no actionable Ready or bell signal, its name
shows a left-to-right fade sweep. The name stays in layout and readable throughout the sweep. One
two-second sweep is followed by one second with the complete name steady. The animation changes
no project-tab dimensions, neighboring controls, accessible text, or focus behavior.

Actionable attention takes priority. A project with Ready or bell attention keeps a steady name
and shows the existing `!n` count. Working terminals remain excluded from workspace, project, and
OS attention counts. Project or workspace focus does not clear Working; the terminal-owned policy
continues to decide state transitions and terminal focus remains the clearing rule.

The system reduced-motion preference disables the sweep and uses a static dashed underline on the
project name. The project control's tooltip and accessible label report the number of Working
terminals without changing during animation frames. Active and inactive projects, local and SSH
projects, bundled providers, custom commands, and Bare Shell use the same behavior. Workspace
names do not receive this presentation.

The existing generic submitted-input, output, and idle heuristic remains the only Working source.
The project bar does not inspect terminal contents or provider telemetry and adds no animation
setting, badge, icon, or visible Working count.

This record supersedes only ADR-019's rule that Working remains visible only on its terminal row.
ADR-019's non-actionable classification, signal priority, counts, heuristic, and
provider-independent boundaries remain in force. ADR-009's focus, OS, accessible-presentation,
and signal-separation decisions also remain in force.

## Consequences

Users can identify projects with background terminal progress without opening each project or
giving Working the visual weight of attention. The presentation consumes no additional tab width
and keeps project labels stable for layout, assistive technology, and existing navigation.

Several project names may move at once. The bounded sweep, steady pause, actionable suppression,
and reduced-motion fallback limit that distraction. Working remains intentionally heuristic, so
the project presentation has the same quiet-command and periodic-output limitations as the
terminal row.

The renderer carries one additional count through the existing terminal-to-workspace rollup. It
does not allocate terminal runtime for registered workspaces, add a process boundary, or change
PTY, provider, host, recovery, or persistence ownership.

## Rejected alternatives

- Add a Working icon, badge, word, or visible count to each project tab; these consume scarce tab
  width and make low-salience progress resemble actionable attention.
- Remove letters completely or use rapid flashing; these make project identity harder to scan and
  create unnecessary urgency.
- Animate workspace names or include Working in attention and OS counts; these add noise without
  improving cross-project selection.
- Depend on provider turn telemetry or terminal screen parsing; generic terminal behavior must
  remain consistent across providers, custom commands, Bare Shell, and local or SSH sessions.
