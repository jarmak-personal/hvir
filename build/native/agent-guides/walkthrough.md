# Installed command walkthrough

With hvir closed, run `hvir-agent help`, `hvir-agent commands`, `hvir-agent help report`,
and `hvir-agent guide targeting`. These read installed reference only and need no display.

Open a project in hvir. In Settings > Extensions enable Agent access. From its terminal run
`hvir-agent workspaces`, `hvir-agent sessions`, `hvir-agent open --path README.md`, then
`printf '# Agent result\n' | hvir-agent report --title Result --stdin`.
Focus stays in the terminal. Select the report tab to clear its quiet badge, then close it.
Outside hvir run `hvir-agent instances`; use `--instance ENDPOINT` and `--workspace ID` for
the same operations. A disconnected registered SSH workspace refuses work without local fallback.

Copy the shipped extension-reference package into the extensions folder, Discover it, Enable
its reviewed revision and turn on its separate agent access control. No connector, Skillager,
visible rail or open Sessions destination is needed. Run `hvir-agent actions`, then
`hvir-agent action --extension INSTALLATION --action describe-session` for the declared reference action.
Use its reported action ID and schema with `hvir-agent run --extension INSTALLATION --action ID
--input null`. If an action is unavailable, workspace inspection and reports
remain usable. Detailed extension authoring/starter topics are supplied by the authoring capability.
