/** The same package-owned task controls are mounted once in each browser or reader. */
export function mountSkillTasks(document) {
  const slot = document.querySelector('[data-skill-tasks]')
  if (!slot || slot.childElementCount) return
  slot.innerHTML = `                <details id="exposure-preservation-details" hidden>
                  <summary id="exposure-availability">Replacement unavailable</summary>
                  <p id="exposure-preservation-reason" class="hvir-meta"></p>
                  <button id="exposure-refresh" class="hvir-button">
                    Refresh replacement
                  </button>
                </details>
        <section id="exposure-context" hidden aria-label="Selected exposure actions">
          <div class="toolbar">
            <button id="exposure-edit" class="hvir-button" hidden>Edit members…</button>
            <button id="exposure-ungroup" class="hvir-button" hidden>Ungroup…</button>
            <details id="exposure-replacement" class="skill-more" hidden>
              <summary class="hvir-focus">Replace original…</summary>
              <div class="skill-menu">
                <label id="exposure-choice-row" hidden
                  >Library version
                  <select id="exposure-choice" class="hvir-input"></select>
                </label>
                <button id="exposure-full" class="hvir-button" hidden disabled>
                  Replace with Full…
                </button>
                <button id="exposure-stub" class="hvir-button" hidden disabled>
                  Replace with Stub…
                </button>
              </div>
            </details>
          </div>
        </section>
        <section id="exposure-task" hidden aria-label="Change selected skill files">
          <h2 id="exposure-title"></h2>
          <p id="exposure-destination" class="hvir-meta"></p>
          <div class="exposure-scroll">
            <div id="exposure-fields">
              <label id="exposure-name-row" hidden
                >Router name <input id="exposure-name" class="hvir-input"
              /></label>
              <label id="exposure-mode-row" hidden
                >Individual copies
                <select id="exposure-mode" class="hvir-input">
                  <option value="native">Full</option>
                  <option value="stub">Stub</option>
                </select>
              </label>
              <section id="exposure-picker" hidden aria-label="Choose Router members">
                <form id="exposure-member-search">
                  <input
                    id="exposure-member-query"
                    class="hvir-input"
                    type="search"
                    placeholder="Find library skills"
                    aria-label="Find library skills"
                  />
                  <button id="exposure-member-search-button" class="hvir-button">
                    Search
                  </button>
                </form>
                <div
                  id="exposure-member-results"
                  aria-label="Library member choices"
                ></div>
                <div class="toolbar">
                  <button id="exposure-member-previous" class="hvir-button" type="button">
                    Previous
                  </button>
                  <span id="exposure-member-page" class="hvir-meta"></span>
                  <button id="exposure-member-next" class="hvir-button" type="button">
                    Next
                  </button>
                  <details>
                    <summary id="exposure-selected-count">0 selected</summary>
                    <ul id="exposure-selected-members"></ul>
                  </details>
                </div>
              </section>
              <section
                id="exposure-departures"
                hidden
                aria-label="Departing members"
              ></section>
              <section
                id="exposure-replacements"
                hidden
                aria-label="Standalone copies to replace"
              ></section>
            </div>
            <section id="exposure-review" hidden aria-label="Complete affected files">
              <p id="exposure-summary"></p>
              <ul id="exposure-effects"></ul>
              <details>
                <summary>Complete plan and identities</summary>
                <pre id="exposure-plan"></pre>
              </details>
            </section>
            <p id="exposure-state" class="hvir-state" role="status"></p>
            <details id="exposure-operation-details" hidden>
              <summary>Operation details</summary>
              <pre id="exposure-result"></pre>
            </details>
            <button id="exposure-reconcile" class="hvir-button" hidden>
              Inspect uncertain operation
            </button>
          </div>
          <div class="toolbar review-actions">
            <button id="exposure-preview" class="hvir-button">Review changes</button>
            <button id="exposure-confirm" class="hvir-button" hidden>
              Confirm changes
            </button>
            <button id="exposure-cancel" class="hvir-button">Cancel</button>
          </div>
        </section>
        <section id="router-content" hidden aria-label="Router members">
          <p id="router-state" class="hvir-state" role="status"></p>
          <ul id="router-members"></ul>
        </section>
        <section
          id="selected-import"
          hidden
          aria-label="Save original to library"
          class="task-review"
        >
          <div class="toolbar task-controls">
            <button id="import-save" class="hvir-button" disabled>Save and accept</button>
            <span id="import-destination" class="hvir-meta"></span>
            <button
              id="import-inspect"
              class="hvir-button"
              aria-expanded="false"
              aria-controls="import-inspection"
            >
              Inspect files
            </button>
            <details id="import-options" class="skill-more">
              <summary class="hvir-focus" aria-label="Save options">…</summary>
              <div class="skill-menu">
                <label
                  >Library name
                  <input
                    id="import-name"
                    class="hvir-input"
                    placeholder="Use original name"
                /></label>
                <button id="import-refresh" class="hvir-button">Refresh review</button>
                <button id="import-cancel" class="hvir-button">Cancel</button>
                <button id="import-use-library" class="hvir-button" hidden>
                  Use library version
                </button>
              </div>
            </details>
          </div>
          <p id="import-effect" class="hvir-meta"></p>
          <details id="import-replacement" hidden>
            <summary>Project file changes</summary>
            <ul id="import-effects"></ul>
          </details>
          <p id="import-state" class="hvir-state" role="status"></p>
          <button id="import-reconcile" class="hvir-button" hidden>
            Inspect uncertain operation
          </button>
          <details id="import-operation-details">
            <summary>Operation details</summary>
            <pre id="import-result"></pre>
          </details>
        </section>
        <section id="selected-task" hidden aria-label="Use this skill">
          <p id="task-destination" class="hvir-meta"></p>
          <div class="toolbar task-controls">
            <span id="task-agent-name" class="hvir-meta" hidden></span>
            <label id="task-agent-field"
              >Agent
              <select id="task-agent" class="hvir-input">
                <option value="codex">Codex</option>
                <option value="claude">Claude</option>
              </select></label
            >
            <label
              >Copy
              <select id="task-mode" class="hvir-input">
                <option value="native">Full</option>
                <option value="stub">Stub</option>
              </select></label
            >
            <button id="task-primary" class="hvir-button" disabled>Add to project</button>
            <button id="task-connect" class="hvir-button" hidden>
              Connect for this project
            </button>
            <details id="task-options" class="skill-more" hidden>
              <summary
                class="hvir-focus"
                aria-label="Skill actions"
                title="Skill actions"
              >
                …
              </summary>
              <div class="skill-menu">
                <button id="exposure-group" class="hvir-button" hidden>
                  Group with other skills…
                </button>
                <button id="task-save-original" class="hvir-button" hidden>
                  Save original as…
                </button>
                <button id="task-update" class="hvir-button" hidden>Update…</button>
                <button id="task-refresh" class="hvir-button">Refresh status</button
                ><button id="task-remove" class="hvir-button" hidden>
                  Remove from project…
                </button>
              </div>
            </details>
          </div>
          <label id="task-export-field" hidden
            >Local export folder
            <input
              id="task-export"
              class="hvir-input"
              placeholder="New or empty local folder"
          /></label>
          <p id="task-state" class="hvir-state" role="status"></p>
          <button id="task-reconcile" class="hvir-button" hidden>
            Inspect uncertain operation
          </button>
          <section
            id="task-confirmation"
            class="task-review"
            hidden
            aria-label="Confirm project change"
          >
            <h2 id="task-confirm-title"></h2>
            <p id="task-confirm-target" class="hvir-meta"></p>
            <ul id="task-effects"></ul>
            <details>
              <summary>Version and file details</summary>
              <pre id="task-plan"></pre>
            </details>
            <div class="toolbar review-actions">
              <button id="task-confirm" class="hvir-button"></button
              ><button id="task-cancel" class="hvir-button">Cancel</button>
            </div>
          </section>
          <section
            id="exact-review"
            class="task-review"
            hidden
            aria-label="Review skill version"
          >
            <h2>Review version</h2>
            <p id="review-version" class="hvir-meta"></p>
            <div id="review-files" aria-label="All files in this version"></div>
            <p id="review-file-label" class="hvir-meta"></p>
            <pre
              id="review-file-body"
              tabindex="0"
              aria-label="Selected review file"
            ></pre>
            <div id="review-pages" class="toolbar" hidden>
              <button id="review-previous" class="hvir-button" disabled>
                Previous page</button
              ><span id="review-page-label"></span
              ><button id="review-next" class="hvir-button" disabled>Next page</button>
            </div>
            <details>
              <summary>Complete version details</summary>
              <pre id="review-manifest" tabindex="0"></pre>
            </details>
            <div class="toolbar review-actions">
              <button id="accept-version" class="hvir-button" disabled>
                Accept version</button
              ><button id="cancel-review" class="hvir-button">Cancel</button>
            </div>
          </section>
          <details id="task-operation-details">
            <summary>Operation details</summary>
            <pre id="task-result"></pre>
          </details>
        </section>
        <section
          id="import-inspection"
          hidden
          aria-label="Original files and destination"
        >
          <p id="import-version" class="hvir-meta"></p>
          <p id="import-target" class="hvir-meta"></p>
          <div id="import-files" aria-label="All files in this original"></div>
          <p id="import-file-state" class="hvir-state" role="status"></p>
          <div id="import-file-navigation">
            <span id="import-file-label" class="hvir-meta"></span>
            <button id="import-all-files" class="hvir-button">All files</button>
          </div>
          <pre
            id="import-file-body"
            tabindex="0"
            aria-label="Selected original file"
          ></pre>
          <div id="import-pages" class="toolbar" hidden>
            <button id="import-previous" class="hvir-button">Previous page</button
            ><span id="import-page-label"></span
            ><button id="import-next" class="hvir-button">Next page</button>
          </div>
          <details>
            <summary>Complete version details</summary>
            <pre id="import-manifest"></pre>
          </details>
        </section>
`
  const disclosure = document.getElementById('exposure-preservation-details')
  const options =
    document.querySelector('.instruction-modes .skill-menu') ??
    document.querySelector('#import-options .skill-menu')
  options.append(disclosure)
}
