import type { BrowserWindow, WebContents } from 'electron'
import { focusSmokeWindow } from './window-focus'
import { PRESENTATION_COLOR_PATTERN } from '../../shared/presentation/tokens'

/** The actual offline guest exercises ordinary DOM controls under Chromium isolation. */
export async function verifyExtensionPresentationUi(
  win: BrowserWindow,
  guest: WebContents,
  wait: (predicate: () => boolean | Promise<boolean>, label: string) => Promise<void>,
): Promise<void> {
  const query = (script: string): Promise<unknown> => guest.executeJavaScript(script)
  await wait(
    async () =>
      (await query("document.getElementById('catalog-state')?.dataset.state")) ===
      'ready',
    'offline kit catalog',
  )
  await wait(
    async () =>
      (await query("Boolean(document.getElementById('clock-time')?.dateTime)")) === true,
    'guest local clock',
  )
  const renderedTypography = await query(`(() => {
    const body = getComputedStyle(document.body), mono = getComputedStyle(document.querySelector('pre'));
    return body.fontFamily.includes('A'.repeat(100)) && Math.abs(parseFloat(body.fontSize) - 14.3) < 0.05 && mono.fontFamily.includes('ui-monospace');
  })()`)
  if (renderedTypography !== true)
    throw new Error('Guest kit did not render host font/scale/monospace presentation')
  const accent = (await win.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--accent');
    root.style.setProperty('--accent', 'color-mix(in srgb, var(--text) 40%, var(--accent-soft))');
    const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; root.append(probe);
    const resolved = getComputedStyle(probe).color; probe.remove();
    return {previous, resolved};
  })()`)) as { previous: string; resolved: string }
  const originalSize = win.getContentSize()
  try {
    win.setContentSize(originalSize[0]! + 1, originalSize[1]!)
    await wait(
      async () =>
        (await query("document.documentElement.style.getPropertyValue('--accent')")) ===
        accent.resolved,
      'resolved color-mix and aliases through public presentation',
    )
    if (!PRESENTATION_COLOR_PATTERN.test(accent.resolved))
      throw new Error('Resolved color is outside the guest-safe vocabulary')
  } finally {
    await win.webContents.executeJavaScript(
      `document.documentElement.style.setProperty('--accent', ${JSON.stringify(accent.previous)})`,
    )
    win.setContentSize(originalSize[0]!, originalSize[1]!)
  }
  const labels = await query(`(() => {
    const search = document.getElementById('catalog-search');
    return search.labels.length === 1 && search.labels[0].textContent.includes('Search examples') && document.getElementById('catalog-list').getAttribute('aria-label') === 'Examples';
  })()`)
  if (labels !== true) throw new Error('Guest kit controls lack ordinary labels')
  await focusSmokeWindow(win)
  guest.focus()
  const point = (await query(
    `(() => { const row = document.querySelector('#catalog-list button'); row.scrollIntoView({block:'center'}); const rect = row.getBoundingClientRect(); return {x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)}; })()`,
  )) as { x: number; y: number }
  guest.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  guest.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  guest.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
  guest.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
  await wait(
    async () =>
      (await query(`(() => {
    const rows = [...document.querySelectorAll('#catalog-list button')];
    return document.hasFocus() && document.activeElement === rows[1] && rows[1].getAttribute('aria-selected') === 'true' && rows[1].matches(':focus-visible') && getComputedStyle(rows[1]).outlineStyle !== 'none' && document.getElementById('catalog-detail').textContent.includes('clock');
  })()`)) === true,
    'native guest list keyboard and visible focus',
  )
  await query(`(() => {
    const search = document.getElementById('catalog-search');
    search.value = 'no matching example'; search.dispatchEvent(new Event('input', {bubbles:true}));
  })()`)
  if (
    (await query(
      "document.getElementById('catalog-state').dataset.state === 'empty' && document.querySelectorAll('#catalog-list button').length === 0",
    )) !== true
  )
    throw new Error('Guest kit empty search is misleading')
  await query(`(() => {
    const search = document.getElementById('catalog-search');
    search.value = ''; search.dispatchEvent(new Event('input', {bubbles:true}));
  })()`)
  // Failure at the guest's own fetch boundary leaves no stale results or host authority.
  await query(`(() => {
    window.smokeOriginalFetch = window.fetch;
    window.fetch = () => Promise.reject(new Error('Examples unavailable in acceptance fixture'));
    document.getElementById('catalog-reload').click();
  })()`)
  await wait(
    async () =>
      (await query("document.getElementById('catalog-state').dataset.state")) === 'error',
    'guest kit error state',
  )
  await query(
    "document.getElementById('catalog-search').dispatchEvent(new Event('input', {bubbles:true}))",
  )
  if (
    (await query(
      "document.getElementById('catalog-state').dataset.state === 'error' && document.querySelectorAll('#catalog-list button').length === 0",
    )) !== true
  )
    throw new Error('Guest search restored stale results after a failed load')
  await query(
    "window.fetch = window.smokeOriginalFetch; delete window.smokeOriginalFetch; document.getElementById('catalog-reload').click()",
  )
  await wait(
    async () =>
      (await query("document.getElementById('catalog-state').dataset.state")) === 'ready',
    'guest kit retry',
  )
  const size = win.getContentSize()
  try {
    win.setContentSize(600, 650)
    await wait(
      async () =>
        (await query(`(() => {
      const layout = document.querySelector('.hvir-list-detail');
      return innerWidth <= 420 && document.documentElement.scrollWidth <= innerWidth && getComputedStyle(layout).gridTemplateColumns.split(' ').length === 1;
    })()`)) === true,
      'narrow guest list/detail without horizontal overflow',
    )
  } finally {
    win.setContentSize(size[0]!, size[1]!)
  }
  console.log(
    '[smoke] offline guest kit labeled search/list/detail, native keyboard/focus, empty/error/retry and narrow viewport OK',
  )
}
