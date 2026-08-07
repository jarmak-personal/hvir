import type { BrowserWindow } from 'electron'

import {
  harnessLaunchCapabilities,
  type HarnessProvider,
} from '../harness/harness-provider'
import type { HarnessProfileStore } from '../harness/harness-profile-store'
import type { ProjectHost } from '../project-host'
import type { PtySupervisor } from '../pty/pty-supervisor'
import type { RendererResourceScopes } from '../renderer-resource-scopes'
import type { DocumentReviewRuntime } from '../document-review'
import { DocumentReviewStore } from '../document-review/document-review-store'
import type { Disposer, HostPath, ReviewWorkspaceIdentity } from '../../shared'

const COMMENT = 'First review line\nSecond review line with a tab:\tkept literal'
const TIMEOUT_MS = 20_000

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
}): Promise<string> {
  const {
    win,
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
  const workspace: ReviewWorkspaceIdentity = { id: 'smoke-workspace', root }

  await openFixtureAndProveAmbientSelectionIsInert(win, document)
  await activateControl(win, '[aria-label="Enter Markdown review mode"]')
  await waitForRenderer(
    win,
    `document.querySelector('[aria-label="Markdown review comments"]')`,
    'review mode did not open from its focused control',
  )
  await focusRenderedBlock(win, 0)
  await dispatchFocusedKey(win, 'ArrowDown')
  await dispatchFocusedKey(win, 'Enter')
  await waitForRenderer(
    win,
    `document.querySelector('[aria-label="New review comment"]')`,
    'rendered keyboard capture did not open a comment form',
  )
  await focusRenderer(win, '[aria-label="New review comment"]')
  await win.webContents.insertText(COMMENT)
  await activateControl(win, '.document-review-compose button[type="submit"]')
  await waitForComment(win, 'draft')
  await activateControl(win, '[aria-label*="to review batch"]')
  await waitForRenderer(
    win,
    `document.querySelector('[aria-label^="Preview review batch with 1 comment"]')`,
    'keyboard comment management did not create the exact batch',
  )

  await activateMode(win, 'source')
  await waitForRenderer(
    win,
    `document.querySelector('.cm-review-marker') && ` +
      `document.querySelectorAll('.document-review-comment').length === 1 && ` +
      `document.querySelector('.cm-content')?.getAttribute('aria-label') === 'Markdown source review'`,
    'source view did not project the rendered anchor with accessible review semantics',
  )

  await host.writeFile(document, `# Shifted before review\n\n${documentContents}`)
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
  const loaded = new Promise<void>((resolveLoaded) =>
    win.webContents.once('did-finish-load', () => resolveLoaded()),
  )
  win.reload()
  await withTimeout(loaded, 'document review renderer reload did not finish')
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

  await activateControl(win, '[aria-label^="Preview review batch with 1 comment"]')
  await waitForExactPreview(win)
  await selectDestination(win, terminals.first.id)
  const body = await preparedBody(win, terminals.first.id)

  // Move focus after preparation; the immutable destination must remain the first PTY.
  await focusProject(win, 'hvir')
  await activateControl(win, '.document-review-delivery-actions button:nth-child(2)')
  const insert = terminals.insertTransport(body)
  await waitForExactCapture(host, captureA, insert)
  if ((await host.readTextFile(captureB)).length !== 0) {
    throw new Error('focus change retargeted the prepared review delivery')
  }
  await waitForRenderer(
    win,
    `document.querySelector('.document-review-delivery')?.textContent?.includes('Review comments remain draft')`,
    'insert did not preserve the draft lifecycle',
  )

  await activateControl(win, '.document-review-delivery header button')
  await activateControl(win, '[aria-label^="Preview review batch with 1 comment"]')
  await selectDestination(win, terminals.first.id)
  const sendBody = await preparedBody(win, terminals.first.id)
  if (sendBody !== body) throw new Error('send-now rebuilt a different review body')
  await activateControl(win, '.document-review-delivery-actions button:nth-child(3)')
  const sentTransport = terminals.sendTransport(body)
  await waitForExactCapture(host, captureA, `${insert}${sentTransport}`)
  await waitForComment(win, 'sent')

  await review.flush()
  const restartedStore = await DocumentReviewStore.load(host, reviewFile)
  try {
    const restarted = restartedStore.read(workspace)
    if (
      restarted.model.comments.length !== 1 ||
      restarted.model.comments[0]?.lifecycle !== 'sent'
    ) {
      throw new Error('application restart reader did not restore the exact review state')
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

  const destroyed = new Promise<void>((resolveDestroyed) =>
    win.webContents.once('destroyed', () => resolveDestroyed()),
  )
  win.destroy()
  await withTimeout(destroyed, 'document review window destruction did not settle')
  await waitForCondition(
    () => !resources.isCurrent(replacementOwner),
    'destroyed renderer retained document review authority',
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
    'tab/project/reload/restart durability · byte-identical preview/insert/send · ' +
    'fixed destination · renderer/PTY cleanup'
  )
}

async function startCaptureTerminals(options: {
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
    const terminal = await supervisor.spawn({
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
    await waitForPtyMarker(supervisor, terminal, readyMarker)
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

async function waitForPtyMarker(
  supervisor: PtySupervisor,
  terminal: Awaited<ReturnType<PtySupervisor['spawn']>>,
  marker: string,
): Promise<void> {
  let output = ''
  let detach: Disposer = () => undefined
  try {
    await withTimeout(
      new Promise<void>((resolveReady) => {
        detach = supervisor.attach(terminal.id, terminal.ownerId, {
          onData: (data) => {
            output = (output + data).slice(-4_096)
            if (output.includes(marker)) resolveReady()
          },
        })
      }),
      `document review PTY capture did not become ready (${terminal.id})`,
    )
  } finally {
    await detach()
  }
}

async function openFixtureAndProveAmbientSelectionIsInert(
  win: BrowserWindow,
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
  const result = (await withTimeout(
    win.webContents.executeJavaScript(`
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
    `),
    'ambient review selection check timed out',
  )) as { readonly ok: boolean; readonly error?: string }
  if (!result.ok) throw new Error(result.error ?? 'ambient review selection failed')
}

async function openFixture(win: BrowserWindow, path: HostPath): Promise<void> {
  const result = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${TIMEOUT_MS};
        const poll = () => {
          const active = document.querySelector('.viewer-tab.active .tab-main')
            ?.getAttribute('title');
          if (active === ${JSON.stringify(path.path)}) return resolve();
          const file = [...document.querySelectorAll('.file-row')].find(
            (candidate) => candidate.getAttribute('title') === ${JSON.stringify(path.path)}
          );
          if (file instanceof HTMLElement) file.click();
          if (Date.now() > deadline) return reject(new Error('review fixture did not open'));
          setTimeout(poll, 25);
        };
        poll();
      }).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error: String(error) })
      )
    `),
    'review fixture open timed out',
  )) as { readonly ok: boolean; readonly error?: string }
  if (!result.ok) throw new Error(result.error ?? 'review fixture did not open')
}

async function activateMode(win: BrowserWindow, mode: 'rendered' | 'source') {
  await withTimeout(
    win.webContents.executeJavaScript(`
      (() => {
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
      })()
    `),
    `${mode} mode selection timed out`,
  )
  await waitForRenderer(
    win,
    `document.querySelector('.mode-control button.active')?.textContent?.trim() === ${JSON.stringify(mode)}`,
    `${mode} mode did not activate from its focused control`,
  )
}

async function focusRenderedBlock(win: BrowserWindow, index: number): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${TIMEOUT_MS};
        const poll = () => {
          const blocks = document.querySelectorAll('.review-block-active');
          const block = blocks.item(${index});
          if (block instanceof HTMLElement) {
            block.focus();
            return resolve();
          }
          if (Date.now() > deadline) return reject(new Error('review block missing'));
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'review block focus timed out',
  )
}

async function selectDestination(win: BrowserWindow, terminalId: string): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      (() => {
        const select = document.querySelector('[aria-label="Review handoff destination"]');
        if (!(select instanceof HTMLSelectElement)) {
          throw new Error('labeled review destination control missing');
        }
        select.focus();
        if (document.activeElement !== select) {
          throw new Error('review destination control was not focusable');
        }
        const setter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          'value'
        )?.set;
        setter?.call(select, ${JSON.stringify(terminalId)});
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()
    `),
    'review destination selection timed out',
  )
  await waitForRenderer(
    win,
    `document.querySelector('[aria-label="Review handoff destination"]')?.value === ${JSON.stringify(terminalId)}`,
    'accessible destination selection did not bind the first terminal',
  )
}

