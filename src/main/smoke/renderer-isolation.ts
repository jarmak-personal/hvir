import type { BrowserWindow } from 'electron'
import type { SmokeInterruptionCheckpoint } from './interruption-checkpoint'

export async function recordRendererIsolationSelection(
  win: BrowserWindow,
  checkpoint: SmokeInterruptionCheckpoint,
): Promise<boolean> {
  const runToken = checkpoint.runToken
  if (!runToken) return false
  return (await win.webContents.executeJavaScript(`
    (() => {
      const key = 'hvir-smoke-isolation-run';
      const predecessor = localStorage.getItem(key);
      localStorage.setItem(key, ${JSON.stringify(runToken)});
      return predecessor === ${JSON.stringify(checkpoint.predecessorToken ?? '')};
    })()
  `)) as boolean
}
