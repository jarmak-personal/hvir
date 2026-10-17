# Executable observations and finite action examples

Installed extension and agent contracts: 1.0. The installed Reference package's manifest/updater.js/detail.html are maintained executable examples. They use public presentation, context, contribution and action messages, including an optional separately approved native connector. The connector-free clock is exported by scaffold and is the simplest start.

For a terminal observation, declare the pulse item shown in `guide surfaces` and an updater HTML asset with its own script. Negotiate hello then context.read. When context.visible is true, publish a bounded request such as:

```js
window.hvirExtension.send({kind:'request',id:'pulse-1',capability:'contributions.publish',input:{item:'pulse',label:'Now',tooltip:'Current observation',availability:'current',observedAt:Date.now()}})
```

Publish at a bounded cadence while visible; stop on context.visible=false and revoked. Use session: EXACT_LIVE_SESSION_ID for a session item. A visible full terminal rail updates with its popup closed. The updater may only observe/present; do not invoke actions from it. If your source fails, retain last data with accurate stale/disconnected/failed availability rather than claiming a current observation. The public bridge result reports a refused capability explicitly.

A connector-free view action uses {id:'hello',title:'Hello',view:'clock',agents:true,effects:{delete:false,replace:false}} in actions. Subscribe before hello; reply to the exact invocation with action-result as in `guide actions`. To demonstrate optional destructive confirmation, use the Reference package’s preview-replacement action (effects.replace:true); its detail view returns previewOnly:true and changedFiles:0; no real user data need be changed for the example. Standing access executes the non-destructive admitted action without repeated approval; enabling "Also confirm destructive actions" adds a trusted confirmation for the declared replacement action. Never simulate a human answer inside the guest. Turn global or extension agent access off to prove revocation.

Use `hvir-agent help actions`, `help action`, `help run` and `guide access` for exact flags and failures. Only selected action schemas enter agent context. An action timeout, close, changed target or revoked access produces a correlated refusal/cancellation; do not replay uncertain native effects.

Inspect the installed Reference assets directly on macOS at /Applications/hvir.app/Contents/Resources/extension-reference/ or Linux at /opt/hvir/resources/extension-reference/. Copy that directory explicitly into the instance’s extensions folder, Discover and inspect before Enable; it is separate from your scaffolded clock. Maintained guide Markdown lives alongside it under agent-guides/, but `hvir-agent guide TOPIC` is the portable manual path.
