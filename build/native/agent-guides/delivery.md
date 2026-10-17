# Explicit managed delivery

Installed extension contract: 1.0. Use `guide bridge` for the envelope and bind every action-owned request with `actionId:invocation.id`. Negotiate the required `delivery.*` capabilities. This is mechanical delivery of an explicit exported tree into one registered SSH workspace; the extension owns producer approval and domain meaning. It is not arbitrary file editing, a sync engine or a background task.

Declare an application access source with `mode:'delivery-source'` and a workspace destination with `mode:'managed-delivery'`. Settings grants the existing local export root and exact registered SSH destination separately. These modes grant no selected-document bodies. Use a current admitted workspace; all paths below are `{hostId,path}` pairs. A successful separately approved local connector execution must produce the export. Keep its native output receipt live through capture. See `guide connectors`.

Human views may perform managed mutations within these grants. Agent actions need current standing/interactive authorization, exact admitted host/workspace and declared effects: Update requires `replace:true`, Remove and cleanup require `delete:true`. Updaters and unapproved callers cannot mutate. Capability declarations or capture receipts do not supply this authority. A nested action gets its own admission and effects check.

### delivery.capture

Input: `{source:'delivery-source',path:{hostId:'local',path:'/granted/exports/one'},nativeReceipt:NATIVE_RECEIPT}`. Returns `{receipt,root,fingerprint,entries,files,bytes}` after independently reading and rechecking the complete tree. The native receipt must belong to this caller/activation/action and a successful local execution; `root` is the exact captured export path. The capture binds bytes and modes, not domain approval. Changed trees, escapes, links, unsupported kinds, special permission bits and capacity overflow refuse.

### delivery.manifest

Input: `{receipt:CAPTURE_RECEIPT,offset:0}`. Returns `{entries,nextOffset}`. Each entry is `{path,type:'file'|'dir',mode,size,sha256?}`; paths are relative within the captured tree and file entries include SHA-256. Follow `nextOffset` to `null` and compare the complete public producer manifest before preview. No body bytes are exposed. Input `{receipt,release:true}` returns `null`, revokes dependent previews, and releases the capture once physical work settles.

### delivery.preview

Input: `{destination:'delivery-target',target:{hostId:SSH_HOST,path:ABSOLUTE_TARGET},kind:'add'|'update'|'remove',capture?,sourceVersion?,record?}`. Add/Update require `capture` and an exact nonempty `sourceVersion` (at most 256 characters). Update/Remove require the opaque current `record` id from a complete `delivery.status` observation. Remove uses that record's source version and needs no capture. Add refuses an occupied target; Update/Remove refuse changed or unowned targets.

Returns `{receipt,operation,kind,sourceVersion,source?,target,previous?,files,bytes,preservation,parents,recordEffect,supportingFiles:true}`. `source`, `target`, `preservation` and each missing supporting parent are host-qualified. `previous` is the current record when replacing/removing. `recordEffect` is `record-exact-delivery` or `remove-completed-authority`. Present this exact plan before applying. A preview expires after one minute and does not reserve permission to overwrite later changes.

### delivery.apply

Input: `{receipt:PREVIEW_RECEIPT}` only. Returns `{outcome:'completed'|'refused'|'conflicted'|'uncertain',operation?,record?,reason?,staging?,preserved?}`. Inspect the outcome even when the bridge envelope is `ok:true`. A record is `{id,operation,installation,workspace,root,target,sourceVersion,identity,fingerprint,files,bytes}`; preserve its opaque identity for later operations instead of reconstructing it from matching bytes.

Core saves intent before remote effects, stages/verifies before publication, uses no-replace rename and preserves old owned directories under `.hvir-delivery-retained`. Supporting parents remain shared user data. Uncertain completion or failed completion persistence blocks dependent writes; restart/reconnect never replays a mutation. A transport deadline likewise leaves completion unconfirmed. Read current status and reconcile exact evidence instead of automatically retrying Apply.

### delivery.status

Input: `{offset:0}` for current records, or `{kind:'operations',offset:0}` for retained/pending operations. Returns `{entries,nextOffset,revision}`. Follow all pages with the same journal revision; restart observation if the revision changes. Operation entries are `{workspace,root,id,installation,phase,sourceVersion,previousOperation?,target,staging,preserved,outcome}`. Records use the shape above. Results belong only to this installation; absence of a record does not prove files are absent.

Here `request` is the correlated bridge helper described in `guide sources`. This example refuses mixed-revision evidence:

```js
async function observeDelivery(request, kind) {
  const entries = []
  let offset = 0, revision
  for (;;) {
    const page = await request('delivery.status', { offset, ...(kind ? { kind } : {}) })
    if (revision !== undefined && revision !== page.revision)
      throw new Error('Delivery changed; observe again')
    revision = page.revision
    entries.push(...page.entries)
    if (page.nextOffset === null) return { entries, revision }
    offset = page.nextOffset
  }
}
```

### delivery.domain

Input `{}` reads `{value,revision}` for this installation (`value:null` when absent). Input `{write:true,expected:REVISION,value:JSON_VALUE,journalRevision?}` writes and returns `null`. Writes require mutation authority and compare the exact current domain revision. Evidence-dependent compaction must also pass `journalRevision` from a complete current core observation; stale evidence refuses. Domain data is at most 4096 encoded bytes/installation and 256 KiB globally. It cannot manufacture or modify core records.

### delivery.reconcile

Input: `{operation:OPERATION_ID,destination:'delivery-target'}`. Inspects only that installation's exact journaled objects with the matching current destination grant/workspace. Returns bounded recovery facts: optional `operation`, `installation`, `phase`, `completion`, `objects`, `resolution`, `outcome`, `reason`, `replayed`, `removed`, `files` and `target`. Object entries carry a host-qualified `path`, `state` and optional `identity`, `fingerprint`, `recordedIdentity`. Treat these as observed evidence, never a new grant; optional fields depend on the recovery outcome. Reconciliation does not rerun the original command or mutation.

### delivery.cleanup

Input: `{operation:OPERATION_ID,destination:'delivery-target'}`. Uses the same recovery reply vocabulary and exact-object checks, additionally requiring admitted delete authority. It removes only proven unchanged owned staging/preservation objects, never shared supporting parents or uncertain replacement objects. Refusal preserves data. Trusted Settings also offers Delivery recovery, including explicitly keeping objects and ending tracking against fresh facts.

Captures last five minutes: at most two, 512 entries, depth 16, 2 MiB/file and 32 MiB/payload. Metadata pages contain at most 16 complete entries and may be smaller to fit the public envelope; no entry is silently truncated. Core keeps at most 64 pending/retained operations, 128 current records, 256 MiB possible retained payload and a 4 MiB journal. At most two physical operations run; mutation is bounded to three minutes and cleanup to 30 seconds. Host native identity support is required. Arbitrary external writers are not atomically excluded; matching bytes alone cannot adopt another directory.

Disable, revision changes and removal preserve delivered files. Keeping saved setup retains installation authority. Explicit forgetting removes completed records/domain data while files remain user data; pending/retained recovery evidence survives. A new same-ID installation cannot inherit forgotten authority. Capacity refusal is actionable, not permission to discard evidence. See `guide development` and `guide bridge`.
