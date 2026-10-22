import type { WebContents } from 'electron'
interface SourceControls {
  inspect(this: void, expression: string): Promise<unknown>
  ready(this: void, predicate: () => Promise<boolean>, label: string): Promise<void>
  capture(expanded: boolean): Promise<void>
  metadataOnly(stage: string): Promise<void>
}
/** Real public source summaries and bounded source pages, without loading the whole catalog. */
export async function verifySkillagerSourceBrowsing(
  guest: WebContents,
  controls: SourceControls,
  expectedTotal: number,
): Promise<void> {
  const { inspect, ready } = controls
  async function capture(expanded: boolean): Promise<void> {
    await controls.capture(expanded)
    // Appearance capture restores Settings last; wait for that real show/paint and
    // its ordinary metadata renewal before sending input to the returned guest.
    await inspect(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    )
    await ready(
      async () =>
        (await inspect(
          `document.getElementById('state').dataset.state==='ready' && ${expanded ? "document.querySelectorAll('#skills [data-skill-select]').length>0 && !document.querySelector('#skills [aria-busy=true]')" : "document.querySelectorAll('#skills [data-source-toggle]').length>0"}`,
        )) === true,
      'source browser usable after appearance restoration',
    )
  }
  await inspect(`(() => {
    for (const button of document.querySelectorAll('#skills [data-source-toggle][aria-expanded=true]')) button.click();
  })()`)
  await ready(
    async () =>
      (await inspect(`
    document.getElementById('state').dataset.state==='ready' &&
    document.getElementById('state').textContent.startsWith('${expectedTotal} skills') &&
    document.querySelectorAll('#skills [data-source-toggle]').length>0 &&
    document.querySelectorAll('#skills [data-skill-select]').length===0`)) === true,
    'whole-library source counts with every group collapsed',
  )
  await capture(false)
  guest.focus()
  const source = (await inspect(`(() => {
    const buttons=[...document.querySelectorAll('#skills [data-source-toggle]')];
    const button=buttons.find(node=>Number(node.querySelector('small').textContent)>100)??buttons.at(-1);
    button.focus(); return {id:button.dataset.sourceToggle,count:Number(button.querySelector('small').textContent)};
  })()`)) as { id: string; count: number }
  const group = `document.querySelector('[data-source-toggle="${source.id}"]')`,
    body = `${group}.nextElementSibling`
  await inspect(`(() => {
    globalThis.__hvirSourceLoading=false;
    globalThis.__hvirSourceKey=null;
    const key=event=>{globalThis.__hvirSourceKey={key:event.key,group:event.target.dataset.sourceToggle??null}};
    document.addEventListener('keydown',key);
    const observer=new MutationObserver(()=>{
      if(document.querySelector('#skills .library-source-content[aria-busy=true]')) globalThis.__hvirSourceLoading=true;
    });
    observer.observe(document.getElementById('skills'),{childList:true,subtree:true,attributes:true,attributeFilter:['aria-busy']});
    globalThis.__hvirSourceLoadingStop=()=>{observer.disconnect();document.removeEventListener('keydown',key)};
  })()`)
  let loadingSeen: boolean
  try {
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
    await ready(
      async () =>
        (await inspect(
          `${group}.getAttribute('aria-expanded')==='true' && ${body}.querySelectorAll('[data-skill-select]').length===${Math.min(100, source.count)} && !${body}.textContent.includes('Loading…')`,
        )) === true,
      'keyboard source expansion returns one bounded public page',
    )
    loadingSeen = (await inspect('globalThis.__hvirSourceLoading')) === true
  } catch (error) {
    console.log(
      '[smoke] source keyboard failure',
      JSON.stringify(
        await inspect(
          `({key:globalThis.__hvirSourceKey,focused:document.activeElement?.dataset.sourceToggle??null,nativeFocus:document.hasFocus(),expanded:${group}.getAttribute('aria-expanded'),status:${body}.querySelector('[role=status]')?.textContent??null,rows:${body}.querySelectorAll('[data-skill-select]').length})`,
        ),
      ),
    )
    throw error
  } finally {
    await inspect(
      'globalThis.__hvirSourceLoadingStop();delete globalThis.__hvirSourceLoadingStop;delete globalThis.__hvirSourceLoading;delete globalThis.__hvirSourceKey',
    )
  }
  if (!loadingSeen && source.count <= 100)
    throw new Error('Source expansion did not expose immediate group progress')
  await controls.metadataOnly('source expansion')
  await capture(true)
  guest.focus()
  await inspect(`${group}.focus()`)
  guest.sendInputEvent({ type: 'keyDown', keyCode: 'Right' })
  guest.sendInputEvent({ type: 'keyUp', keyCode: 'Right' })
  await ready(
    async () =>
      (await inspect(
        `document.activeElement===${body}.querySelector('[data-skill-select]')`,
      )) === true,
    'source header enters its first skill with Right',
  )
  guest.sendInputEvent({ type: 'keyDown', keyCode: 'Up' })
  guest.sendInputEvent({ type: 'keyUp', keyCode: 'Up' })
  await ready(
    async () => (await inspect(`document.activeElement===${group}`)) === true,
    'first skill returns to its source header with Up',
  )
  const first = await inspect(`${body}.querySelector('[data-skill-select]').dataset.id`)
  if (source.count > 100) {
    await inspect(`${body}.querySelector('[data-source-action=next]').click()`)
    await ready(
      async () =>
        (await inspect(
          `${body}.querySelector('[data-skill-select]')?.dataset.id!==${JSON.stringify(first)} && ${body}.querySelectorAll('[data-skill-select]').length<=100 && !${body}.querySelector('[data-source-action=previous]').disabled`,
        )) === true,
      'next source page remains bounded',
    )
    await inspect(`${body}.querySelector('[data-source-action=previous]').click()`)
    await ready(
      async () =>
        (await inspect(
          `${body}.querySelector('[data-skill-select]')?.dataset.id===${JSON.stringify(first)} && ${body}.querySelector('[data-source-action=previous]').disabled`,
        )) === true,
      'previous source page returns exact first occurrence',
    )
  }
  guest.focus()
  await inspect(`${group}.focus()`)
  guest.sendInputEvent({ type: 'keyDown', keyCode: 'Left' })
  guest.sendInputEvent({ type: 'keyUp', keyCode: 'Left' })
  await ready(
    async () =>
      (await inspect(
        `${group}.getAttribute('aria-expanded')==='false' && document.querySelectorAll('#skills [data-skill-select]').length===0 && document.activeElement===${group}`,
      )) === true,
    'keyboard collapse retains header focus and removes hidden skill controls',
  )
  await inspect("document.getElementById('refresh').click()")
  await ready(
    async () =>
      (await inspect(
        `${group}.getAttribute('aria-expanded')==='false' && document.getElementById('state').dataset.state==='ready' && document.querySelectorAll('#skills [data-skill-select]').length===0`,
      )) === true,
    'ordinary refresh retains collapsed disclosure without reading',
  )
  await inspect(`${group}.click()`)
  await ready(
    async () =>
      (await inspect(
        `${body}.querySelector('[data-skill-select]')?.dataset.id===${JSON.stringify(first)}`,
      )) === true,
    'explicit reopening retains exact bounded page',
  )
  if (
    ((await inspect(
      "document.querySelectorAll('#skills [data-source-toggle]').length",
    )) as number) > 1
  ) {
    await inspect(`(() => {
      const headings=[...document.querySelectorAll('#skills [data-source-toggle]')];
      if(headings[1].getAttribute('aria-expanded')==='true') headings[1].click();
      if(headings[0].getAttribute('aria-expanded')==='false') headings[0].click();
    })()`)
    await ready(
      async () =>
        (await inspect(
          "document.querySelector('#skills [data-source-toggle]').nextElementSibling.querySelectorAll('[data-skill-select]').length>0",
        )) === true,
      'first source has a current bounded page for adjacent-header navigation',
    )
    guest.focus()
    await inspect(
      "[...document.querySelector('#skills [data-source-toggle]').nextElementSibling.querySelectorAll('[data-skill-select]')].at(-1).focus()",
    )
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
    guest.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
    await ready(
      async () =>
        (await inspect(
          "document.activeElement===document.querySelectorAll('#skills [data-source-toggle]')[1] && document.activeElement.getAttribute('aria-expanded')==='false'",
        )) === true,
      'last skill reaches the next collapsed source header with Down',
    )
  }
  await controls.metadataOnly('source paging and collapsed refresh')
  console.log(
    '[smoke] source grouping',
    JSON.stringify({
      total: expectedTotal,
      expanded: source.count,
      maximumRows: Math.min(100, source.count),
      keyboard: true,
      loadingSeen,
      metadataOnly: true,
    }),
  )
}
