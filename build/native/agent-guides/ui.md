# Captured public UI kit

Installed extension contract: 1.0. Scaffold copies presentation.css, tokens.css, primitives.css and guest-ui.js from the maintained public presentation owner. No remote CSS, fonts, package manager or build is required. These are inspectable package bytes. Do not import private React components, renderer/preload/main modules, internal selectors or implementation types.

Include <link rel="stylesheet" href="presentation.css"> and <script src="guest-ui.js"></script>. `window.hvirUI.bindPresentation(window.hvirExtension)` returns an idempotent disposer. It binds public theme/colors/font/scale values from hello and presentation messages. Register your bridge callback before sending {kind:"hello",contract:"1.0"}; revoke your own generation before disposing handlers and subscriptions. The clock shows this composition directly. Its module script uses guest-client.mjs; the presentation helper and transport share the same public bridge.

Use native buttons and labeled fields with public primitive classes. The shared kit includes panels, toolbars, controls, rows, metadata, state, focus and scroll styles. `hvirUI.bindList(element,onSelect)` handles option selection, click, ArrowUp/Down/Home/End, and exposes refresh/dispose; use role=listbox and role=option. Build a flex list/detail layout with ordinary DOM and public styles; avoid a private workbench dependency. Inspect primitives.css for exact class names. Hosts supply semantic token values; copied primitive rules belong to the captured revision.

The kit only controls the guest's DOM and styling. It cannot approve access, execute native commands, acquire files or create trusted dialogs. Custom presentation may use the same bridge without this kit. See `guide manifest` and `guide lifetimes`.

The separate `guest-client.mjs` and `connector-output.mjs` assets own public transport and output reading; presentation helpers own styling only. See `guide bridge` and `guide connectors`.

## A selected-item task with immediate feedback

Place this markup in a view that loads presentation.css and guest-ui.js. These are ordinary
labeled controls, a keyboard-selectable list and a reader; package code supplies the task.

```html
<section id="reader-example" class="hvir-content hvir-stack">
  <label class="hvir-field">Heading <input id="heading" class="hvir-input" value="Notes"></label>
  <label class="hvir-field"><input id="details" class="hvir-input" type="checkbox"> Include details</label>
  <div class="hvir-list-detail">
    <div id="items" role="listbox" aria-label="Documents">
      <button type="button" class="hvir-row" data-variant="selectable" role="option" data-id="one" aria-selected="true">First note</button>
      <button type="button" class="hvir-row" data-variant="selectable" role="option" data-id="two" aria-selected="false">Second note</button>
    </div>
    <pre id="reader" class="hvir-panel hvir-scroll">First note</pre>
  </div>
  <button id="read" type="button" class="hvir-button">Read selection</button>
  <p id="feedback" class="hvir-state" role="status">Ready</p>
</section>
```

```js
function mountReader(root, readSelected) {
  const find = (id) => root.querySelector('#' + id)
  const button = find('read'), feedback = find('feedback'), reader = find('reader')
  let selected = 'one', current, disposed = false
  function stop() {
    current?.abort()
    current = undefined
    button.disabled = false
    root.setAttribute('aria-busy', 'false')
  }
  const list = window.hvirUI.bindList(find('items'), (row) => {
    stop() // Selection invalidates the previous task and its late result.
    selected = row.dataset.id
    reader.textContent = row.textContent
    feedback.textContent = 'Ready'
    feedback.dataset.state = 'empty'
  })
  async function read() {
    if (disposed || current) return
    const operation = new AbortController()
    current = operation
    button.disabled = true
    root.setAttribute('aria-busy', 'true')
    feedback.dataset.state = 'busy'
    feedback.textContent = 'Reading…'
    try {
      const text = await readSelected({ id: selected, heading: find('heading').value,
        details: find('details').checked, signal: operation.signal })
      if (disposed || current !== operation) return
      reader.textContent = text
      feedback.dataset.state = 'success'
      feedback.textContent = 'Read complete'
    } catch (error) {
      if (disposed || current !== operation) return
      feedback.dataset.state = 'error'
      feedback.textContent = error instanceof Error ? error.message : 'Read failed'
    } finally {
      if (current === operation) stop()
    }
  }
  button.addEventListener('click', read)
  return () => {
    if (disposed) return
    disposed = true
    stop()
    list.dispose()
    button.removeEventListener('click', read)
  }
}
```

Call `mountReader(document.querySelector('#reader-example'), readSelected)` and retain its
disposer. `readSelected` belongs to your package: it can return local text, or compose the
selected-document requests from `guide sources` using the admitted guest client and its signal.
Invoke the disposer when the view ends, on revoked/pagehide, or before replacing this panel;
remount on renewed ordinary visibility if you disposed it when hidden. Abort stops local
interest; it does not imply rollback of native effects. A privileged named action uses its
actual invocation/action client from `guide actions`, never a synthetic actionId from a button.
