import type { HostPath } from '../../shared'

export function installReplacementDeliveryObserver(
  contents: { executeJavaScript: (script: string) => Promise<unknown> },
  liveReloadPath: HostPath,
  healthOccurrenceId: string,
): Promise<unknown> {
  return contents.executeJavaScript(`
    (() => {
      const expectedWatchPath = ${JSON.stringify(liveReloadPath)};
      const expectedHealthOccurrenceId = ${JSON.stringify(healthOccurrenceId)};
      window.__hvirRendererRecoveryDeliveries = {
        local: false,
        ssh: false,
        watch: false,
        health: false
      };
      const tails = { local: '', ssh: '' };
      const matches = (label, data) => {
        const combined = tails[label] + data;
        tails[label] = combined.slice(-32);
        return combined.includes('hvir-replacement-' + label);
      };
      window.hvir.on('pty:data', ({ id, data }) => {
        if (id === 'renderer-recovery-local' && matches('local', data)) {
          window.__hvirRendererRecoveryDeliveries.local = true;
        }
        if (id === 'renderer-recovery-ssh' && matches('ssh', data)) {
          window.__hvirRendererRecoveryDeliveries.ssh = true;
        }
      });
      window.hvir.on('project:watch', ({ path }) => {
        if (
          path.hostId === expectedWatchPath.hostId &&
          path.path === expectedWatchPath.path
        ) {
          window.__hvirRendererRecoveryDeliveries.watch = true;
        }
      });
      window.hvir.on('workbench-health:state', ({ items }) => {
        if (items.some((item) => item.occurrenceId === expectedHealthOccurrenceId)) {
          window.__hvirRendererRecoveryDeliveries.health = true;
        }
      });
    })()
  `)
}

export async function waitForReplacementDeliveries(contents: {
  executeJavaScript: (script: string) => Promise<unknown>
}): Promise<void> {
  await contents.executeJavaScript(`
      new Promise((resolve) => {
        const inspect = () => {
          const deliveries = window.__hvirRendererRecoveryDeliveries;
          if (deliveries?.local && deliveries.ssh && deliveries.watch && deliveries.health) {
            return resolve();
          }
          setTimeout(inspect, 25);
        };
        inspect();
      })
    `)
}
