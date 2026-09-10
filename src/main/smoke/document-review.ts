import type { BrowserWindow } from 'electron'

import {
  harnessLaunchCapabilities,
  type HarnessProvider,
} from '../harness/harness-provider'
import type { HarnessProfileStore } from '../harness/harness-profile-store'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import { DocumentReviewDriver } from './document-review-driver'
import type { DocumentReviewCondition } from './document-review-evidence.mts'
import type { SmokeFailureCheckpoint } from './failure-evidence.mts'
import { waitForPtyOutput } from './pty-lifecycle'
import type { DocumentReviewRuntime } from '../document-review'
import { DocumentReviewStore } from '../document-review/document-review-store'
import type { HostPath, ReviewWorkspaceIdentity } from '../../shared'

const COMMENT = 'First review line\nSecond review line with a tab:\tkept literal'

/**
 * Exercises document review only at boundaries that require Electron, native PTY,
 * or application composition. Pure anchor and lifecycle branches stay in their
 * direct owning tests.
 */
export async function verifyDocumentReviewWorkflow(options: {
  readonly win: BrowserWindow
  readonly host: ProjectHost
  readonly root: HostPath
  readonly document: HostPath
  readonly documentContents: string
  readonly captureA: HostPath
  readonly captureB: HostPath
  readonly reviewFile: HostPath
  readonly review: DocumentReviewRuntime
  readonly profiles: HarnessProfileStore
  readonly provider: HarnessProvider
  readonly supervisor: PtySupervisor
  readonly resources: RendererResourceScopes
  readonly checkpoint: (checkpoint: SmokeFailureCheckpoint) => void
}): Promise<string> {
  const {
    win: window,
    host,
    root,
    document,
    documentContents,
    captureA,
    captureB,
    reviewFile,
    review,
    profiles,
    provider,
    supervisor,
    resources,
  } = options
  const win = new DocumentReviewDriver(window, options.checkpoint)
  const workspace: ReviewWorkspaceIdentity = { id: 'smoke-workspace', root }

  try {
    await openFixtureAndProveAmbientSelectionIsInert(win, document)
    await activateControl(win, '[aria-label="Enter Markdown review mode"]')
    await waitForRenderer(
      win,
      `document.querySelector('[aria-label="Markdown review comments"]')`,
      'review mode did not open from its focused control',
    )
    await proveRenderedControlsUseLeftGutter(win)
    await focusRenderedBlock(win, 0)
    await dispatchFocusedKey(win, 'ArrowDown')
    await dispatchFocusedKey(win, 'Enter')
    await waitForRenderer(
      win,
      `document.querySelector('[aria-label="New review comment"]')`,
      'rendered keyboard capture did not open a comment form',
    )
    await proveComposeContextVisible(win)
    await focusRenderer(win, '[aria-label="New review comment"]')
    await win.run('comment-text-insert', () => win.webContents.insertText(COMMENT))
    await activateControl(win, '.document-review-compose button[type="submit"]')
    await waitForComment(win, 'draft')
    await waitForRenderer(
      win,
      `document.querySelector('.review-block-badge') instanceof HTMLButtonElement`,
      'rendered note badge did not project after comment submission',
    )
    await activateControl(win, '[aria-label="Exit Markdown review mode"]')
    await waitForRenderer(
      win,
      `document.querySelector('.review-block-badge') instanceof HTMLButtonElement`,
      'rendered note badge did not remain available outside review mode',
    )
    await activateControl(win, '.review-block-badge')
    await waitForRenderer(
      win,
      `document.querySelector('[aria-label="Markdown review comments"]') && ` +
        `document.activeElement?.classList.contains('document-review-comment')`,
      'rendered note badge did not reopen review mode and focus its comment',
    )
    await waitForRenderer(
      win,
      `(() => { const inline = document.querySelector('.document-review-inline'); const comment = inline?.querySelector('.document-review-comment'); const block = document.querySelector('.review-block-noted'); ` +
        `const close = inline?.querySelector('.document-review-close'); const remove = comment?.querySelector('.document-review-comment-delete'); const panel = inline instanceof HTMLElement ? getComputedStyle(inline) : null; ` +
        `return inline instanceof HTMLElement && comment instanceof HTMLElement && block instanceof HTMLElement && ` +
        `comment.querySelector('.document-review-comment-location, .document-review-comment-state, .review-anchor-state') === null && ` +
        `getComputedStyle(comment).borderLeftWidth === '0px' && getComputedStyle(block).boxShadow === 'none' && panel?.borderLeftWidth === panel?.borderTopWidth && ` +
        `inline.offsetHeight <= 110 && close?.textContent?.trim() === 'Close' && remove?.textContent?.trim() === 'Delete comment'; })()`,
      'existing comment retained ambiguous controls, excess height, or layered emphasis',
    )
    await waitForRenderer(
      win,
      `document.querySelector('[aria-label^="Review and send 1 comment"]')`,
      'new comment did not join the pending review',
    )

    await activateMode(win, 'source')
    await waitForRenderer(
      win,
      `document.querySelector('.cm-review-marker') && ` +
        `document.querySelectorAll('.document-review-comment').length === 1 && ` +
        `document.querySelector('.cm-content')?.getAttribute('aria-label') === 'Markdown source review'`,
      'source view did not project the rendered anchor with accessible review semantics',
    )
    await proveSourceInlineFollowsLine(win)
    await captureSourceLineNumber(win, 2)
    await waitForRenderer(
      win,
      `document.querySelector('[aria-label="New comment for Line 2"]') && ` +
        `document.activeElement?.getAttribute('aria-label') === 'New review comment'`,
      'source line-number capture did not focus a line-specific comment form',
    )
    await proveComposeContextVisible(win)
    await activateControl(win, '.document-review-compose button[type="button"]')

    await host.writeFile(document, `# Shifted before review\n\n${documentContents}`)
    await waitForRenderer(
      win,
      `document.querySelector('.cm-review-marker.review-anchor-moved')`,
      'unique file edit did not move the source review marker',
    )
    await openSourceReviewMarker(win)
    await waitForRenderer(
      win,
      `document.querySelector('.document-review-comment.review-anchor-moved') && ` +
        `/Moved from Lines?/.test(document.querySelector('.document-review-comment')?.textContent || '')`,
      'unique file edit did not expose the prior review location',
    )

    await activateControl(win, `.viewer-tab.active .tab-close`)
    await waitForRenderer(
      win,
      `!document.querySelector('.viewer-tab.active .tab-main[title=${selectorString(document.path)}]')`,
      'closing the reviewed tab did not settle',
    )
    await openFixture(win, document)
    await ensureReviewMode(win)
    await waitForComment(win, 'draft')

    await switchProject(win, 'return-fixture')
    await switchProject(win, 'hvir')
    await openFixture(win, document)
    await ensureReviewMode(win)
    await waitForComment(win, 'draft')

    const initialOwner = resources.currentOwner(win.webContents.id)
    await win.reload()
    await waitForRenderer(
      win,
      `window.hvir && document.querySelector('.workbench')`,
      'replacement renderer did not regain its workbench',
    )
    const replacementOwner = resources.currentOwner(win.webContents.id)
    if (replacementOwner.generation !== initialOwner.generation + 1) {
      throw new Error('document review reload did not advance one renderer generation')
    }
    await openFixture(win, document)
    await ensureReviewMode(win)
    await waitForComment(win, 'draft')

    const terminals = await startCaptureTerminals({
      driver: win,
      host,
      root,
      captureA,
      captureB,
      ownerId: replacementOwner.id,
      ownerGeneration: replacementOwner.generation,
      profiles,
      provider,
      supervisor,
    })

    await runStage('initial delivery preview', async () => {
      await activateControl(win, '[aria-label^="Review and send 1 comment"]')
      await waitForExactPreview(win)
      await proveDeliveryClearsViewerControls(win)
    })
    const body = await runStage('initial destination preparation', async () => {
      await selectDestination(win, terminals.first.id)
      return preparedBody(win, terminals.first.id)
    })

    // Move focus after preparation; the immutable destination must remain the first PTY.
    await runStage('prepared destination focus mutation and insert', async () => {
      await focusProject(win, 'hvir')
      await activateControl(win, '.document-review-delivery-actions button:nth-child(2)')
    })
    const insert = terminals.insertTransport(body)
    await waitForExactCapture(win, host, captureA, insert)
    if ((await host.readTextFile(captureB)).length !== 0) {
      throw new Error('focus change retargeted the prepared review delivery')
    }
    await waitForRenderer(
      win,
      `document.querySelector('.document-review-delivery-actions button:nth-child(2)')?.textContent?.trim() === 'Inserted' && ` +
        `document.querySelector('.document-review-comment[data-review-lifecycle="draft"]')`,
      'insert did not preserve the draft lifecycle',
    )

    await runStage('close preview before direct send', async () => {
      await activateControl(win, '.document-review-delivery header button')
      await waitForRenderer(
        win,
        `!document.querySelector('.document-review-delivery')`,
        'delivery preview did not close before direct send',
      )
    })
    await runStage('direct send to the top terminal', () =>
      activateControl(win, '[aria-label^="Send 1 review comment to the top terminal"]'),
    )
    const sentTransport = terminals.sendTransport(body)
    await waitForExactCapture(win, host, captureA, `${insert}${sentTransport}`)
    await waitForRenderer(
      win,
      `!document.querySelector('.review-block-badge') && ` +
        `!document.querySelector('.cm-review-marker')`,
      'delivered review remained projected in the document',
    )

    await win.run('store-flush', () => review.flush())
    const restartedStore = await win.run('store-restart', async (signal) => {
      const store = await DocumentReviewStore.load(host, reviewFile)
      if (signal.aborted) {
        await store.dispose()
        signal.throwIfAborted()
      }
      return store
    })
    try {
      const restarted = restartedStore.read(workspace)
      if (restarted.model.comments.length !== 0 || restarted.model.batches.length !== 0) {
        throw new Error('application restart reader retained delivered review state')
      }
    } finally {
      await restartedStore.dispose()
    }

    supervisor.disposeSession(
      terminals.first.id,
      replacementOwner.id,
      replacementOwner.generation,
    )
    supervisor.disposeSession(
      terminals.second.id,
      replacementOwner.id,
      replacementOwner.generation,
    )
    if (supervisor.list().length !== 0) {
      throw new Error('document review PTY fixtures remained supervised after cleanup')
    }

    await win.destroy()
    await win.wait(
      'renderer-authority-revoked',
      () => !resources.isCurrent(replacementOwner),
      false,
    )
    try {
      review.delivery.preview(replacementOwner, {
        workspace,
        workspaceGeneration: 1,
        selection: { kind: 'batch', batchId: 'active-review' },
      })
      throw new Error('destroyed renderer retained review delivery authority')
    } catch (reason) {
      if (
        reason instanceof Error &&
        reason.message === 'destroyed renderer retained review delivery authority'
      ) {
        throw reason
      }
    }

    return (
      'inert selection · rendered/source anchor · moved prior location · ' +
      'tab/project/reload/restart durability · byte-identical preview/insert/direct-send · ' +
      'fixed top destination · delivered cleanup · renderer/PTY cleanup'
    )
  } finally {
    for (const terminal of supervisor.list()) {
      if (terminal.id === 'document-review-a' || terminal.id === 'document-review-b') {
        supervisor.disposeSession(terminal.id, terminal.ownerId, terminal.ownerGeneration)
      }
    }
  }
}

