# Native connector trust

Installed extension contract: 1.0. Guests have no direct network, filesystem or process API. Native connectors are separately configured external programs, executed through ProjectHost by hvir under the selected host account. Add this ordinary manifest declaration to connectors and declare the three connector capabilities you need:

```json
{"id":"tool","description":"Inspect an explicitly approved installed tool","context":"application","timeoutMs":120000,"outputBytes":4194304,"environment":["TOOL_HOME"]}
```

context is application or workspace; timeoutMs is 1–180000 milliseconds, outputBytes is 1–4194304 bytes, and environment lists permitted override names. Settings selects the executable host/canonical path, fixed arguments and explicitly declared environment overrides. Approval binds the exact declaration/configuration, host and canonical executable. Declaring it does not approve it. Application context runs on the application-local scratch directory and does not accept workspace targeting. Workspace context requires an admitted workspace ID on the approved host.

After hello confirms admitted connector.status/execute/output capabilities, send these public requests (substitute IDs only from your own declaration and admitted context):

```js
window.hvirExtension.send({kind:'request',id:'tool-status',capability:'connector.status'})
window.hvirExtension.send({kind:'request',id:'tool-run',capability:'connector.execute',input:{connector:'tool',host:'local',args:['--version']}})
```

Match each result by id. connector.status returns an array of {connector,availability,host?,explanation?}; availability is supported, unavailable or disconnected for configured/approved connectors. It is not an execution-receipt query. connector.execute accepts connector, host, args and optional workspace. There is no public stdin field. Fixed configured arguments precede these structured args. Its result contains outcome, host, code, signal, truncated, stdoutBytes, stderrBytes, optional reason and optional receipt. outcome is completed, not-started or interrupted-uncertain. code alone does not establish domain success. Unapproved execution returns not-started/reason unapproved; disconnected, unavailable, capacity, frequency, context-ended, deadline, output-limit and transport describe other bounded failures. A bridge refusal is ok:false/error rather than a successful result.

For a returned receipt, send {kind:'request',id:'tool-output',capability:'connector.output',input:{receipt:RECEIPT,stream:'stdout',offset:0}}. The result is {data,nextOffset,result}; nextOffset is the next byte offset or null. Read stderr independently; pages are at most8KiB and UTF-8 boundaries are preserved. Then send {kind:'request',id:'tool-release',capability:'connector.output',input:{receipt:RECEIPT,release:true}}; the result is null. Receipts are caller/activation/action-bound and finite; changed/stale receipts refuse instead of becoming authority.

The configured program may perform any effects available to that host account. Declared delete/replace effects and optional action confirmation do not prove native confinement. Unchanged grants can be reused when an explicit revision is accepted; changed trust requires a new decision. A visible updater may refresh an approved observation within its narrower capability/demand limits; it cannot borrow action authority from stale data or replay uncertain effects after reconnect.

hvir authorization is independent of Claude/Codex permission modes. Ordinary harness approval for hvir-agent does not replace hvir admission, and a harness sandbox does not constrain work hvir performs under its admitted native authority. Read `guide actions`, `guide access` and `guide ssh`; begin with the connector-free clock.
