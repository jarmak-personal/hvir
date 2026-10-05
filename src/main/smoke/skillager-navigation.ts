import type { BrowserWindow, WebContents } from 'electron'
import type { HostPath } from '../../shared/host-path'
import { joinHostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { captureExtensionVisuals } from './extension-visuals'

interface NavigationControls {
  click(name: string): Promise<void>
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
  within<T>(work: Promise<T>): Promise<T>
  select(): Promise<void>
}

/** Actual accepted passive mask pixels, selection and package-local replacement lifecycle. */
export async function verifySkillagerNavigation(
  win: BrowserWindow,
  guest: WebContents,
  host: ProjectHost,
  controls: NavigationControls,
): Promise<void> {
  const painted = (): Promise<unknown> => navigationPaint(win, controls)
  await painted()
  win.webContents.focus()
  await controls.within(
    win.webContents.executeJavaScript(
      "[...document.querySelectorAll('.rail-nav button')].find(item=>item.textContent==='Skills in this project').focus()",
    ),
  )
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' })
  await controls.wait(
    async () =>
      (await controls.within(
        win.webContents.executeJavaScript(`(() => {
    const button=[...document.querySelectorAll('.rail-nav button')].find(item=>item.textContent==='Skills in this project');
    return document.activeElement===button&&button.matches(':focus-visible')&&button.getAttribute('aria-current')==='page';
  })()`),
      )) === true,
    'actual keyboard focus/activation retains named project navigation',
  )
  await captureExtensionVisuals(
    win,
    guest,
    host,
    'project',
    { ...controls, painted },
    process.env.HVIR_SKILLAGER_NAVIGATION_PROOF,
  )
  console.log('[smoke] accepted package-owned project navigation pixels/selection OK')
}

async function navigationPaint(
  win: BrowserWindow,
  controls: NavigationControls,
): Promise<unknown> {
  const facts = (await controls.within(
    win.webContents.executeJavaScript(`(() => {
    const button=[...document.querySelectorAll('.rail-nav button')].find(item=>item.textContent==='Skills in this project');
    const image=button?.querySelector('.extension-navigation-icon'), r=image?.getBoundingClientRect(), b=button?.getBoundingClientRect();
    if(!image?.checkVisibility()||!r||!b||r.width<=0||r.height<=0||r.left<b.left||r.right>b.right||r.bottom>b.bottom||button.getAttribute('aria-current')!=='page')throw new Error('Selected package icon is not visible and contained');
    if(!getComputedStyle(image).maskImage.startsWith('url("data:image/svg+xml;base64,')||image.querySelector('svg'))throw new Error('Navigation is not a passive accepted image');
    if([...document.querySelectorAll('.extension-terminal-item')].some(item=>item.title.includes('Skillager')))throw new Error('Skillager retained its terminal shortcut');
    return {selected:true,passive:true,label:button.textContent,theme:document.documentElement.dataset.theme,rect:{x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}};
  })()`),
  )) as {
    selected: boolean
    passive: boolean
    label: string
    theme: string
    rect: Electron.Rectangle
  }
  // Selected accepted-mask geometry is ready; now settle its actual compositor frame.
  await controls.within(
    win.webContents.executeJavaScript(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    ),
  )
  const image = await controls.within(win.webContents.capturePage(facts.rect))
  const bitmap = image.toBitmap(),
    colors = new Set<string>()
  for (let index = 0; index < bitmap.length; index += 4)
    colors.add(
      `${bitmap[index]},${bitmap[index + 1]},${bitmap[index + 2]},${bitmap[index + 3]}`,
    )
  if (colors.size < 3) {
    console.log(
      '[smoke] navigation paint failure facts',
      JSON.stringify({
        ...facts,
        distinctPixelColors: colors.size,
        bitmapBytes: bitmap.byteLength,
        native: {
          visible: win.isVisible(),
          focused: win.isFocused(),
          minimized: win.isMinimized(),
        },
      }),
    )
    throw new Error('Actual project SVG has no visible painted geometry')
  }
  return { ...facts, distinctPixelColors: colors.size, bitmapBytes: bitmap.byteLength }
}

/** Mutate only the owned copied package; each change is explicitly accepted through Settings. */
export async function verifySkillagerNavigationFallback(
  win: BrowserWindow,
  host: ProjectHost,
  directory: HostPath,
  controls: NavigationControls & {
    packageClick(name: string): Promise<void>
    disabled(): boolean
    revision(): string | undefined
  },
): Promise<void> {
  const asset = joinHostPath(directory, 'skillager.svg'),
    original = await host.readFile(asset)
  const debuggerPort = win.webContents.debugger,
    owned = !debuggerPort.isAttached()
  let externalRequests = 0
  const network = (_event: Electron.Event, method: string, params: unknown): void => {
    if (
      method !== 'Network.requestWillBeSent' ||
      !params ||
      typeof params !== 'object' ||
      !('request' in params)
    )
      return
    const request = params.request
    if (
      request &&
      typeof request === 'object' &&
      'url' in request &&
      typeof request.url === 'string' &&
      request.url.includes('hvir-navigation-invalid.example')
    )
      externalRequests++
  }
  if (owned) debuggerPort.attach('1.3')
  debuggerPort.on('message', network)
  let workflowFailed = false,
    failure: unknown
  try {
    await controls.within(debuggerPort.sendCommand('Network.enable'))
    await host.writeFile(
      asset,
      '<svg viewBox="0 0 20 20"><script>globalThis.__hvirUnsafeNavigationExecuted=true</script><image href="https://hvir-navigation-invalid.example/icon"/></svg>',
    )
    await reload()
    await controls.click('Open settings')
    await controls.click('Extensions')
    await controls.wait(
      async () =>
        (await controls.within(
          win.webContents.executeJavaScript(
            "[...document.querySelectorAll('.extension-installation')].some(item=>item.querySelector('h4')?.textContent==='Skillager'&&item.textContent.includes('text navigation remains available'))",
          ),
        )) === true,
      'accepted bad optional asset reports text fallback warning',
    )
    await controls.click('Close settings')
    await controls.select()
    await controls.wait(
      async () =>
        (await controls.within(
          win.webContents.executeJavaScript(`(() => {
      const button=[...document.querySelectorAll('.rail-nav button')].find(item=>item.textContent==='Skills in this project');
      return button?.getAttribute('aria-current')==='page'&&!button.querySelector('.extension-navigation-icon')&&!button.disabled;
    })()`),
        )) === true,
      'bad optional icon retains usable text navigation',
    )
    if (
      (await controls.within(
        win.webContents.executeJavaScript(
          'globalThis.__hvirUnsafeNavigationExecuted===true',
        ),
      )) === true ||
      externalRequests
    )
      throw new Error('Rejected navigation image executed or loaded external data')
    await host.writeFile(asset, original)
    await reload()
    await controls.select()
    await navigationPaint(win, controls)
    await controls.click('Open settings')
    await controls.click('Extensions')
    await controls.packageClick('Disable')
    await controls.wait(
      () => controls.disabled(),
      'accepted navigation activation disabled',
    )
    await controls.click('Close settings')
    await controls.wait(
      async () =>
        (await controls.within(
          win.webContents.executeJavaScript(
            "![...document.querySelectorAll('.rail-nav button')].some(item=>item.textContent==='Skills in this project')",
          ),
        )) === true,
      'Disable retires accepted navigation image and label',
    )
    console.log(
      '[smoke] invalid optional SVG text fallback/nonexecution/no external request; accepted replacement and Disable retirement OK',
    )
  } catch (error) {
    workflowFailed = true
    failure = error
  } finally {
    debuggerPort.removeListener('message', network)
    try {
      if (debuggerPort.isAttached())
        await controls.within(debuggerPort.sendCommand('Network.disable'))
      if (owned && debuggerPort.isAttached()) debuggerPort.detach()
      await host.writeFile(asset, original)
    } catch (error) {
      if (!workflowFailed) {
        workflowFailed = true
        failure = error
      }
    }
  }
  if (workflowFailed) throw failure
  async function reload(): Promise<void> {
    const before = controls.revision()
    await controls.click('Open settings')
    await controls.click('Extensions')
    await controls.packageClick('Reload')
    await controls.wait(
      () => !!controls.revision() && controls.revision() !== before,
      'explicitly accepted new navigation revision',
    )
    await controls.click('Close settings')
  }
}
