interface SftpErrorSource {
  on(event: 'error', listener: (reason: Error) => void): unknown
}

/** Keep late ssh2 errors handled without retaining a settled operation's callback. */
export function retainSftpErrorHandler(
  source: SftpErrorSource,
  onError: (reason: Error) => void,
): () => void {
  let active: typeof onError | undefined = onError
  // A successful CLOSE can precede another pending request's failure. The inert
  // listener stays with the source until GC, even after close or settlement.
  source.on('error', (reason) => active?.(reason))
  return () => {
    active = undefined
  }
}
