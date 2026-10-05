import type { BrowserWindow, WebContents } from 'electron'
import { focusSmokeWindow } from './window-focus'
import { joinHostPath, localPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'

interface SearchPorts {
  inspect(expression: string): Promise<unknown>
  wait(predicate: () => Promise<boolean>, label: string): Promise<void>
  within<T>(work: Promise<T>): Promise<T>
  current(): boolean
  observeNative?(facts: unknown): void
  revokeProgram?(): Promise<void>
}

async function acquireSearchForeground(win: BrowserWindow): Promise<void> {
  if (!win.isVisible() || !win.isFocused() || win.isMinimized())
    await focusSmokeWindow(win, 'window')
  if (!win.isVisible() || !win.isFocused() || win.isMinimized())
    throw new Error('Owned Search window is not in the foreground')
}

/** The reported first caret gesture, before query input or library initialization. */
export async function inspectSkillagerCaret(
  win: BrowserWindow,
  guest: WebContents,
  host: ProjectHost,
  ports: SearchPorts,
  state: 'unapproved' | 'uninitialized',
): Promise<void> {
  const root = process.env.HVIR_SKILLAGER_SEARCH_PROOF
  if (!root?.startsWith('/') || root === '/')
    throw new Error('Select an owned caret proof directory')
  const output = localPath(`${root}-caret-${state}`),
    original = guest.getURL()
  await host.createDirectoryExclusive(output, { mode: 0o755 })
  let failed = false,
    failure: unknown,
    facts: unknown
  try {
    await acquireSearchForeground(win)
    await ports.inspect(`(() => {
      globalThis.__hvirCaret={clicks:0,trusted:false};
      globalThis.__hvirCaretObserver=event=>{if(event.target.closest?.('.search-options > summary')){globalThis.__hvirCaret.clicks++;globalThis.__hvirCaret.trusted=event.isTrusted}};
      document.addEventListener('click',globalThis.__hvirCaretObserver,true);
    })()`)
    const before = await embeddingFacts(win, guest, ports)
    const point = (await ports.inspect(`(() => {
      const summary=document.querySelector('.search-options > summary');
      if(!summary?.checkVisibility()||summary.parentElement.open)throw new Error('First caret is not available');
      summary.scrollIntoView({block:'center'});const r=summary.getBoundingClientRect();return{x:Math.round(r.x+5),y:Math.round(r.y+r.height/2)};
    })()`)) as { x: number; y: number }
    guest.focus()
    guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await ports.wait(
      async () =>
        (await ports.inspect(
          `globalThis.__hvirCaret.clicks===1&&globalThis.__hvirCaret.trusted&&document.querySelector('.search-options').open&&document.getElementById('state').dataset.state===${JSON.stringify(state === 'unapproved' ? 'error' : 'empty')}`,
        )) === true,
      `actual first caret retains ${state} library`,
    )
    await ports.inspect(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    )
    await ports.within(
      win.webContents.executeJavaScript(
        'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
      ),
    )
    if (
      (await ports.inspect(
        "document.querySelector('.search-options').open&&document.getElementById('include-installed').checkVisibility()",
      )) !== true
    )
      throw new Error('Caret expansion did not remain visible after actual paint')
    const after = (await embeddingFacts(win, guest, ports)) as {
      visible: boolean
      paneHidden: boolean
    }
    const explanation = (await ports.inspect(
      `({settings:document.getElementById('state').textContent.includes('Settings'),emptyLibrary:document.getElementById('state').textContent.includes('library is empty'),manageVisible:document.getElementById('manage').checkVisibility(),manageEnabled:!document.getElementById('manage').disabled,summaryOpen:document.querySelector('.search-options').open,...globalThis.__hvirCaret})`,
    )) as {
      settings: boolean
      emptyLibrary: boolean
      manageVisible: boolean
      manageEnabled: boolean
    }
    if (
      !after.visible ||
      after.paneHidden ||
      guest.getURL() !== original ||
      !ports.current() ||
      (state === 'unapproved'
        ? !explanation.settings
        : !explanation.emptyLibrary ||
          !explanation.manageVisible ||
          !explanation.manageEnabled)
    )
      throw new Error('Caret lost the live library or existing access/setup controls')
    facts = { state, before, after, explanation, sameUrl: true, current: true }
    await host.writeFile(
      joinHostPath(output, 'workbench.png'),
      (await ports.within(win.webContents.capturePage())).toPNG(),
    )
    await host.writeFile(
      joinHostPath(output, 'guest.png'),
      (await ports.within(guest.capturePage())).toPNG(),
    )
  } catch (error) {
    failed = true
    failure = error
  } finally {
    await ports
      .inspect(
        "document.removeEventListener('click',globalThis.__hvirCaretObserver,true);delete globalThis.__hvirCaretObserver;delete globalThis.__hvirCaret",
      )
      .catch(() => undefined)
    try {
      await host.writeFile(
        joinHostPath(output, 'proof.json'),
        JSON.stringify({ schema: 1, passed: !failed, facts }),
      )
    } catch (error) {
      if (!failed) {
        failed = true
        failure = error
      }
    }
  }
  if (failed) throw failure
}

async function embeddingFacts(
  win: BrowserWindow,
  guest: WebContents,
  ports: SearchPorts,
): Promise<unknown> {
  return ports.within(
    win.webContents.executeJavaScript(`(() => {
      const element=[...document.querySelectorAll('webview')].find(item=>item.getWebContentsId()===${guest.id});
      const pane=element?.closest('[data-extension-view]'),r=element?.getBoundingClientRect();
      const hit=r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {focused:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement===element?'guest':'other',present:!!element,paneHidden:pane?.hidden??null,visible:element?.checkVisibility()??false,centerHit:hit===element,bounds:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};
    })()`),
  )
}

/** Observe actual Chromium form defaults without cancelling or replacing their events. */
export async function inspectSkillagerSearch(
  win: BrowserWindow,
  guest: WebContents,
  host: ProjectHost,
  ports: SearchPorts,
): Promise<void> {
  const output = process.env.HVIR_SKILLAGER_SEARCH_PROOF
  if (!output) return
  if (!output.startsWith('/') || output === '/')
    throw new Error('Select an absolute owned search-proof directory')
  const original = guest.getURL()
  const events = {
    navigationAttempts: 0,
    committedNavigations: 0,
    loadFailures: 0,
    consoleMessages: 0,
  }
  const attempted = (): void => {
    events.navigationAttempts++
  }
  const committed = (): void => {
    events.committedNavigations++
  }
  const failed = (): void => {
    events.loadFailures++
  }
  const consoleMessage = (): void => {
    events.consoleMessages++
  }
  await host.createDirectoryExclusive(localPath(output), { mode: 0o755 })
  guest.on('will-navigate', attempted)
  guest.on('did-navigate', committed)
  guest.on('did-fail-load', failed)
  guest.on('console-message', consoleMessage)
  const cases: unknown[] = []
  const nativeFacts: unknown[] = []
  let failureState: unknown
  let captureOutcome: 'not-attempted' | 'available' | 'unavailable' = 'not-attempted'
  ports = { ...ports, observeNative: (facts) => nativeFacts.push(facts) }
  const focusFacts: unknown[] = []
  const focusSnapshot = async (): Promise<unknown> => ({
    windowVisible: win.isVisible(),
    windowFocused: win.isFocused(),
    guestFocused: guest.isFocused(),
    document: await ports.inspect(
      "({focused:document.hasFocus(),visibility:document.visibilityState,inputFocused:document.activeElement===document.getElementById('query'),width:innerWidth,height:innerHeight})",
    ),
    embedding: await embeddingFacts(win, guest, ports),
  })
  let workflowFailed = false
  let failure: unknown
  try {
    await ports.inspect(`(() => {
      const form=document.getElementById('search-form');
      globalThis.__hvirSearchProof={submissions:0,enterDown:0,enterPress:0};
      globalThis.__hvirSearchKeyObserver=event=>{if(event.key==='Enter')globalThis.__hvirSearchProof[event.type==='keydown'?'enterDown':'enterPress']++};
      form.addEventListener('keydown',globalThis.__hvirSearchKeyObserver,true);
      form.addEventListener('keypress',globalThis.__hvirSearchKeyObserver,true);
      globalThis.__hvirSearchObserver=()=>{globalThis.__hvirSearchProof.submissions++};
      form.addEventListener('submit',globalThis.__hvirSearchObserver,true);
    })()`)
    for (const [index, mode] of [
      'button-empty',
      'button-no-match',
      'enter-empty',
    ].entries()) {
      const before = (await ports.inspect(
        'globalThis.__hvirSearchProof.submissions',
      )) as number
      await ports.inspect(`(() => {
        const input=document.getElementById('query'); input.value=${JSON.stringify(mode === 'button-no-match' ? 'hvir-owned-search-no-match-930' : '')};
        input.focus();

      })()`)
      focusFacts.push({ stage: 'before', facts: await focusSnapshot() })
      await submitSkillagerSearch(
        win,
        guest,
        ports,
        mode.startsWith('button') ? 'button' : 'enter',
      )
      focusFacts.push({ stage: 'after', facts: await focusSnapshot() })
      await ports.wait(
        async () =>
          (await ports.inspect(
            `globalThis.__hvirSearchProof.submissions>${before} && document.getElementById('state')?.dataset.state===${JSON.stringify(mode === 'button-no-match' ? 'empty' : 'ready')} && document.querySelectorAll('#skills [role=option]').length===${mode === 'button-no-match' ? 0 : 100}`,
          )) === true,
        `actual library ${mode} submission`,
      )
      const state = await ports.inspect(`(() => {
        const status=document.getElementById('state');
        return {state:['ready','empty','error','stale','loading'].includes(status?.dataset.state)?status.dataset.state:'missing',rows:document.querySelectorAll('#skills [role=option]').length,form:!!document.getElementById('search-form'),...globalThis.__hvirSearchProof};
      })()`)
      cases.push({
        mode,
        state,
        sameUrl: guest.getURL() === original,
        current: ports.current(),
        events: { ...events },
      })
      await host.writeFile(
        localPath(`${output}/${index}-${mode}.png`),
        (await ports.within(guest.capturePage())).toPNG(),
      )
      if (guest.getURL() !== original || !ports.current())
        throw new Error('Actual library Search lost its original guest')
    }
    // Keep physical minimize independent of a preceding hide/show transition.
    for (const mode of ['minimize', 'hide'] as const) {
      const nativeEvents = {
        minimize: 0,
        blur: 0,
        restore: 0,
        show: 0,
        focus: 0,
        hide: 0,
      }
      let resolveMinimize!: () => void
      const physicalMinimize = new Promise<void>((resolve) => {
        resolveMinimize = resolve
      })
      const minimized = (): void => {
        nativeEvents.minimize++
        resolveMinimize()
      }
      const blurred = (): void => {
        nativeEvents.blur++
      }
      const restored = (): void => {
        nativeEvents.restore++
      }
      const shown = (): void => {
        nativeEvents.show++
      }
      const focused = (): void => {
        nativeEvents.focus++
      }
      const hidden = (): void => {
        nativeEvents.hide++
      }
      win.on('show', shown)
      win.on('focus', focused)
      win.on('hide', hidden)
      win.on('minimize', minimized)
      win.on('blur', blurred)
      win.on('restore', restored)
      const nativeState = (): unknown => ({
        visible: win.isVisible(),
        focused: win.isFocused(),
        minimized: win.isMinimized(),
        minimizable: win.isMinimizable(),
        fullScreen: win.isFullScreen(),
        simpleFullScreen: win.isSimpleFullScreen(),
        events: { ...nativeEvents },
      })
      let lastNative: unknown = nativeState()
      let submitted = false,
        restorationCompleted = false
      const received = (
        _event: Electron.Event,
        channel: string,
        message: unknown,
      ): void => {
        if (
          channel === 'extension-guest:message' &&
          message &&
          typeof message === 'object' &&
          'id' in message &&
          message.id === 'native-background-930'
        )
          submitted = true
      }
      guest.on('ipc-message', received)
      await ports.inspect(`(() => {
        globalThis.__hvirBackgroundOutcome='pending';
        globalThis.__hvirBackgroundStop=window.hvirExtension.onMessage(message=>{
          if(message.kind==='result'&&message.id==='native-background-930')globalThis.__hvirBackgroundOutcome=message.ok?'allowed':'refused';
        });
      })()`)
      try {
        if (mode === 'hide') win.hide()
        else win.minimize()
        lastNative = nativeState()
        console.log(
          '[smoke] native background action dispatched',
          JSON.stringify({ mode, state: lastNative }),
        )
        if (mode === 'minimize') await ports.within(physicalMinimize)
        await ports.wait(async () => {
          const foreground: unknown = await ports.within(
            win.webContents.executeJavaScript(
              "window.hvir.invoke('extensions:foreground',undefined)",
            ),
          )
          lastNative = { foreground, state: nativeState() }
          return foreground === false
        }, `actual native ${mode} withdraws foreground`)
        await ports.inspect(
          "window.hvirExtension.send({kind:'request',id:'native-background-930',capability:'source.status'});void 0",
        )
        await ports.wait(
          async () =>
            submitted &&
            (await ports.within(
              win.webContents.executeJavaScript(
                "window.hvir.invoke('extensions:foreground',undefined)",
              ),
            )) === false,
          `source request physically received while ${mode}`,
        )
        win.restore()
        win.show()
        await acquireSearchForeground(win)
        restorationCompleted = true
        await ports.wait(
          async () =>
            (await ports.inspect("globalThis.__hvirBackgroundOutcome==='refused'")) ===
            true,
          `actual background ${mode} source request refused`,
        )
        await ports.wait(async () => {
          const facts = (await embeddingFacts(win, guest, ports)) as {
            paneHidden: boolean
            visible: boolean
          }
          return !facts.paneHidden && facts.visible
        }, `same library restored after ${mode}`)
        cases.push({
          mode,
          outcome: 'refused',
          sameUrl: guest.getURL() === original,
          current: ports.current(),
          native: lastNative,
        })
      } catch (error) {
        cases.push({
          mode,
          outcome: 'failed',
          native: lastNative,
          finalNativeBeforeRestore: nativeState(),
        })
        throw error
      } finally {
        win.removeListener('show', shown)
        win.removeListener('focus', focused)
        win.removeListener('hide', hidden)
        win.removeListener('minimize', minimized)
        win.removeListener('blur', blurred)
        win.removeListener('restore', restored)
        guest.removeListener('ipc-message', received)
        if (!restorationCompleted) {
          win.restore()
          win.show()
        }
        await ports
          .inspect(
            'globalThis.__hvirBackgroundStop();delete globalThis.__hvirBackgroundStop;delete globalThis.__hvirBackgroundOutcome',
          )
          .catch(() => undefined)
      }
    }
    if (!ports.revokeProgram)
      throw new Error('Owned Search proof needs ordinary program revocation')
    await ports.revokeProgram()
    await submitSkillagerSearch(win, guest, ports, 'button')
    await ports.wait(
      async () =>
        (await ports.inspect(
          "document.getElementById('state').dataset.state==='stale' && document.getElementById('state').textContent.includes('Settings') && document.getElementById('state').textContent.includes('freshness unavailable') && document.querySelectorAll('#skills [role=option]').length===100",
        )) === true,
      'unapproved Search explains access and retains the current rows',
    )
    cases.push({
      mode: 'unapproved',
      state: 'stale',
      rows: 100,
      actionableSettings: true,
      sameUrl: guest.getURL() === original,
      current: ports.current(),
    })
    await host.writeFile(
      localPath(`${output}/unapproved-retained.png`),
      (await ports.within(guest.capturePage())).toPNG(),
    )
  } catch (error) {
    workflowFailed = true
    failure = error
    failureState = await ports
      .inspect(
        `(() => {
      const form=document.getElementById('search-form'), active=document.activeElement;
      return {form:!!form,formVisible:!!form?.checkVisibility(),state:['ready','empty','error','stale','loading'].includes(document.getElementById('state')?.dataset.state)?document.getElementById('state').dataset.state:'missing',rows:document.querySelectorAll('#skills [role=option]').length,
        active:active?.id==='query'?'query':active?.matches('#search-form button[type=submit]')?'search':'other',...globalThis.__hvirSearchProof};
    })()`,
      )
      .catch(() => null)
    await ports
      .within(
        host.writeFile(
          localPath(`${output}/failure-facts.json`),
          JSON.stringify({
            schema: 1,
            nativeFacts,
            failureState,
            events,
            captureOutcome,
          }),
        ),
      )
      .catch(() => undefined)
    if (!guest.isDestroyed()) {
      try {
        const captured = await ports.within(guest.capturePage())
        await ports.within(
          host.writeFile(localPath(`${output}/failure.png`), captured.toPNG()),
        )
        captureOutcome = 'available'
      } catch {
        captureOutcome = 'unavailable'
      }
    }
    try {
      const parent = await ports.within(win.webContents.capturePage())
      await ports.within(
        host.writeFile(localPath(`${output}/failure-workbench.png`), parent.toPNG()),
      )
    } catch {
      /* Original workflow and guest capture outcome remain authoritative. */
    }
    focusFacts.push({
      stage: 'failure',
      facts: await focusSnapshot().catch(() => null),
    })
  } finally {
    guest.removeListener('will-navigate', attempted)
    guest.removeListener('did-navigate', committed)
    guest.removeListener('did-fail-load', failed)
    guest.removeListener('console-message', consoleMessage)
    if (!guest.isDestroyed())
      await ports
        .inspect(
          "document.getElementById('search-form')?.removeEventListener('submit',globalThis.__hvirSearchObserver,true);for(const type of ['keydown','keypress'])document.getElementById('search-form')?.removeEventListener(type,globalThis.__hvirSearchKeyObserver,true);delete globalThis.__hvirSearchObserver;delete globalThis.__hvirSearchKeyObserver;delete globalThis.__hvirSearchProof",
        )
        .catch(() => undefined)
    try {
      await host.writeFile(
        localPath(`${output}/proof.json`),
        JSON.stringify({
          schema: 1,
          cases,
          nativeFacts,
          failureState,
          captureOutcome,
          focusFacts,
          events,
          originalGuestCurrent:
            !guest.isDestroyed() && guest.getURL() === original && ports.current(),
        }),
      )
    } catch (error) {
      if (!workflowFailed) {
        workflowFailed = true
        failure = error
      }
    }
  }
  if (workflowFailed) throw failure
}

/** Actual Chromium input/default submission shared by normal capacity and diagnostic proof. */
export async function submitSkillagerSearch(
  win: BrowserWindow,
  guest: WebContents,
  ports: SearchPorts,
  mode: 'button' | 'enter',
): Promise<void> {
  await acquireSearchForeground(win)
  guest.focus()
  const click = async (selector: string): Promise<void> => {
    const point = (await ports.inspect(`(() => {
      const control=document.querySelector(${JSON.stringify(selector)});
      if(!control?.checkVisibility()||control.disabled)throw new Error('Search control is not available');
      control.scrollIntoView({block:'center'});const r=control.getBoundingClientRect();
      const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      if(x<=0||y<=0||x>=innerWidth||y>=innerHeight)throw new Error('Search control is outside its guest');
      return {x,y};
    })()`)) as { x: number; y: number }
    ports.observeNative?.({
      requested: selector === '#query' ? 'query' : 'search',
      point,
      embeddingBefore: await embeddingFacts(win, guest, ports),
    })
    guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    ports.observeNative?.({
      requested: selector === '#query' ? 'query' : 'search',
      embeddingAfter: await embeddingFacts(win, guest, ports),
    })
  }
  await ports.inspect(`(() => {
    globalThis.__hvirNativeSearchSubmitted=false;
    globalThis.__hvirNativeSearchFacts={mouseDown:0,mouseUp:0,click:0,submit:0,lastTarget:'none',isTrusted:false};
    globalThis.__hvirNativeSearchPointer=event=>{
      const f=globalThis.__hvirNativeSearchFacts;
      f[event.type==='mousedown'?'mouseDown':event.type==='mouseup'?'mouseUp':'click']++;
      f.lastTarget=event.target.id==='query'?'query':event.target.closest?.('#search-form button[type=submit]')?'search':'other';f.isTrusted=event.isTrusted;f.lastPoint={x:event.clientX,y:event.clientY};
    };
    for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,globalThis.__hvirNativeSearchPointer,true);
    globalThis.__hvirNativeSearchObserver=event=>{globalThis.__hvirNativeSearchFacts.submit++;queueMicrotask(()=>{globalThis.__hvirNativeSearchSubmitted=event.defaultPrevented})};
    document.getElementById('search-form').addEventListener('submit',globalThis.__hvirNativeSearchObserver,{once:true});
  })()`)
  try {
    await click('#query')
    await ports.wait(
      async () =>
        ports.current() &&
        (await ports.inspect(
          "document.hasFocus() && document.activeElement===document.getElementById('query')",
        )) === true,
      'actual owned Search input native focus',
    )
    if (!ports.current()) throw new Error('Search guest ended before native submission')
    if (mode === 'button') await click('#search-form button[type=submit]')
    else {
      guest.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      guest.sendInputEvent({ type: 'char', keyCode: '\r' })
      guest.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    }
    await ports.wait(
      async () =>
        ports.current() &&
        (await ports.inspect('globalThis.__hvirNativeSearchSubmitted===true')) === true,
      `actual ${mode} Search submitted with default cancelled`,
    )
  } finally {
    if (!guest.isDestroyed()) {
      const facts = await ports
        .inspect(
          `({mode:${JSON.stringify(mode)},defaultCancelled:globalThis.__hvirNativeSearchSubmitted,...globalThis.__hvirNativeSearchFacts})`,
        )
        .catch(() => null)
      ports.observeNative?.({
        facts,
        embeddingFinal: await embeddingFacts(win, guest, ports).catch(() => null),
      })
      await ports
        .inspect(
          "document.getElementById('search-form')?.removeEventListener('submit',globalThis.__hvirNativeSearchObserver);for(const type of ['mousedown','mouseup','click'])document.removeEventListener(type,globalThis.__hvirNativeSearchPointer,true);delete globalThis.__hvirNativeSearchSubmitted;delete globalThis.__hvirNativeSearchObserver;delete globalThis.__hvirNativeSearchFacts;delete globalThis.__hvirNativeSearchPointer",
        )
        .catch(() => undefined)
    }
  }
}