async function startCaptureTerminals(options: {
  readonly driver: DocumentReviewDriver
  readonly host: ProjectHost
  readonly root: HostPath
  readonly captureA: HostPath
  readonly captureB: HostPath
  readonly ownerId: number
  readonly ownerGeneration: number
  readonly profiles: HarnessProfileStore
  readonly provider: HarnessProvider
  readonly supervisor: PtySupervisor
}) {
  const {
    host,
    root,
    captureA,
    captureB,
    ownerId,
    ownerGeneration,
    profiles,
    provider,
    supervisor,
  } = options
  await host.writeFile(captureA, '')
  await host.writeFile(captureB, '')
  const [profile] = await profiles.materializeTemplates([provider.manifest.id])
  if (!profile) throw new Error('Review-capable smoke profile did not materialize')
  const insertContract = provider.documentReviewInsert
  const sendContract = provider.documentReviewSendNow
  if (!insertContract || !sendContract) {
    throw new Error('Selected smoke provider lacks a complete document review contract')
  }
  const probed = {
    sessionIdentity: provider.sessionIdentity,
    exactResume: provider.supportsResume,
    contextPresentation: provider.manifest.contextPresentation,
    reviewInsertContractRevision: insertContract.revision,
    reviewSendNowContractRevision: sendContract.revision,
  }
  const launchCapabilities = harnessLaunchCapabilities(provider, {
    profile,
    composerSubmitMode: 'ctrl-enter',
    probedCapabilities: probed,
  })
  const effectiveCapabilities = {
    ...launchCapabilities,
    // The capture process is the immediate PTY boundary, not a fake Codex
    // persistence store. Provider contract tests own discovered-session proof.
    sessionIdentity: 'none' as const,
    exactResume: false,
  }
  const reviewLaunch = {
    profile,
    composerSubmitMode: 'ctrl-enter' as const,
    effectiveCapabilities,
  }
  if (!sendContract.supportsLaunch(reviewLaunch)) {
    throw new Error('Selected smoke profile does not support document review send-now')
  }
  const start = async (id: string, destination: HostPath) => {
    const readyMarker = `__HVIR_DOCUMENT_REVIEW_CAPTURE_READY_${id}__`
    const terminal = await options.driver.run('capture-pty-start', async (signal) => {
      const started = await supervisor.spawn({
        host,
        provider,
        launchSpec: {
          file: '/bin/sh',
          args: [
            '-c',
            'stty raw -echo; printf \'%s\\n\' "$2"; exec cat >> "$1"',
            'hvir-document-review-capture',
            destination.path,
            readyMarker,
          ],
        },
        effectiveCapabilities,
        profileId: profile.id,
        launchRevision: profile.launchRevision,
        providerContractVersion: profile.providerContractVersion,
        composerSubmitMode: 'ctrl-enter',
        cwd: root,
        workspaceRoot: root,
        ownerId,
        ownerGeneration,
        sessionId: id,
        cols: 80,
        rows: 24,
      })
      if (signal.aborted) {
        supervisor.disposeSession(started.id, started.ownerId, started.ownerGeneration)
        signal.throwIfAborted()
      }
      return started
    })
    await options.driver.run('capture-pty-ready', (signal) =>
      waitForPtyOutput({
        supervisor,
        terminal,
        expected: readyMarker,
        scenario: 'document review capture PTY',
        trigger: () => undefined,
        signal,
      }),
    )
    return terminal
  }
  const first = await start('document-review-a', captureA)
  const second = await start('document-review-b', captureB)
  return {
    first,
    second,
    insertTransport: (body: string) => insertContract.terminalInput(body),
    sendTransport: (body: string) => sendContract.terminalInput(body, reviewLaunch),
  }
}

