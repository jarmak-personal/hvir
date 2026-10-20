# Native connector trust

Installed extension contract: 1.0. Guests have no direct network, filesystem or process API. Native connectors are separately configured external programs, executed through ProjectHost by hvir under the selected host account. Add this ordinary manifest declaration to connectors and declare the connector capabilities you need:

```json
{"id":"tool","description":"Inspect an explicitly approved installed tool","context":"application","timeoutMs":120000,"outputBytes":4194304,"environment":["TOOL_HOME"]}
```

context is application or workspace; timeoutMs is 1–180000 milliseconds, outputBytes is 1–4194304 bytes, and environment lists permitted override names. Settings selects the executable host/canonical path, fixed arguments and explicitly declared environment overrides. Approval binds the exact declaration/configuration, host and canonical executable. Declaring it does not approve it. Application context runs on the application-local scratch directory and does not accept workspace targeting. Workspace context requires an admitted workspace ID on the approved host. Each workspace connector can retain independent local and SSH approvals; saving or revoking one host leaves the others intact. Settings selects one saved host to edit or revoke.

SSH finite execution uses a non-login host environment. When a tool starts child executables, declare PATH in its connector's `environment` and approve a full literal value for that host, for example `configuration: {"env":{"PATH":"/home/alex/.local/bin:/usr/local/bin:/usr/bin:/bin"}}` (with your actual paths). `$PATH`, `~` and shell expressions are not expanded. Do not copy the local machine's environment or assume shell startup files ran. Passive installed-program discovery is local-only; select/configure SSH executables explicitly.

For grouped setup, select the enabled extension in Settings → Extensions → Setup… → Get setup template. Fill only desired declared rows with configured host IDs, exact paths and literal configuration; omit rows to leave their access unchanged. Review setup… displays checked program/file identities, then Apply selected setup commits chosen rows independently. An interrupted batch may have saved earlier rows; inspect outcomes before a fresh review. Individual program/source review and approval remain available. Save app settings saves preferences and does not approve unfinished permission drafts. Setup cannot register a workspace or grant itself app-wide Agent access.

### connector.connect

Add optional `setup:{executable:'tool-name'}` to the declaration to support bounded local installed-program discovery (a simple basename; at most four hints/package). Input `{connector:'tool'}` from a visible ordinary human view proposes the existing trusted Connect decision. No host, executable or workspace override is accepted. Application context uses the local host; a workspace connector uses only that view's exact admitted registered local project. SSH, agent, action-origin, admitted-action and updater requests cannot prompt through this capability. Settings remains the explicit path for SSH/custom configuration.

Returns `{connections:[{connector,outcome,explanation?}]}`, with outcome `connected`, `declined`, `unavailable` or `interrupted-uncertain`. Empty connections can mean no selected eligible setup proposal. Inspect every entry and refresh connector.status; an interrupted save may already have committed. Valid unchanged approval for that exact connector/host needs no repeated decision. Program discovery inspects metadata without executing the program; missing or ambiguous programs can use native file selection after explicit Connect. Hiding, closing, backgrounding, changed context, cancellation or revocation retires setup. Native approval alone grants no source, delivery or agent access.

An ordinary human may request `{connector:'tool',source:'project-files'}` to include one declared read-only workspace source in the same trusted decision. Main pins its exact registered local workspace; a trusted application-view destination remains independent of ambient project navigation. Only missing scopes are displayed, and grants remain independently stored and revocable. Results additionally contain `source:{source,outcome}` (granted/declined/unavailable/interrupted-uncertain) and `readiness:{program,source}`. Outcomes retain completed-save truth; require both readiness flags before claiming current connected reading. Never follow decline/cancellation with an automatic source.request fallback. Later explicit reading of an as-yet-unknown application-library root remains its own contextual decision.

### connector.status

Optional input `{workspace:context.workspace.id}`. Returns one row per declaration (at most eight) as `{connector,availability,host?,explanation?}`; availability is `supported`, `unavailable` or `disconnected`. Application rows always describe local access. Workspace rows describe only the exact caller-admitted workspace host; omitted or foreign workspace context makes them unavailable. Updaters require current trusted visible demand for that workspace. No host override or enumeration of saved bindings is accepted. It omits executable paths and is not an execution-receipt query. No executable probes or SSH authentication prompts run from status.

### connector.execute

After hello confirms admitted connector.status/execute/output capabilities, send these public requests (substitute IDs only from your own declaration and admitted context):

```js
window.hvirExtension.send({kind:'request',id:'tool-status',capability:'connector.status'})
window.hvirExtension.send({kind:'request',id:'tool-run',capability:'connector.execute',input:{connector:'tool',host:'local',args:['--version']}})
```

Match each result by id. Input is `{connector,host,args,workspace?}`. There is no public stdin field. Fixed configured arguments precede these structured args. Its result contains outcome, host, code, signal, truncated, stdoutBytes, stderrBytes, optional reason and optional receipt. outcome is completed, not-started or interrupted-uncertain. code/signal can be null; code alone does not establish domain success. Unapproved execution returns not-started/reason unapproved; disconnected, unavailable, capacity, frequency, context-ended, interrupted, deadline, output-limit and transport describe other bounded failures. A bridge refusal is ok:false/error rather than a successful result. Action-owned requests must add actionId:invocation.id to the outer envelope, including all subsequent receipt reads. Ordinary observations instead require current visible refresh demand.

