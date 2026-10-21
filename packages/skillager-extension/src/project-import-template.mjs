/** Package-owned bulk review; the browser's existing task sheet owns its frame. */
export function mountProjectImport(document, sheet) {
  const section = document.createElement('section')
  section.id = 'project-import'
  section.hidden = true
  section.setAttribute('aria-label', 'Save project skills to library')
  section.innerHTML = `
    <p id="project-import-destination" class="hvir-meta"></p>
    <p id="project-import-initialization" class="hvir-meta"></p>
    <details id="project-import-location" hidden>
      <summary>Library location</summary>
      <p id="project-import-location-path" class="hvir-meta"></p>
    </details>
    <p id="project-import-selection" class="hvir-meta"></p>
    <div id="project-import-choices" aria-label="Skills to save"></div>
    <button id="project-import-more" class="hvir-button" hidden>Load more skills</button>
    <details id="project-import-skipped" hidden>
      <summary id="project-import-skipped-summary"></summary>
      <ul id="project-import-conflicts"></ul>
    </details>
    <section id="project-import-inspection" hidden aria-label="Inspect original files">
      <div class="toolbar">
        <strong id="project-import-inspect-name"></strong>
        <button id="project-import-close-files" class="hvir-button">Close files</button>
      </div>
      <div id="project-import-files"></div>
      <p id="project-import-file-state" class="hvir-state" role="status"></p>
      <p id="project-import-file-label" class="hvir-meta"></p>
      <pre id="project-import-file-body" tabindex="0" aria-label="Selected original file"></pre>
      <div id="project-import-pages" class="toolbar" hidden>
        <button id="project-import-previous" class="hvir-button">Previous page</button>
        <span id="project-import-page-label"></span>
        <button id="project-import-next" class="hvir-button">Next page</button>
      </div>
    </section>
    <p id="project-import-state" class="hvir-state" role="status"></p>
    <ul id="project-import-outcomes" hidden></ul>
    <button id="project-import-reconcile" class="hvir-button" hidden>Check saved skills</button>
    <details id="project-import-operation" hidden>
      <summary>Operation details</summary>
      <pre id="project-import-report" tabindex="0"></pre>
    </details>
    <div class="review-actions">
      <button id="project-import-save" class="hvir-button" disabled>Save skills</button>
      <button id="project-import-refresh" class="hvir-button" hidden>Review again</button>
    </div>`
  sheet.append(section)
  return section
}