async function openFixtureAndProveAmbientSelectionIsInert(
  win: DocumentReviewDriver,
  path: HostPath,
): Promise<void> {
  await openFixture(win, path)
  await activateMode(win, 'rendered')
  await waitForRenderer(
    win,
    `document.querySelector('.markdown-body [data-source-line]') && ` +
      `!document.querySelector('[aria-label="Enter Markdown review mode"]')?.disabled`,
    'rendered review block or enabled review control was missing',
  )
  await evaluateRenderer<void>(
    win,
    'ambient review selection check',
    `
      (() => {
        try {
          const block = document.querySelector('.markdown-body [data-source-line]');
          if (!block) throw new Error('rendered review block was missing');
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(block);
          selection?.removeAllRanges();
          selection?.addRange(range);
          if (document.querySelector('.document-review-comment')) {
            throw new Error('ambient rendered selection created review state');
          }
          const review = document.querySelector('[aria-label="Enter Markdown review mode"]');
          if (!(review instanceof HTMLButtonElement)) {
            throw new Error('labeled review entry control was missing');
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      })()
    `,
  )
}

async function openFixture(win: DocumentReviewDriver, path: HostPath): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'fixture-open',
    `
      (() => {
          const active = document.querySelector('.viewer-tab.active .tab-main')
            ?.getAttribute('title');
          if (active === ${JSON.stringify(path.path)}) return ({ ok: true });
          const file = [...document.querySelectorAll('.file-row')].find(
            (candidate) => candidate.getAttribute('title') === ${JSON.stringify(path.path)}
          );
          if (file instanceof HTMLElement) file.click();

          return { pending: true };
      })()
    `,
  )
}