Only not-started/frequency includes integer retryAfterMs from 1 through 1000: the remaining one-second start-to-start interval for the identical source. This bounded hint is advisory, including after clock changes, and reserves no admission or authority. An observation helper may wait once while visible and current, then request fresh admission. A missing/malformed hint, another refusal or lifetime withdrawal ends that attempt. Mutations, interrupted execution and reconnect must not borrow this retry.

### connector.output

For a returned receipt, send {kind:'request',id:'tool-output',capability:'connector.output',input:{receipt:RECEIPT,stream:'stdout',offset:0}}. The result is {data,nextOffset,result}; nextOffset is the next byte offset or null. Read stderr independently; pages target at most 128 KiB raw UTF-8 and shrink as needed so the complete encoded reply fits 512 KiB. UTF-8 boundaries are preserved. Then send {kind:'request',id:'tool-release',capability:'connector.output',input:{receipt:RECEIPT,release:true}}; the result is null. Receipts are caller/activation/action-bound and finite; changed/stale receipts refuse instead of becoming authority.

Output receipts expire after 30 seconds; reading never extends expiry. Every successful nonempty page, including repeated or overlapping offsets, consumes a delivered-byte allowance equal to the receipt's combined retained stdout+stderr bytes. A page exceeding the remainder refuses in full. Retain already-read data rather than rereading it. Empty EOF replies still count toward both 30-message guards. Read/release promptly. There are at most 16 receipts and 32 MiB retained output globally. Execute permits at most 4 concurrent operations/extension and 16 globally, with a one-second observation refresh interval. Structured args are at most 128 strings and 8 KiB encoded; configuration is at most 8 KiB. A disconnected or interrupted execution may have effects; never replay it automatically. See `guide bridge` for transport deadlines.

The scaffold's browser helper supplies ordinary complete reads without copying a rate limiter:

```js
import { guestClient } from './guest-client.mjs'
import { readConnectorOutput } from './connector-output.mjs'
const client = guestClient(window.hvirExtension)
// Subscribe before hello; call observe only after admitted capabilities and visible context.
client.hello()
window.addEventListener('pagehide', () => client.dispose(), { once: true })
async function observe() {
  const result = await client.request('connector.execute', {
    connector: 'tool', host: 'local', args: ['--version'],
  })
  try {
    if (!result.receipt) throw new Error(`Native operation ${result.outcome}`)
    const stdout = await readConnectorOutput(client, result, { maxBytes: 1024 * 1024 })
    const stderr = await readConnectorOutput(client, result, { stream: 'stderr', maxBytes: 1024 * 1024 })
    // Interpret outcome, code, signal, truncated and the tool's own schema here.
    return { result, stdout, stderr }
  } finally {
    if (result.receipt) await client.request('connector.output', {
      receipt: result.receipt, release: true,
    }).catch(() => {})
  }
}
```

`readConnectorOutput(client,result,{stream,maxBytes,signal})` validates matching result/receipt metadata, exact advancing UTF-8 byte offsets, complete EOF and the chosen byte bound (default 4 MiB). It returns one complete stream, never retries execution and never decides tool success. Read stdout and stderr once; main-owned delivery.capture still needs the unreleased native receipt, so capture inside the caller's try block before finally releases it. For finite action work pass the actual action client. All drains share that guest's existing scheduler; four maximum receipts fit the bounded transfer design without separate reader queues. A stalled machine can still exceed the fixed lifetime; report refusal rather than replaying the command.

### terminal.start

Input: `{connector:'workspace-tool',workspace:EXACT_LOCAL_WORKSPACE,args:['setup']}` with `actionId:invocation.id` on the outer request. Requires a current finite action, that exact admitted local workspace, and an approved workspace connector on the local host. There is no ambient/current-terminal target, shell command string, stdin or SSH handoff. At most one terminal request is admitted per invocation; invoke a new action after a refusal rather than retrying within the same one.

Returns `{outcome:'handed-off',terminalId}` or `{outcome:'not-started'|'interrupted-uncertain',reason}`. Native execution may already have begun for an uncertain result. Human/guest actions receive a trusted command/destination confirmation; agent actions use their existing standing/interactive authorization and host restrictions. After approval the one-use fresh-terminal admission expires in ten seconds, within the finite action's lifetime. The command runs once in a new ordinary terminal, then opens the default login shell even after command failure. Handoff is not domain setup success: observe public program metadata separately. Disable leaves a handed-off user terminal usable; recovery restores a plain shell and never replays the command/configuration.

The configured program may perform any effects available to that host account. Names such as “read-only”, configured argv prefixes, declared delete/replace effects and optional action confirmation do not constrain that account authority or prove read-only confinement. Unchanged grants can be reused when an explicit revision is accepted; changed trust requires a new decision. A visible updater may refresh an approved observation within its narrower capability/demand limits; it cannot borrow action authority from stale data or replay uncertain effects after reconnect.

hvir authorization is independent of Claude/Codex permission modes. Ordinary harness approval for hvir-agent does not replace hvir admission, and a harness sandbox does not constrain work hvir performs under its admitted native authority. Read `guide actions`, `guide access` and `guide ssh`; begin with the connector-free clock.
