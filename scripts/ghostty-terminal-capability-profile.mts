/**
 * Reviewed terminal-engine capability evidence for the immutable artifact hvir consumes.
 * This records conformance; it never changes TERM, TERM_PROGRAM, or terminfo.
 */
export const GHOSTTY_TERMINAL_CAPABILITY_PROFILE = {
  schemaVersion: 1,
  artifact: {
    url: 'https://github.com/jarmak-personal/ghostty-web/releases/download/hvir-v0.4.0-16/ghostty-web-0.4.0-hvir-g626f49c18d61.tgz',
    // Release-recorded digest; package installation is pinned by npm's SHA-512 lock integrity.
    sha256: 'a666ca604a6046db34f9e9d2cc413ce9735302a8f10e9beba067f60b7a4b0155',
    npmIntegrity:
      'sha512-u5WawYS/4QNMjJ0bP+BpLlEPLSKFlVTQXAmct5mvjYDcRXjvhngzj5zV0tSymmIO46eN1I9pqGnA14N5jlhb8Q==',
    sourceCommit: '626f49c18d619af8b33de5d691472e51be904004',
    ghosttyCommit: '332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28',
    wasmBytes: 527_201,
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
