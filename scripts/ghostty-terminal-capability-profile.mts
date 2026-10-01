/**
 * Reviewed terminal-engine capability evidence for the immutable artifact hvir consumes.
 * This records conformance; it never changes TERM, TERM_PROGRAM, or terminfo.
 */
export const GHOSTTY_TERMINAL_CAPABILITY_PROFILE = {
  schemaVersion: 1,
  artifact: {
    url: 'https://github.com/jarmak-personal/ghostty-web/releases/download/hvir-v0.4.0-20/ghostty-web-0.4.0-hvir-g18fc0d2bddb0.tgz',
    // Release-recorded digest; package installation is pinned by npm's SHA-512 lock integrity.
    sha256: '40b859ece2ea14118b0695814db91e8dfedfc4f3257d1df5ad1c2776a0d0dbe2',
    npmIntegrity:
      'sha512-0+1Ewingi27TtG/EoMES5fAE+AWGM9XdmSQsAGF0A0mcVHiwavmy3O4ZiGttZjeN45MujUs/ef/Twlw0QNR8fw==',
    sourceCommit: '18fc0d2bddb0c788ef5f1c58464603bd20d1c391',
    ghosttyCommit: '332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28',
    wasmBytes: 546_616,
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
  mouseInput: {
    owner: 'ghostty-web-input-handler',
    trackingModes: [1000, 1002, 1003],
    encoding: 'sgr-1006',
    shiftOverride: 'engine-local-selection-and-scroll',
    linesPerStep: 3,
    maxMouseReports: 5,
    maxFallbackKeys: 1,
    alternateScreenFallback: 'page',
  },
  fitting: {
    mechanicsOwner: 'ghostty-web-fit-addon',
    eligibilityOwner: 'hvir-terminal-presentation',
    resizeDebounceMs: 75,
    reservedScrollbarPixels: 0,
    addonMethods: ['activate', 'fit', 'resume', 'suspend', 'dispose'],
  },
  retainedBuffer: {
    owner: 'ghostty-web-native-query',
    scrollbackBytes: 10_000_000,
    maxQueryBytes: 64 * 1024,
    occurrenceIdentity: 'native-cell-incarnation',
    updates: 'finite-coalesced-scans',
    reflow: 'revoke-selection',
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
