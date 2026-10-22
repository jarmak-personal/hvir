# Selected current documents and read access

Installed extension contract: 1.0. Negotiate the needed `source.*` capabilities and use the envelope in `guide bridge`. Declare `access:[{id:'source',description:'Read selected instructions',context:'application',mode:'read-only'}]`. Application roots are explicit local folders; workspace declarations instead bind one exact registered workspace and host. Trusted Settings grants and revokes these scopes separately from native connector approval. Declaring a source grants nothing.

Except for status, these operations require a current visible ordinary human-selected view with the matching grant. Agent-origin, action-origin, restricted and updater views cannot read selected instruction bodies or request read access, even if they omit `actionId`. A local human view can coexist with a separate agent view of the same contribution; each retains its own authority. Context/root metadata does not supply a grant. Hiding, selection replacement, source revocation, Disable or revision changes end dependent receipts and prevent late publication.

### source.status

No input. Returns an array of `{source,granted,workspaceId?,explanation?}` for declared sources. The guest response deliberately omits roots. Status is metadata, not file validity or permission to discover arbitrary paths.

### source.request

Input: `{source:'source',root:{hostId:'local',path:'/reported/library'}}`. Application requests select the reported local root. For a declared workspace read-only source, send only `{source:'source'}`; main uses the exact admitted workspace and rejects guest roots/workspace IDs. A trusted hvir surface checks canonical scope and asks the human for read-only access; the guest cannot approve it. Returns `{granted:true}` or `{granted:false}`. A current grant already covering that reported root is reused without a new decision; this does not attest the folder's present contents. Preparation failure stays in trusted UI until a decision, cancellation or deadline. Delivery grants retain their separate Settings surface. Hiding, closing or revocation retires this request; there are at most four decisions and each lasts 60 seconds. An interrupted persistence operation may already have committed.

### source.select

Input: `{source:'source',path:{hostId:'local',path:'/library/skill/SKILL.md'},workspaceId?}`. Supply an explicit path inside the granted root; workspace sources require that exact current workspace, and a supplied workspaceId must match. Returns `{receipt,path,bytes,sha256,readAt,currentFile:true}` after complete canonical confinement and UTF-8 reading. `path` is canonical and host-qualified; the digest describes this current file, not an accepted package/tree. A new selection revokes the view's prior document and child receipts. Missing grants, stale workspaces, escapes, disconnected hosts and invalid/oversized UTF-8 content refuse.

### source.read

Input: `{receipt,offset:0}`. Returns `{data,nextOffset,encoding:'utf8'|'base64'}`. Follow the returned byte offset until `nextOffset:null`; only then is the body complete. For base64 assets, concatenate every page before decoding. Input `{receipt,release:true}` returns `null` and releases that receipt; releasing the selected parent also revokes its rendered/image children. Receipts are caller/activation-bound and expire absolutely after five minutes. They are not paths or reusable permission tokens.

Here `request(capability,input)` is your correlated bridge helper: it resolves `value` on `ok:true` and rejects on `ok:false`, cancellation or disposal. This complete source-reading example always releases its selection:

```js
async function readCurrentDocument(request, path) {
  const selected = await request('source.select', { source: 'source', path })
  try {
    let text = '', offset = 0
    for (;;) {
      const page = await request('source.read', { receipt: selected.receipt, offset })
      if (page.encoding !== 'utf8') throw new Error('Expected UTF-8 source')
      text += page.data
      if (page.nextOffset === null) return { text, selected }
      offset = page.nextOffset
    }
  } finally {
    await request('source.read', { receipt: selected.receipt, release: true }).catch(() => {})
  }
}
```

### source.asset

Input: `{receipt:SELECTED_DOCUMENT,path:'images/example.png'}`. Returns `{receipt:IMAGE_RECEIPT,mime,bytes}`. Read IMAGE_RECEIPT through `source.read` as base64 pages and release it afterward. Relative images must remain canonically inside both the document directory and grant; absolute paths, network URLs, unsupported kinds and symlink escapes refuse. Keep the parent document receipt live while using its assets.

### source.render

Input: `{receipt:SELECTED_DOCUMENT}`. Returns `{receipt:RENDERED_RECEIPT,bytes,sourceFallback:false}` for safe HTML, read with `source.read` as UTF-8 pages. Or returns `{receipt:null,sourceFallback:true}` when rendered output exceeds its bound: display the complete original Source text instead. A bridge error is not this explicit fallback. Rendering uses hvir's Markdown policy off-thread with one physical parse and no guest network/worker access; raw source HTML is not trusted HTML. Keep the parent live while reading rendered content and relative assets.

### source.reveal

Input: `{source:'workspace-source',workspaceId:EXACT_WORKSPACE,path:{hostId:HOST,path:ABSOLUTE_DIRECTORY}}`. Requires a declared/granted workspace read-only source and that exact current workspace. Returns `null` after selecting the ordinary canonical directory in Files. Application sources, stale context, non-directories, lexical/canonical escapes and nonhuman origins refuse. This grants no mutation or outside-root access.

Documents and images are each at most 2 MiB; text/base64 pages are at most 2048 bytes. Rendered HTML is bounded to 512 KiB. There are eight physical/retained source reservations and 16 MiB of reserved data globally. Timeout/closure can settle the guest while a non-abortable read or parse still occupies capacity. Do not report an interrupted page sequence complete or retry mutations based on a timeout. See `guide bridge` and `guide lifetimes`.

### source.request-trash

Requests the existing trusted Files **Move to Trash** confirmation for
one selected ordinary project directory. Send `{source: 'project', workspaceId: EXACT_WORKSPACE,
path: {hostId: 'local', path: EXACT_DIRECTORY}}` from a visible ordinary human view with that
workspace's existing read-only source grant. The grant stays read-only: only the human's trusted
Files confirmation authorizes removal. No action, agent or updater can request it. Workspace
roots, symbolic-link traversal, changed directory identity, stale grants and contexts refuse.
Application sources and hosts without recoverable Trash (including current SSH hosts) refuse;
there is no permanent-delete fallback. The dialog checks unsaved buffers in its exact target
workspace even when the active Files pane shows another project.

The promise remains pending through review and physical completion. Its bounded result is
`{outcome: 'completed'|'cancelled'|'refused'|'uncertain', reason?}`. Only `completed` confirms Trash;
refresh observations afterward. Never retry an uncertain result automatically. There is one
pending request application-wide, sixty seconds for preparation/review and the existing ten-minute
Files operation bound after confirmation. Revocation cancels pending review; in-flight physical
work retains capacity until settlement and cannot imply rollback. `source.reveal` remains useful
for inspecting the folder without requesting any mutation.
