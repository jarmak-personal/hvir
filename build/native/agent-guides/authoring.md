# Make a clock from installed hvir

Installed extension and agent contracts: 1.0. Start with `hvir-agent guide` and `hvir-agent help scaffold`. All local authoring commands work offline with hvir closed, without a display or repository checkout. Missing Skillager, SSH and agent access do not block them.

1. Select a new absolute local directory: `hvir-agent scaffold --output /absolute/clock`. Success returns `authoring.destination` as a host-qualified local path and `enabled: false`. Existing files/directories/links are refused; no package scripts run.
2. `hvir-agent validate --path /absolute/clock` returns `validation.id`, `contract`, `revision`, `kind` and `warnings`. It uses the same package capture and validation as Settings, executes no guest or connector, and accepts directory, root-manifest ZIP or top-level development link.
3. In hvir, Settings > Extensions > Open extensions folder opens the actual instance's folder. Make a top-level symbolic link there to your clock directory using your own tools. Discover extensions, inspect Clock and explicitly Enable. Open Clock through its ordinary viewer control.
4. Edit clock.js, clock.css or index.html with your own tools. Validate again and use Reload in Settings. Remove deletes only the development link; your author directory remains.

The copied starter needs no npm, build, project, session, connector or filesystem grant. It contains its current manifest, ordinary HTML/JS/CSS and a captured public UI kit. Its timer refreshes only with visible context, immediately shows current time on return and disposes on revocation/pagehide. The bridge and hvir own native visibility; document timers are not authority.

An occupied output produces exit64 and an actionable error. Publication is no-replace. A raced or failed write may retain a uniquely named .hvir-authoring-* sibling for inspection; automatic cleanup never deletes an uncertain or substituted entry. Inspect any reported partial before removing it yourself. Interior author-selected parent links are refused. Ordinary macOS /tmp, /var and /etc system aliases are supported; use a real directory for an author-created alias.

Use `hvir-agent guide development` for revisions and user-data separation, `guide manifest` for capabilities, `guide ui` for presentation, `guide surfaces` for other surfaces and `guide skill` for optional setup. Local authoring rejects --instance. The uploaded SSH Rust client supports live workbench commands; it does not scaffold remote packages.
