/**
 * Reviewed terminal-engine capability evidence for the immutable artifact hvir consumes.
 * This records conformance; it never changes TERM, TERM_PROGRAM, or terminfo.
 */
export const GHOSTTY_TERMINAL_CAPABILITY_PROFILE = {
  schemaVersion: 1,
  artifact: {
    url: 'https://github.com/jarmak-personal/ghostty-web/releases/download/hvir-v0.4.0-18/ghostty-web-0.4.0-hvir-g09b2307bc3cb.tgz',
    // Release-recorded digest; package installation is pinned by npm's SHA-512 lock integrity.
    sha256: '98c63dc90bcdf8d0333353f0727d4bbe7c84e1ece864862c76164a33d032baf1',
    npmIntegrity:
      'sha512-rQgUbuGstgTJXryydqNLxMunHL0GCK6FsZGa3CFh28caxJWkHjyCCccD5U4nGzrnqzqj7aS/XaLgCgbIULfS9g==',
    sourceCommit: '09b2307bc3cbf8151b01d7e2a960bf3fdb3c2f72',
    ghosttyCommit: '332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28',
    wasmBytes: 527_422,
  },
  identity: {
    term: 'xterm-256color',
    termProgram: 'hvir',
    terminfo: 'unchanged',
  },
  synchronizedOutput: {
    decPrivateMode: 2026,
    parserOwner: 'ghostty-core',
    presentationOwner: 'ghostty-web-canvas',
    recoveryTimeoutMs: 1_000,
    hvirOutputBuffering: false,
    terminalMethods: [
      'requestRender',
      'setRenderPaused',
      'resetCursorBlink',
      'getRenderStats',
      'resolveEventProvenance',
    ],
    parserMethods: [
      'isSynchronizedOutput',
      'getSynchronizedOutputGeneration',
      'resetSynchronizedOutput',
    ],
  },
  hostOwnedContextMenu: {
    browserMenuDisabled: true,
    clipboardOwner: 'hvir-renderer',
    imagePasteOwner: 'adr-026-main-coordinator',
    terminalMethods: [
      'hasSelection',
      'getSelection',
      'paste',
      'selectAll',
      'clear',
      'reset',
    ],
  },
  retainedBuffer: {
    owner: 'ghostty-web-native-snapshot',
    scrollbackBytes: 10_000_000,
    maxQueryBytes: 64 * 1024,
    maxExtractionBytes: 4 * 1024 * 1024,
    terminalMethods: [
      'searchRetainedBuffer',
      'cancelRetainedBufferSearch',
      'extractRetainedBufferRange',
      'cancelRetainedBufferExtraction',
      'captureRetainedBufferBoundary',
      'getScrollbackByteLimit',
    ],
  },
  palette: {
    baseOwner: 'hvir-terminal-presentation',
    effectiveOwner: 'ghostty-terminal-state',
    presentationOwner: 'ghostty-web-canvas',
    ansiColors: 16,
    liveBaseUpdates: true,
    rawOutputReparsed: false,
  },
  cursor: {
    effectiveOwner: 'ghostty-render-state',
    defaultOwner: 'hvir-terminal-presentation',
    presentationOwner: 'ghostty-web-canvas',
    shapes: ['block', 'block_hollow', 'bar', 'underline'],
    blinkPolicies: ['terminal', true, false],
    liveDefaults: true,
    rawOutputReparsed: false,
  },
  shaping: {
    cellGridOwner: 'ghostty-core',
    lineRunOwner: 'ghostty-web-canvas',
    preferenceOwner: 'hvir-terminal-presentation',
    option: 'fontLigatures',
    defaultEnabled: true,
    liveUpdates: true,
    rawOutputReparsed: false,
  },
} as const
