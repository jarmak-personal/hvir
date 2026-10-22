# Named actions and progressive discovery

Installed extension and agent contracts: 1.0. An action declares id, title, view, agents and effects {delete:false,replace:false}; optional description/inputSchema/timeoutMs are bounded. Its view is an ordinary manifest view. It is not a background executor. Use `hvir-agent actions` for metadata, then `hvir-agent action --extension INSTALLATION --action hello` for one untrusted declaration/schema. Use exact installation IDs from live discovery; the package manifest id is not the installation identity.

`hvir-agent run --extension INSTALLATION --action hello --input '{}'` invokes the admitted action without taking focus. In the view, handle {kind:"action",invocation}; reply through bridge.send({kind:"action-result",id:invocation.id,value:{message:"Hello"}}), or {kind:"action-result",id:invocation.id,error:"explanation"}. The invocation exposes id, action, input, context, caller (human/agent/guest) and authorization (interactive/standing/unapproved). These are hvir's facts; an input claiming human approval changes nothing.

Every host request for that invocation carries actionId:invocation.id on its request envelope, not inside input. Include it for connector execution/output, terminal handoff, managed delivery and child actions. A current invocation can continue while hidden; expired/foreign ids refuse. Track delayed work by invocation id: {kind:"action-cancelled",id} cancels only that invocation's timer/work, preserving siblings. Clear all work on revoked/pagehide. Never send a result or change completion status after that invocation ends. The installed maintained Reference package demonstrates this lifecycle.

Global Settings > Extensions > Agent access starts off. The extension must be enabled and have its separate agent-access control on; the action must declare agents:true. Standing "Allow actions within approved access" avoids repeated confirmations for admitted operations. "Also confirm destructive actions" asks for actions declaring delete or replace. Confirmation binds exact input/target/access generation; tighter settings revoke uncommitted work. Declared effects are not native-program confinement.

Declare at most 16 named actions within the complete 32 KiB manifest. Discovery pages list metadata; the focused action command returns the selected declaration and schema. This does not require one primary button per action. Action input/result is at most 8 KiB, concurrency 4/installation and 16 globally. Default lifetime120seconds, optional declared timeoutMs1000–180000. Changing selection cannot retarget an admitted invocation. Hiding does not cancel; closing does. See `guide access`, `guide examples`, `guide connectors`, `guide targeting`.

### actions.invoke

Input: `{action:'hello',input?}` targets only this installation's declared action. Returns that action's bounded value, or a bridge refusal/error if admission or execution fails. The action's inputSchema is its own contract; omit input when the action permits it rather than inventing an empty object. In an action handler, send `{kind:'request',id:'child-1',capability:'actions.invoke',actionId:invocation.id,input:{action:'child',input:{}}}` and correlate the request result separately from the parent's action-result.

Each child checks its own agents flag, input and declared effects against the exact inherited workspace/session and current access lifetime. A non-destructive parent does not authorize a destructive child; configured destructive confirmation applies to the child's exact input/effects. Invalid input or agents:false refuses before a confirmation prompt. A local agent-opened view retains its restricted provenance and global/per-extension access lifetime after its opening command completes and the CLI exits normally; turning that access off revokes the view. Active commands/actions still cancel with their originating request. Local human and agent views/handlers may coexist as separate records without sharing authority. SSH-forwarded callers retain their host/connection restrictions and cannot reuse another origin's view. See `guide bridge` for request deadlines and uncertain effects.

Malformed action JSON, input beyond 8 KiB, and a declared input-schema mismatch return
`ok:false` with exit 64 before destructive confirmation or dispatch. Authority/availability
refusals and explicit action errors return 69; recognized request interruption returns 75.
Error text never determines the classification. An action-result `error` is the existing
channel for a definite refusal. Partial or uncertain domain reports may instead be structured
values that preserve their operation identity and effect information.

Exit 0 with `ok:true` means the invocation returned a value. Core leaves that value opaque:
fields such as `outcome:"refused"` do not change command success or prove domain success.
Consumers interpret the declared domain result; they must not automatically retry an uncertain
operation. Interruption and failure do not promise rollback.

For Skillager, `sync-library` with a local workspace uses its independently approved
`project-cli` and effective project discovery; omit the target only when you intend the
application `library-cli` context. SSH sync is unsupported. Message-only definite refusals use the ordinary
action-error exit; refusals with structured target, reason, tracking or operation facts retain those facts.
Partial or uncertain domain results retain operation and recovery details.
Exact no-effect source counts may accompany detailed consequential rows. `save-and-accept`
and `accept-version` are human-only; reading or program access never grants acceptance.
