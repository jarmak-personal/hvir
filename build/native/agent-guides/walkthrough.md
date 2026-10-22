# From a clock request to a working package

Start with “Please add a clock to hvir”. The optional skill in `guide skill` points here through the installed reference; it grants no access. With the app closed, read `hvir-agent guide authoring`, inspect `hvir-agent scaffold --help`, scaffold a new local directory, customize its HTML/JS/CSS, and validate it. Open hvir and use Settings → Extensions → Add extension… for the validated directory or ZIP. Add enables the copied revision; open Clock. The complete commands and platform picker choices are in `guide authoring`.

For repeated editing, deliberately choose the development-link/Reload loop in `guide development`. Reading guides and making this clock need no live Agent access. The remaining steps explore optional live commands.

With hvir closed, run `hvir-agent help`, `hvir-agent commands`, `hvir-agent help report`,
and `hvir-agent guide targeting`. These read installed reference only and need no display.

Open a project in hvir. In Settings > Extensions enable Agent access. From its terminal run
`hvir-agent workspaces`, `hvir-agent sessions`, `hvir-agent open --path README.md`, then
`printf '# Agent result\n' | hvir-agent report --title Result --stdin`.
Focus stays in the terminal. Select the report tab to clear its quiet badge, then close it.
Alternatively, keep the returned handle and withdraw your report with
`hvir-agent report --handle HANDLE --close`. Report IDs and desktop selection do not replace
the handle, and withdrawal does not move keyboard focus.
Outside hvir run `hvir-agent instances`, then `hvir-agent workspaces --instance ENDPOINT`
and `hvir-agent sessions --instance ENDPOINT --workspace ID`. Supply `--instance ENDPOINT`
and `--workspace ID` to document opening and report publication. Workspace, view and action
lists do not accept workspace/session flags; `help COMMAND` lists each command's supported
flags. A disconnected registered SSH workspace refuses work without local fallback.

Copy the shipped extension-reference package into the extensions folder, Discover it, Enable
its reviewed revision and turn on its separate agent access control. No connector, Skillager,
visible rail or open Sessions destination is needed. Run `hvir-agent actions`, then
`hvir-agent action --extension INSTALLATION --action describe-session` for the declared reference action.
Use its reported action ID and schema with `hvir-agent run --extension INSTALLATION --action ID
--input null`. Outside hvir also supply the instance, workspace and reported session ID for
this session-qualified action. If an action is unavailable, workspace inspection and reports
remain usable. Use `guide actions` and `guide access` for the independent action permissions.
