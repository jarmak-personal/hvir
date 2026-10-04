import type { WebContents } from 'electron'
import { joinHostPath, type HostPath } from '../../shared/host-path'
import type { ProjectHost } from '../project-host/project-host'
import { withinExtensionInspection } from './skillager-management-controls'

/** Fixture-only public-message observations; no input, token, body or raw result capture. */
export function managementActionTrace(
  host: ProjectHost,
  owned: HostPath,
): {
  observe(guest: WebContents, role: 'human' | 'action'): Promise<void>
  dispose(): Promise<void>
} {
  const guests = new Map<WebContents, 'human' | 'action'>()
  async function evaluate(guest: WebContents, expression: string): Promise<unknown> {
    const response = (await withinExtensionInspection(
      guest.debugger.sendCommand('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
    )) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (response.exceptionDetails) throw new Error('Owned public-message observer failed')
    return response.result?.value
  }
  return {
    async observe(guest, role) {
      guests.set(guest, role)
      await evaluate(
        guest,
        `(() => {
        const started=performance.now();let previousResult=started,probeTimer;
        const counts={contexts:0,visible:null,actions:0,acceptanceActions:0,caller:'none',cancelledActions:0,revoked:false,
          results:0,failedResults:0,nativeCompleted:0,nativeZero:0,nativeNonzero:0,notStarted:0,pages:0,pageCharacters:0,
          acceptanceResults:0,acceptanceOutcome:'none',initializationResults:0,resultIntervalsMs:[],nativeElapsedMs:[],
          probeStarted:false,probeSettled:false,probeElapsedMs:null};
        const release=window.hvirExtension.onMessage(message=>{
          if(message.kind==='context'){counts.contexts++;counts.visible=message.context.visible===true;}
          if(message.kind==='action'){counts.actions++;counts.caller=['agent','guest'].includes(message.invocation.caller)?message.invocation.caller:'other';
            if(message.invocation.action==='accept-version'){
              counts.acceptanceActions++;
              if(!counts.probeStarted){counts.probeStarted=true;const before=performance.now();probeTimer=setTimeout(()=>{
                counts.probeSettled=true;counts.probeElapsedMs=Math.round(performance.now()-before);
              },40);}
            }}
          if(message.kind==='action-cancelled')counts.cancelledActions++;
          if(message.kind==='revoked')counts.revoked=true;
          if(message.kind!=='result')return;
          const now=performance.now();if(counts.resultIntervalsMs.length<32)counts.resultIntervalsMs.push(Math.round(now-previousResult));previousResult=now;
          counts.results++;if(message.ok!==true){counts.failedResults++;return;}
          const value=message.value;
          if(value?.outcome==='completed'){counts.nativeCompleted++;if(counts.nativeElapsedMs.length<32)counts.nativeElapsedMs.push(Math.round(now-started));if(value.code===0)counts.nativeZero++;else if(Number.isInteger(value.code))counts.nativeNonzero++;}
          if(value?.outcome==='not-started')counts.notStarted++;
          if(typeof value?.data==='string'){counts.pages++;counts.pageCharacters+=value.data.length;}
          if(value?.action==='accept-version'){counts.acceptanceResults++;counts.acceptanceOutcome=['verified','refused','uncertain'].includes(value.outcome)?value.outcome:'other';}
          if(value?.action==='initialize-library')counts.initializationResults++;
        });
        window.__hvirOwnedManagementTrace={counts,stop:()=>{clearTimeout(probeTimer);release();}};return true;
      })()`,
      )
    },
    async dispose() {
      const records: Record<string, unknown>[] = []
      let failed = false
      for (const [guest, role] of guests) {
        if (guest.isDestroyed()) {
          records.push({ role, guestId: guest.id, destroyed: true })
          continue
        }
        try {
          const counts = await evaluate(
            guest,
            `(() => {
            const trace=window.__hvirOwnedManagementTrace;if(!trace)return null;
            trace.stop();delete window.__hvirOwnedManagementTrace;return trace.counts;
          })()`,
          )
          records.push({
            role,
            guestId: guest.id,
            backgroundThrottling: guest.backgroundThrottling,
            counts,
            unsubscribed: counts !== null,
          })
        } catch {
          failed = true
          records.push({ role, guestId: guest.id, inspectionUnavailable: true })
        }
      }
      guests.clear()
      await host.writeFile(
        joinHostPath(owned, 'public-message-proof.json'),
        JSON.stringify({ records }, null, 2),
      )
      console.log(
        '[smoke] Skillager closed public-message observations',
        JSON.stringify({ records }),
      )
      if (failed) throw new Error('Owned public-message observer cleanup failed')
    },
  }
}