async function activateMode(win: DocumentReviewDriver, mode: 'rendered' | 'source') {
  await evaluateRenderer<void>(
    win,
    'mode-selection',
    `
      (() => {
        try {
          const select = document.querySelector('.mode-select[aria-label="View mode"]');
          if (!(select instanceof HTMLSelectElement)) {
            throw new Error('accessible view mode control missing');
          }
          select.focus();
          const setter = Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype,
            'value'
          )?.set;
          setter?.call(select, ${JSON.stringify(mode)});
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      })()
    `,
  )
  await waitForRenderer(
    win,
    `document.querySelector('.mode-control button.active')?.textContent?.trim() === ${JSON.stringify(mode)}`,
    'mode-active',
  )
}

async function focusRenderedBlock(
  win: DocumentReviewDriver,
  index: number,
): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'rendered-block-focus',
    `
      (() => {
          const blocks = document.querySelectorAll('.review-block-active');
          const block = blocks.item(${index});
          if (block instanceof HTMLElement) {
            block.focus();
            return ({ ok: true });
          }

          return { pending: true };
      })()
    `,
  )
}

async function proveRenderedControlsUseLeftGutter(
  win: DocumentReviewDriver,
): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'rendered review left gutter geometry',
    `
      (() => {
          const block = document.querySelector('.review-block-active');
          const add = block?.querySelector('.review-block-add');
          if (block instanceof HTMLElement && add instanceof HTMLButtonElement) {
            const blockRect = block.getBoundingClientRect();
            const addRect = add.getBoundingClientRect();
            if (addRect.right <= blockRect.left) return ({ ok: true });
            return ({
              ok: false,
              error: 'rendered review capture control was not in the left gutter'
            });
          }

          return { pending: true };
      })()
    `,
  )
}

