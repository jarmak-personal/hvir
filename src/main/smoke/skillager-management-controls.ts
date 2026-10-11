import type { WebContents } from 'electron'
import type { HostPath } from '../../shared/host-path'

export interface SkillagerManagementControls {
  click(name: string): Promise<void>
  wait(predicate: () => boolean | Promise<boolean>, label: string): Promise<void>
}

/** Finite document inspection and real public controls; no private guest capability calls. */
export function skillagerManagementControls(
  guest: WebContents,
  controls: Pick<SkillagerManagementControls, 'wait'>,
): {
  inspect(expression: string): Promise<unknown>
  click(id: string): Promise<void>
  set(id: string, value: string): Promise<void>
  observeCopies(selection: {
    agent: string
    exposureId: string
    target: HostPath
  }): Promise<void>
  ready(expression: string, label: string): Promise<void>
  result(action: string): Promise<Record<string, unknown>>
} {
  const inspect = async (expression: string): Promise<unknown> => {
    const result = (await withinExtensionInspection(
      guest.debugger.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
    )) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (result.exceptionDetails)
      throw new Error('Skillager management document control failed')
    return result.result?.value
  }
  const ready = async (expression: string, label: string) => {
    console.log(`[smoke] Skillager management: awaiting ${label}`)
    await controls.wait(async () => Boolean(await inspect(expression)), label)
  }
  const click = async (id: string) => {
    await ready(
      `!!document.getElementById(${JSON.stringify(id)}) && !document.getElementById(${JSON.stringify(id)}).disabled`,
      id,
    )
    await inspect(`document.getElementById(${JSON.stringify(id)}).click()`)
  }
  return {
    inspect,
    ready,
    click,
    async observeCopies({ agent, exposureId, target }) {
      await inspect("document.getElementById('result').textContent=''")
      await click('observe-copies')
      await ready(
        `(() => { try { const result=JSON.parse(document.getElementById('result').textContent);return result.schema==='skillager.exposures.v1' && result.exposures.some(item=>item.agent===${JSON.stringify(agent)} && item.exposure_id===${JSON.stringify(exposureId)} && item.target===${JSON.stringify(target.path)}) && [...document.querySelectorAll('#managed-copies > div > p')].some(row=>row.textContent.startsWith(${JSON.stringify(agent)}) && row.textContent.includes(${JSON.stringify(target.path)})); } catch { return false } })()`,
        `${agent} fresh complete managed-copy observation`,
      )
    },
    async set(id, value) {
      await inspect(
        `(() => { const input=document.getElementById(${JSON.stringify(id)}); input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event(input.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`,
      )
    },
    async result(action) {
      try {
        await ready(
          `(() => { try { const v=JSON.parse(document.getElementById('result').textContent); return v.action===${JSON.stringify(action)}; } catch { return false } })()`,
          `${action} complete public result`,
        )
      } catch (error) {
        const diagnostic = await inspect(`(() => {
          const state=document.getElementById('state').textContent;
          const classes=['unavailable','undeclared','schema','capacity','hidden','cancelled','timed out','stale','rejected','not initialized'];
          let result; try { result=JSON.parse(document.getElementById('result').textContent); } catch {}
          return {ready:document.readyState,formValid:document.getElementById('initialize').checkValidity(),resultPresent:!!result,
            expectedAction:result?.action===${JSON.stringify(action)},stateClasses:classes.filter(value=>state.toLowerCase().includes(value))};
        })()`).catch(() => ({ inspectionUnavailable: true }))
        console.log(
          '[smoke] Skillager management result boundary',
          JSON.stringify({
            action,
            guestId: guest.id,
            loading: guest.isLoading(),
            diagnostic,
          }),
        )
        throw error
      }
      const result = (await inspect(
        "JSON.parse(document.getElementById('result').textContent)",
      )) as Record<string, unknown>
      if (
        ['add-copy', 'change-exposure', 'remove-copy'].includes(action) &&
        result['outcome'] !== 'verified'
      ) {
        const message = typeof result['message'] === 'string' ? result['message'] : ''
        console.log(
          '[smoke] Skillager nonverified copy outcome',
          JSON.stringify({
            action,
            outcome: ['uncertain', 'refused'].includes(String(result['outcome']))
              ? result['outcome']
              : 'unsupported',
            operationPresent: typeof result['operationId'] === 'string',
            operationId:
              typeof result['operationId'] === 'string' &&
              /^[a-f0-9-]{36}$/u.test(result['operationId'])
                ? result['operationId']
                : undefined,
            messageBytes: new TextEncoder().encode(message).length,
            messageClasses: [
              'source-bound exposure',
              'managed-target',
              'exact result',
              'version changed',
              'frequency',
              'capacity',
              'cancelled',
            ].filter((value) => message.includes(value)),
          }),
        )
      }
      return result
    },
  }
}

export async function withinExtensionInspection<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Extension document inspection did not settle')),
          5000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
