# Captured public UI kit

Installed extension contract: 1.0. Scaffold copies presentation.css, tokens.css, primitives.css and guest-ui.js from the maintained public presentation owner. No remote CSS, fonts, package manager or build is required. These are inspectable package bytes. Do not import private React components, renderer/preload/main modules, internal selectors or implementation types.

Include <link rel="stylesheet" href="presentation.css"> and <script src="guest-ui.js"></script>. `window.hvirUI.bindPresentation(window.hvirExtension)` returns an idempotent disposer. It binds public theme/colors/font/scale values from hello and presentation messages. Register your bridge callback before sending {kind:"hello",contract:"1.0"}; revoke your own generation before disposing handlers and subscriptions. The clock shows this composition directly.

Use native buttons and labeled fields with public primitive classes. The shared kit includes panels, toolbars, controls, rows, metadata, state, focus and scroll styles. `hvirUI.bindList(element,onSelect)` handles option selection, click, ArrowUp/Down/Home/End, and exposes refresh/dispose; use role=listbox and role=option. Build a flex list/detail layout with ordinary DOM and public styles; avoid a private workbench dependency. Inspect primitives.css for exact class names. Hosts supply semantic token values; copied primitive rules belong to the captured revision.

The kit only controls the guest's DOM and styling. It cannot approve access, execute native commands, acquire files or create trusted dialogs. Custom presentation may use the same bridge without this kit. See `guide manifest` and `guide lifetimes`.