async function proveComposeContextVisible(win: DocumentReviewDriver): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'review composer focus geometry',
    `
      (() => {
          const inline = document.querySelector('.document-review-inline');
          const form = document.querySelector('.document-review-compose');
          const header = inline?.querySelector(':scope > header');
          const textarea = form?.querySelector('textarea');
          if (
            inline instanceof HTMLElement &&
            header instanceof HTMLElement &&
            textarea instanceof HTMLTextAreaElement
          ) {
            const inlineRect = inline.getBoundingClientRect();
            const headerRect = header.getBoundingClientRect();
            const textareaRect = textarea.getBoundingClientRect();
            const sourceHost = inline.closest('.document-review-inline-host-source');
            const scroller = sourceHost?.closest('.cm-scroller');
            const sourceFits =
              !(sourceHost instanceof HTMLElement) ||
              (scroller instanceof HTMLElement &&
                sourceHost.getBoundingClientRect().width <=
                  scroller.getBoundingClientRect().width - 16 &&
                sourceHost.getBoundingClientRect().right <=
                  scroller.getBoundingClientRect().right - 8);
            if (
              document.activeElement === textarea &&
              form?.querySelector('label > span') === null &&
              getComputedStyle(textarea).outlineStyle === 'none' &&
              headerRect.top >= inlineRect.top &&
              headerRect.bottom + 3 <= textareaRect.top &&
              sourceFits
            ) return ({ ok: true });
            return ({
              ok: false,
              error: 'focused review composer duplicated or obscured its header, focus, or visible width'
            });
          }

          return { pending: true };
      })()
    `,
  )
}

async function proveSourceInlineFollowsLine(win: DocumentReviewDriver): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'source inline review geometry',
    `
      (() => {
        const host = document.querySelector('.document-review-inline-host-source');
        const line = host?.previousElementSibling;
        if (!(host instanceof HTMLElement) || !(line instanceof HTMLElement)) {
          return { ok: false, error: 'source inline review or anchor line missing' };
        }
        const hostRect = host.getBoundingClientRect();
        const lineRect = line.getBoundingClientRect();
        return hostRect.top >= lineRect.bottom
          ? { ok: true }
          : { ok: false, error: 'source inline review did not follow its anchor line' };
      })()
    `,
  )
}

async function proveDeliveryClearsViewerControls(
  win: DocumentReviewDriver,
): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'review delivery control-row geometry',
    `
      (() => {
        const controls = document.querySelector('.viewer-floating-controls');
        const delivery = document.querySelector('.document-review-delivery');
        if (!(controls instanceof HTMLElement) || !(delivery instanceof HTMLElement)) {
          return { ok: false, error: 'review delivery or viewer controls missing' };
        }
        const controlsRect = controls.getBoundingClientRect();
        const deliveryRect = delivery.getBoundingClientRect();
        return deliveryRect.top >= controlsRect.bottom + 4
          ? { ok: true }
          : {
              ok: false,
              error: 'review delivery overlapped the viewer control row'
            };
      })()
    `,
  )
}

async function openSourceReviewMarker(win: DocumentReviewDriver): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'source review marker activation',
    `
      (() => {
          const marker = document.querySelector('.cm-review-marker');
          if (marker instanceof HTMLElement) {
            const rect = marker.getBoundingClientRect();
            marker.dispatchEvent(new MouseEvent('mousedown', {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2
            }));
            return ({ ok: true });
          }

          return { pending: true };
      })()
    `,
  )
}