async function preparedBody(win: BrowserWindow, terminalId: string): Promise<string> {
  return (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${TIMEOUT_MS};
        const poll = () => {
          const select = document.querySelector('[aria-label="Review handoff destination"]');
          const preview = document.querySelector('[aria-label="Exact review delivery preview"]');
          const insert = document.querySelector('.document-review-delivery-actions button:nth-child(2)');
          if (
            select?.value === ${JSON.stringify(terminalId)} &&
            preview instanceof HTMLElement &&
            insert instanceof HTMLButtonElement && !insert.disabled
          ) return resolve(preview.textContent || '');
          if (Date.now() > deadline) return reject(new Error('prepared review body missing'));
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'prepared review body timed out',
  )) as string
}

async function waitForExactPreview(win: BrowserWindow): Promise<void> {
  const outcome = (await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const deadline = Date.now() + ${TIMEOUT_MS - 1_000};
        const poll = () => {
          if (document.querySelector('[aria-label="Exact review delivery preview"]')) {
            return resolve({ ok: true });
          }
          const delivery = document.querySelector('.document-review-delivery');
          const alert = delivery?.querySelector('[role="alert"]');
          if (alert) {
            return resolve({ ok: false, error: alert.textContent || 'unknown error' });
          }
          if (Date.now() > deadline) {
            return resolve({
              ok: false,
              error: delivery?.textContent || 'review delivery panel did not open'
            });
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'exact review preview timed out',
  )) as { readonly ok: boolean; readonly error?: string }
  if (!outcome.ok) {
    throw new Error(`exact review preview did not open: ${outcome.error}`)
  }
}

async function waitForComment(
  win: BrowserWindow,
  lifecycle: 'draft' | 'sent',
): Promise<void> {
  await waitForRenderer(
    win,
    `document.querySelectorAll('.document-review-comment').length === 1 && ` +
      `document.querySelector('.document-review-comment .review-${lifecycle}')`,
    `review comment did not restore as ${lifecycle}`,
  )
}

async function ensureReviewMode(win: BrowserWindow): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${TIMEOUT_MS};
        let activated = false;
        const poll = () => {
          if (document.querySelector('[aria-label="Markdown review comments"]')) {
            return resolve();
          }
          const entry = document.querySelector(
            '[aria-label="Enter Markdown review mode"]'
          );
          if (!activated && entry instanceof HTMLButtonElement && !entry.disabled) {
            entry.focus();
            entry.click();
            activated = true;
          }
          if (Date.now() > deadline) {
            return reject(new Error('review mode did not restore for inspection'));
          }
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    'review mode restore timed out',
  )
}

