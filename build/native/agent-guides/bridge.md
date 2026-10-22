# Public guest bridge

Installed extension contract: 1.0. Start with `guide authoring` for a clock; this topic is needed when adding host-mediated behavior. `window.hvirExtension` exposes only `send(message)` and `onMessage(callback)`. The latter returns an unsubscribe function. No Node, Electron, private IPC, filesystem, process or direct network API is available to a guest.

Subscribe before sending `{kind:'hello',contract:'1.0'}`. The reply is `{kind:'hello',contract,capabilities,presentation,warnings}`. Declare capabilities in the manifest and check this admitted list before use. Static platform support, this guest's capabilities, native/source grants and agent authorization are separate facts. An updater's admitted list is narrower.

Send `{kind:'request',id:'unique-request',capability:'context.read',input?,actionId?}`. `id` is a nonempty unique string of at most 80 ASCII letters, digits or hyphens. `input` is the capability's documented object, omitted where no input is needed. Replies preserve the request id:

```json
{"kind":"result","id":"unique-request","ok":true,"value":{"surface":"viewer","visible":true},"warnings":[]}
```

A refusal uses `{kind:'result',id,ok:false,error:'explanation',warnings:[]}`. Match by id, inspect `ok`, then interpret the operation-specific `value`; an `ok:true` envelope can contain an unsuccessful native or delivery outcome. Error strings explain the failure and are not stable error codes. Handle unsolicited `presentation`, `context`, `contributions`, `action`, `action-cancelled` and `revoked` messages separately.

For every capability request made on behalf of `{kind:'action',invocation}`, put `actionId: invocation.id` on the request envelope, including nested `actions.invoke`, connector requests, receipt reads and `terminal.start`. It is not an input field. This preserves that exact finite invocation's caller, target, authorization and lifetime, including while hidden. It never broadens admitted authority. An omitted id does not turn an action/agent-origin view into a human view. An unknown, expired or other view's id refuses. See `guide actions`.

Send `{kind:'cancel',id}` to cancel a pending request, remove your own waiter and ignore its late completion. Explicit cancellation and revocation suppress result delivery. A still-current request that reaches its transport deadline instead receives exactly one correlated `ok:false` result explaining that completion is unconfirmed. A deadline does not prove rollback or safe retry. Physical work remains capacity-accounted until it settles; late results are discarded. For uncertain native/delivery effects, inspect the operation's current public evidence before deciding what to do next. Never automatically replay a mutation.

Requests have bounded lifetimes: ordinarily 10 seconds; `source.request` 70 seconds around its 60-second decision; `source.request-trash` 670 seconds around its 60-second decision plus Files’ ten-minute physical bound; connector/delivery requests 190 seconds around their owners' maximum 180 seconds; `actions.invoke` and `terminal.start` 180 seconds. A shorter declared action/connector lifetime or revocation can end work earlier. All requests and other responses are at most 16 KiB; an admitted connector.output page alone may use a 512 KiB complete encoded response. Both preload and main enforce 30 outbound guest messages/second and at most 8 pending requests/view, 16/extension and 64/application. Capacity refusal is explicit. Choose new request ids; timing out does not free physical capacity immediately.

### presentation.read

No input. Returns `{appearance:'light'|'dark',colors,fontFamily,monospaceFontFamily,interfaceScale,width,height}`. `colors` is the closed semantic token map consumed by the shipped `tokens.css`; inspect the scaffold's public assets for token names. `{kind:'presentation',presentation}` replaces this snapshot when appearance, fonts, scale or available geometry changes. Use `guide ui` for the optional binding and disposer.

### context.read

No input. Returns `{surface,visible,workspace?,session?,sessions?,input?}`. Surface is `viewer`, `left`, `top`, `popup` or `updater`. Workspace is `{id,name,host,root?}`; `root` is `{hostId,path}` metadata. Session is `{id,title,workspace}` with an exact live spawn identity. Independent application views receive no ambient workspace/session. `input` is bounded data supplied when opening that contribution. Context changes arrive as `{kind:'context',context}` and replace the snapshot. Sessions are limited to 128; the complete context is at most 7 KiB, so optional root metadata can be absent. Absence means unknown. IDs and paths confer no access.

Use `context.visible` for ordinary refresh demand. Unsubscribe and clear timers on `revoked` or `pagehide`; cancel only the named invocation on `action-cancelled`. The maintained Reference demonstrates independent action timers. See `guide lifetimes`, `guide surfaces`, `guide connectors`, `guide sources` and `guide delivery` for focused operations.

The scaffold also ships `guest-client.mjs` and `connector-output.mjs` as plain browser modules. Create one `guestClient(window.hvirExtension)` per guest, subscribe with `client.listen`, then call `client.hello()`. Use `client.request(capability,input,signal?)`; it resolves the operation value or rejects the bridge refusal. Dispose on pagehide. The shared client counts hello, requests, cancellation, releases and action results in one 24-message rolling second, with a 50 ms replenishment margin for IPC-clock headroom. Queued/outstanding requests plus pending cancellation notifications share eight slots; exceeding capacity rejects locally. Competing output reads and controls receive fair service. Creating multiple clients does not create additional platform capacity.

For an actual `action` message, use `client.forAction(message.invocation)` and its request/reply/dispose methods. It preserves that invocation while hidden and aborts its signal when cancelled. Ordinary reads stop on hidden context. A physically submitted Connect or human actions.invoke request can finish through its own focus transition; queued work cannot acquire that exception. Repeated action replies reuse one bounded obligation. A physically sent reply ends that action client and aborts its signal; explicit scoped disposal remains safe afterward. Read `guide connectors` for complete output and explicit release. Raw send remains supported and retains every byte/rate/lifetime rule; bypassing the helper requires your own bounded scheduling.