async function captureSourceLineNumber(
  win: DocumentReviewDriver,
  line: number,
): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'source-line-capture',
    `
      (() => {
        try {
          const marker = [...document.querySelectorAll(
            '.cm-lineNumbers .cm-gutterElement'
          )].find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(String(line))});
          if (!(marker instanceof HTMLElement)) {
            throw new Error('source line-number gutter marker missing');
          }
          const rect = marker.getBoundingClientRect();
          marker.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2
          }));
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      })()
    `,
  )
}

async function selectDestination(
  win: DocumentReviewDriver,
  terminalId: string,
): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'destination selection action',
    `
      (() => {
        try {
          const select = document.querySelector('[aria-label="Review handoff destination"]');
          if (!(select instanceof HTMLSelectElement)) {
            throw new Error('labeled review destination control missing');
          }
          if (select.disabled) {
            throw new Error('review destination control was not ready');
          }
          const setter = Object.getOwnPropertyDescriptor(
            HTMLSelectElement.prototype,
            'value'
          )?.set;
          setter?.call(select, ${JSON.stringify(terminalId)});
          select.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      })()
    `,
  )
  await waitForRenderer(
    win,
    `document.querySelector('[aria-label="Review handoff destination"]')?.value === ${JSON.stringify(terminalId)}`,
    'accessible destination selection did not bind the first terminal',
  )
}

async function preparedBody(
  win: DocumentReviewDriver,
  terminalId: string,
): Promise<string> {
  return evaluateRenderer<string>(
    win,
    'prepared body wait',
    `
      (() => {
          const select = document.querySelector('[aria-label="Review handoff destination"]');
          const preview = document.querySelector('[aria-label="Exact review delivery preview"]');
          const insert = document.querySelector('.document-review-delivery-actions button:nth-child(2)');
          if (
            select?.value === ${JSON.stringify(terminalId)} &&
            preview instanceof HTMLElement &&
            insert instanceof HTMLButtonElement && !insert.disabled
          ) return ({ ok: true, value: preview.textContent || '' });

          return { pending: true };
      })()
    `,
  )
}

async function waitForExactPreview(win: DocumentReviewDriver): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'exact preview wait',
    `
      (() => {
          const preview = document.querySelector(
            '[aria-label="Exact review delivery preview"]'
          );
          const destination = document.querySelector(
            '[aria-label="Review handoff destination"]'
          );
          if (preview && destination instanceof HTMLSelectElement && !destination.disabled) {
            return ({ ok: true });
          }
          const delivery = document.querySelector('.document-review-delivery');
          const alert = delivery?.querySelector('[role="alert"]');
          if (alert) {
            return ({ ok: false, error: 'review delivery reported an error' });
          }

          return { pending: true };
      })()
    `,
  )
}

async function waitForComment(
  win: DocumentReviewDriver,
  lifecycle: 'draft',
): Promise<void> {
  await openReviewCommentIfNeeded(win)
  await waitForRenderer(
    win,
    `document.querySelectorAll('.document-review-comment').length === 1 && ` +
      `document.querySelector('.document-review-comment[data-review-lifecycle="${lifecycle}"]')`,
    'draft-comment-restored',
  )
}

async function openReviewCommentIfNeeded(win: DocumentReviewDriver): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'inline review comment restore',
    `
      (() => {
          if (document.querySelector('.document-review-comment')) {
            return ({ ok: true });
          }
          const badge = document.querySelector('.review-block-badge');
          if (badge instanceof HTMLButtonElement) {
            badge.click();
            return { pending: true };
          }
          const marker = document.querySelector('.cm-review-marker');
          if (marker instanceof HTMLElement) {
            const rect = marker.getBoundingClientRect();
            marker.dispatchEvent(new MouseEvent('mousedown', {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2
            }));
            return { pending: true };
          }

          return { pending: true };
      })()
    `,
  )
}

async function ensureReviewMode(win: DocumentReviewDriver): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'review mode restore',
    `
      (() => {

          if (document.querySelector('[aria-label="Markdown review comments"]')) {
            return ({ ok: true });
          }
          const entry = document.querySelector(
            '[aria-label="Enter Markdown review mode"]'
          );
          if (entry instanceof HTMLButtonElement && !entry.disabled) {
            entry.focus();
            entry.click();
          }

          return { pending: true };
      })()
    `,
  )
}