async function switchProject(win: BrowserWindow, displayName: string): Promise<void> {
  await activateProject(win, displayName)
  await waitForRenderer(
    win,
    `document.querySelector('.project-tab.active .project-tab-main strong')?.textContent?.trim() === ${JSON.stringify(displayName)}`,
    `project ${displayName} did not activate from its focused control`,
  )
}

async function activateProject(win: BrowserWindow, displayName: string): Promise<void> {
  await focusProject(win, displayName)
  await withTimeout(
    win.webContents.executeJavaScript(`
      (() => {
        const button = document.activeElement;
        if (!(button instanceof HTMLButtonElement) ||
            button.querySelector('strong')?.textContent?.trim() !== ${JSON.stringify(displayName)}) {
          throw new Error('focused project control changed before activation');
        }
        button.click();
      })()
    `),
    `project ${displayName} activation timed out`,
  )
}

async function focusProject(win: BrowserWindow, displayName: string): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      (() => {
        const button = [...document.querySelectorAll('.project-tab-main')].find(
          (candidate) => candidate.querySelector('strong')?.textContent?.trim() === ${JSON.stringify(displayName)}
        );
        if (!(button instanceof HTMLButtonElement)) throw new Error('project control missing');
        button.focus();
      })()
    `),
    `project ${displayName} focus timed out`,
  )
}

async function activateControl(win: BrowserWindow, selector: string): Promise<void> {
  await focusRenderer(win, selector)
  const result = (await withTimeout(
    win.webContents.executeJavaScript(`
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
    `),
    `review control activation timed out (${selector})`,
  )) as { readonly ok: boolean; readonly error?: string }
  if (!result.ok) {
    throw new Error(`review control activation failed (${selector}): ${result.error}`)
  }
}

async function focusRenderer(win: BrowserWindow, selector: string): Promise<void> {
  const result = (await withTimeout(
    win.webContents.executeJavaScript(`
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
    `),
    `review control focus timed out (${selector})`,
  )) as { readonly ok: boolean; readonly error?: string }
  if (!result.ok) {
    throw new Error(`review control focus failed (${selector}): ${result.error}`)
  }
}

async function dispatchFocusedKey(win: BrowserWindow, key: string): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      (() => {
        const target = document.activeElement;
        if (!(target instanceof HTMLElement)) {
          throw new Error('review keyboard target missing');
        }
        target.dispatchEvent(new KeyboardEvent('keydown', {
          key: ${JSON.stringify(key)},
          bubbles: true,
          cancelable: true
        }));
      })()
    `),
    `review keyboard event timed out (${key})`,
  )
}

async function waitForRenderer(
  win: BrowserWindow,
  expression: string,
  message: string,
): Promise<void> {
  await withTimeout(
    win.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const deadline = Date.now() + ${TIMEOUT_MS};
        const poll = () => {
          if (${expression}) return resolve();
          if (Date.now() > deadline) return reject(new Error(${JSON.stringify(message)}));
          setTimeout(poll, 25);
        };
        poll();
      })
    `),
    message,
  )
}

async function waitForExactCapture(
  host: ProjectHost,
  path: HostPath,
  expected: string,
): Promise<void> {
  await waitForCondition(async () => {
    const captured = await host.readTextFile(path)
    if (Buffer.byteLength(captured) > Buffer.byteLength(expected)) {
      throw new Error('document review PTY captured unexpected extra bytes')
    }
    return captured === expected
  }, 'document review PTY did not capture the exact transport')
}

async function waitForCondition(
  test: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    if (await test()) return
    if (Date.now() > deadline) throw new Error(message)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
  }
}

function selectorString(value: string): string {
  return JSON.stringify(value)
}

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), TIMEOUT_MS)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (reason) => {
        clearTimeout(timer)
        reject(reason instanceof Error ? reason : new Error(String(reason)))
      },
    )
  })
}
