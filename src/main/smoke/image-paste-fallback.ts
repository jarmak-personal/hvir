import type { RemoteImagePasteCoordinator } from '../harness/remote-image-paste'
import type { PtySupervisor } from '../pty/pty-supervisor'

type SmokeImagePastePtys = Pick<PtySupervisor, 'isOwnedBy' | 'write'>

/** Keeps smoke terminals on the native key path without acquiring clipboard authority. */
export function createSmokeImagePasteFallback(
  ptys: SmokeImagePastePtys,
): Pick<RemoteImagePasteCoordinator, 'pasteOrForward'> {
  return {
    pasteOrForward: (terminalId, owner, fallbackData) => {
      if (
        (fallbackData === '\x16' || fallbackData === '\x1b\x16') &&
        ptys.isOwnedBy(terminalId, owner.id, owner.generation)
      ) {
        ptys.write(terminalId, owner.id, fallbackData, owner.generation)
      }
      return Promise.resolve()
    },
  }
}