async function switchProject(
  win: DocumentReviewDriver,
  displayName: string,
): Promise<void> {
  await activateProject(win, displayName)
  await waitForRenderer(
    win,
    `document.querySelector('.project-tab.active .project-tab-main strong')?.textContent?.trim() === ${JSON.stringify(displayName)}`,
    'project-active',
  )
}

async function activateProject(
  win: DocumentReviewDriver,
  displayName: string,
): Promise<void> {
  await focusProject(win, displayName)
  await evaluateRenderer<void>(
    win,
    'project-activation',
    `
      (() => {
        try {
          const button = document.activeElement;
          if (!(button instanceof HTMLButtonElement) ||
              button.querySelector('strong')?.textContent?.trim() !== ${JSON.stringify(displayName)}) {
            throw new Error('focused project control changed before activation');
          }
          button.click();
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      })()
    `,
  )
}

async function focusProject(
  win: DocumentReviewDriver,
  displayName: string,
): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'project-focus',
    `
      (() => {
        try {
          const button = [...document.querySelectorAll('.project-tab-main')].find(
            (candidate) => candidate.querySelector('strong')?.textContent?.trim() === ${JSON.stringify(displayName)}
          );
          if (!(button instanceof HTMLButtonElement)) {
            throw new Error('project control missing');
          }
          button.focus();
          if (document.activeElement !== button) {
            throw new Error('project control was not focusable');
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      })()
    `,
  )
}

async function activateControl(
  win: DocumentReviewDriver,
  selector: string,
): Promise<void> {
  await focusRenderer(win, selector)
  await evaluateRenderer<void>(
    win,
    'control-activation',
    `
      (() => {
        try {
          const target = document.activeElement;
          if (!(target instanceof HTMLButtonElement)) {
            throw new Error('focused review control was not a button');
          }
          target.click();
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      })()
    `,
  )
}

async function focusRenderer(win: DocumentReviewDriver, selector: string): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'control-focus',
    `
      (() => {
        try {
          const target = document.querySelector(${JSON.stringify(selector)});
          if (!(target instanceof HTMLElement)) throw new Error('focused control missing');
          if (!target.getAttribute('aria-label') && !(target instanceof HTMLButtonElement)) {
            throw new Error('review control lacks an accessible label');
          }
          target.focus();
          if (document.activeElement !== target) {
            throw new Error('review control was not focusable');
          }
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      })()
    `,
  )
}

async function dispatchFocusedKey(win: DocumentReviewDriver, key: string): Promise<void> {
  await evaluateRenderer<void>(
    win,
    'keyboard-dispatch',
    `
      (() => {
        try {
          const target = document.activeElement;
          if (!(target instanceof HTMLElement)) {
            throw new Error('review keyboard target missing');
          }
          target.dispatchEvent(new KeyboardEvent('keydown', {
            key: ${JSON.stringify(key)},
            bubbles: true,
            cancelable: true
          }));
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      })()
    `,
  )
}

async function waitForRenderer(
  win: DocumentReviewDriver,
  expression: string,
  message: DocumentReviewCondition,
): Promise<void> {
  await evaluateRenderer<void>(
    win,
    message,
    `
      (() => {
          try {
            if (${expression}) return ({ ok: true });
          } catch (error) {
            return ({ ok: false, error: String(error) });
          }

          return { pending: true };
      })()
    `,
  )
}

async function waitForExactCapture(
  win: DocumentReviewDriver,
  host: ProjectHost,
  path: HostPath,
  expected: string,
): Promise<void> {
  await win.wait('capture-exact-bytes', async () => {
    const captured = await host.readTextFile(path)
    if (Buffer.byteLength(captured) > Buffer.byteLength(expected)) {
      throw new Error('document review PTY captured unexpected extra bytes')
    }
    return captured === expected
  })
}

function selectorString(value: string): string {
  return JSON.stringify(value)
}

async function runStage<T>(stage: string, task: () => Promise<T>): Promise<T> {
  try {
    return await task()
  } catch (reason) {
    throw new Error(
      `document review smoke stage '${stage}' failed: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
      { cause: reason },
    )
  }
}

async function evaluateRenderer<T>(
  win: DocumentReviewDriver,
  stage: DocumentReviewCondition,
  script: string,
): Promise<T> {
  return win.evaluate<T>(stage, script)
}
