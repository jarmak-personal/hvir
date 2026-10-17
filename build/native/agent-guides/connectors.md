# Native connector trust

Installed extension contract: 1.0. Guests have no direct network, filesystem or process API. Native connectors are separately configured external programs, executed through ProjectHost by hvir under the selected host account. Add this ordinary manifest declaration to connectors and declare the connector capabilities you need:

```json
{"id":"tool","description":"Inspect an explicitly approved installed tool","context":"application","timeoutMs":120000,"outputBytes":4194304,"environment":["TOOL_HOME"]}
```

context is application or workspace; timeoutMs is 1–180000 milliseconds, outputBytes is 1–4194304 bytes, and environment lists permitted override names. Settings selects the executable host/canonical path, fixed arguments and explicitly declared environment overrides. Approval binds the exact declaration/configuration, host and canonical executable. Declaring it does not approve it. Application context runs on the application-local scratch directory and does not accept workspace targeting. Workspace context requires an admitted workspace ID on the approved host.

### connector.connect

Add optional `setup:{executable:'tool-name'}` to the declaration to support bounded local installed-program discovery (a simple basename; at most four hints/package). Input `{connector:'tool'}` from a visible ordinary human view proposes the existing trusted Connect decision. No host, executable or workspace override is accepted. Application context uses the local host; a workspace connector uses only that view's exact admitted registered local project. SSH, agent, action-origin, admitted-action and updater requests cannot prompt through this capability. Settings remains the explicit path for SSH/custom configuration.

Returns `{connections:[{connector,outcome,explanation?}]}`, with outcome `connected`, `declined`, `unavailable` or `interrupted-uncertain`. Empty connections can mean no selected eligible setup proposal. Inspect every entry and refresh connector.status; an interrupted save may already have committed. Valid unchanged approval for that exact connector/host needs no repeated decision. Program discovery inspects metadata without executing the program; missing or ambiguous programs can use native file selection after explicit Connect. Hiding, closing, backgrounding, changed context, cancellation or revocation retires setup. This grants no source, delivery or agent access.

### connector.status

No input. Returns an array of `{connector,availability,host?,explanation?}`; availability is `supported`, `unavailable` or `disconnected` for configured/approved connectors. It omits executable paths and is not an execution-receipt query. No executable probes or SSH authentication prompts run from status.

### connector.execute

After hello confirms admitted connector.status/execute/output capabilities, send these public requests (substitute IDs only from your own declaration and admitted context):

```js
window.hvirExtension.send({kind:'request',id:'tool-status',capability:'connector.status'})
window.hvirExtension.send({kind:'request',id:'tool-run',capability:'connector.execute',input:{connector:'tool',host:'local',args:['--version']}})
```

Match each result by id. Input is `{connector,host,args,workspace?}`. There is no public stdin field. Fixed configured arguments precede these structured args. Its result contains outcome, host, code, signal, truncated, stdoutBytes, stderrBytes, optional reason and optional receipt. outcome is completed, not-started or interrupted-uncertain. code/signal can be null; code alone does not establish domain success. Unapproved execution returns not-started/reason unapproved; disconnected, unavailable, capacity, frequency, context-ended, interrupted, deadline, output-limit and transport describe other bounded failures. A bridge refusal is ok:false/error rather than a successful result. Action-owned requests must add actionId:invocation.id to the outer envelope, including all subsequent receipt reads. Ordinary observations instead require current visible refresh demand.

### connector.output

For a returned receipt, send {kind:'request',id:'tool-output',capability:'connector.output',input:{receipt:RECEIPT,stream:'stdout',offset:0}}. The result is {data,nextOffset,result}; nextOffset is the next byte offset or null. Read stderr independently; pages are at most8KiB and UTF-8 boundaries are preserved. Then send {kind:'request',id:'tool-release',capability:'connector.output',input:{receipt:RECEIPT,release:true}}; the result is null. Receipts are caller/activation/action-bound and finite; changed/stale receipts refuse instead of becoming authority.

Output receipts expire after 30 seconds; read/release promptly. There are at most 16 receipts and 32 MiB retained output globally. Execute permits at most 4 concurrent operations/extension and 16 globally, with a one-second observation refresh interval. Structured args are at most 128 strings and 8 KiB encoded; configuration is at most 8 KiB. A disconnected or interrupted execution may have effects; never replay it automatically. See `guide bridge` for transport deadlines.

### terminal.start

Input: `{connector:'workspace-tool',workspace:EXACT_LOCAL_WORKSPACE,args:['setup']}` with `actionId:invocation.id` on the outer request. Requires a current finite action, that exact admitted local workspace, and an approved workspace connector on the local host. There is no ambient/current-terminal target, shell command string, stdin or SSH handoff. At most one terminal request is admitted per invocation; invoke a new action after a refusal rather than retrying within the same one.

Returns `{outcome:'handed-off',terminalId}` or `{outcome:'not-started'|'interrupted-uncertain',reason}`. Native execution may already have begun for an uncertain result. Human/guest actions receive a trusted command/destination confirmation; agent actions use their existing standing/interactive authorization and host restrictions. After approval the one-use fresh-terminal admission expires in ten seconds, within the finite action's lifetime. The command runs once in a new ordinary terminal, then opens the default login shell even after command failure. Handoff is not domain setup success: observe public program metadata separately. Disable leaves a handed-off user terminal usable; recovery restores a plain shell and never replays the command/configuration.

The configured program may perform any effects available to that host account. Declared delete/replace effects and optional action confirmation do not prove native confinement. Unchanged grants can be reused when an explicit revision is accepted; changed trust requires a new decision. A visible updater may refresh an approved observation within its narrower capability/demand limits; it cannot borrow action authority from stale data or replay uncertain effects after reconnect.

hvir authorization is independent of Claude/Codex permission modes. Ordinary harness approval for hvir-agent does not replace hvir admission, and a harness sandbox does not constrain work hvir performs under its admitted native authority. Read `guide actions`, `guide access` and `guide ssh`; begin with the connector-free clock.
