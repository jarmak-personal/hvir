# ADR-089: Native terminal effect authority

> Lifecycle: Active

## Context

Native parsing, retained state, presentation and product side effects have distinct
lifetimes. A terminal may continue parsing after its PTY exits or its renderer owner
changes. Borrowed parser data, coordinates and historic callbacks cannot authorize a
clipboard write, notification or navigation in a later session.

[ADR-086](ADR-086-native-terminal-state-and-presentation.md) separates these owners;
[ADR-088](ADR-088-native-terminal-input-and-reply-completion.md) defines the sole reply
consumer and finite input prefix. Preview metadata disposal and parser-fatal effect
queue overflow do not provide the required product behavior.

## Decision

Report copied, typed native effects with the causal admitted feed and a native-state
occurrence serial. Callbacks remain synchronous, short and without product authority.
The existing serialized output continuation consumes effects after its definitive native
feed IO fence, alongside the existing sole reply drain. No second parser or effect poller
is introduced. Replies retain terminal-response attribution and the existing transport
ordering; native user/control input remains independently attributed.

A bounded effect transport may coalesce latest title, working-directory and bell state.
Refusal, overflow or malformed text reports an out-of-band gap without disabling terminal
parsing or input. Semantic gaps and screen resets invalidate completeness explicitly.
Semantic marker coordinates are observations from the actual post-mutation native state;
they are not authenticated retained text occurrence identity. Retained extraction and
resolution remain separate native-state operations.

Existing hvir owners decide title, attention, clipboard and navigation behavior. Recheck
the immutable producing instance and current owner generation at execution. Automatic title
is retained presentation metadata: current-instance trailing title updates remain permitted
after physical PTY input closes. Clipboard writes and bell/OSC9 attention additionally
require physically live input authority and are not replayed. Old-owner callbacks cannot
publish to a replacement owner. Copied title, working-directory and gap facts belong to the
same immutable native state and remain retained across presentation-owner transfer; replaced
or removed states cannot update that cache. Retention grants no execution authority, but a
newly authorized owner may explicitly read that latest metadata on reattachment. Expected clipboard or notification delivery failures do not destroy the
parser. Native application callbacks never acquire project, clipboard or OS opener authority.
OSC8 readback copies a URI from an explicitly qualified current snapshot; activation remains
a separate user-intent operation through host-qualified hvir navigation.

Preserve strict, bounded OSC52 writes and refuse every terminal-initiated clipboard read.
Protocol and complete selection metadata remain distinct, so another clipboard protocol
cannot acquire permission merely by sharing an upstream action. These existing OSC52
bounds do not impose a ceiling on ordinary clipboard paste.

BEL and OSC9 retain quiet bell attention. Exposed OSC777 and progress events do not acquire
new product effects. Palette and theme queries use the actual native Terminal and its
response FIFO; answering supported native queries is a deliberate compatibility improvement
over the web adapter's unanswered query events. Configured theme changes retain their
settings owner. There is no TypeScript palette or terminal-mode mirror.

## Consequences

Parser progress survives a refused side effect. Finite payload ownership and explicit gaps
make saturation observable without treating a partial semantic transcript as complete.
Applications may now receive native palette query replies that the previous web adapter
ignored. Product policy, current execution authority and native protocol support remain
separately testable. Terminal-related decisions remain reviewable as the environment changes.

## Rejected alternatives

- Running clipboard, link or application actions inside native callbacks grants ambient
  authority and confuses historic parser activity with current execution permission.
- A second terminal parser, color mirror or effects poller duplicates state or consumption.
- Failing the parser on a bell flood or unavailable system clipboard makes side-effect
  delivery incorrectly govern terminal availability.
- Replaying notifications or trusting coordinates as occurrence identity crosses lifetimes.
