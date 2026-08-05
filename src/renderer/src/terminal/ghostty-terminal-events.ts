import type {
  TerminalEvent as GhosttyTerminalEvent,
  TerminalEventProvenance as GhosttyTerminalEventProvenance,
  TerminalPaletteRequest as GhosttyTerminalPaletteRequest,
  TerminalPaletteTarget as GhosttyTerminalPaletteTarget,
} from 'ghostty-web'

import type {
  TerminalEvent,
  TerminalEventProvenance,
  TerminalPaletteRequest,
  TerminalPaletteTarget,
} from './terminal-pane'

/** Translate the closed Ghostty event union without leaking its types past the pane. */
export function translateGhosttyTerminalEvent(
  event: GhosttyTerminalEvent,
  retainProvenance: (
    provenance: GhosttyTerminalEventProvenance,
  ) => TerminalEventProvenance,
): TerminalEvent | undefined {
  switch (event.type) {
    case 'title':
      return { type: 'title', title: event.title }
    case 'working-directory':
      return { type: 'working-directory', uri: event.uri }
    case 'bell':
      return { type: 'bell' }
    case 'notification':
      if (event.source !== 'osc-9' && event.source !== 'osc-777') return undefined
      return {
        type: 'notification',
        source: event.source,
        title: event.title,
        body: event.body,
      }
    case 'progress':
      return event.progress === undefined
        ? { type: 'progress', state: event.state }
        : { type: 'progress', state: event.state, progress: event.progress }
    case 'semantic':
      return {
        type: 'semantic',
        action: event.action,
        options: event.options,
        provenance: retainProvenance(event.provenance),
      }
    case 'palette': {
      const request = translatePaletteRequest(event.request)
      if (!request) return undefined
      return {
        type: 'palette',
        operation: event.operation,
        request,
      }
    }
    case 'clipboard':
      return event.operation === 'read'
        ? { type: 'clipboard', operation: 'read', selection: event.selection }
        : {
            type: 'clipboard',
            operation: 'write',
            selection: event.selection,
            data: event.data,
          }
  }

  return undefined
}

function translatePaletteRequest(
  request: GhosttyTerminalPaletteRequest,
): TerminalPaletteRequest | undefined {
  switch (request.type) {
    case 'set': {
      const target = translatePaletteTarget(request.target)
      if (!target) return undefined
      return {
        type: 'set',
        target,
        color: { ...request.color },
      }
    }
    case 'query':
    case 'reset': {
      const target = translatePaletteTarget(request.target)
      if (!target) return undefined
      return {
        type: request.type,
        target,
      }
    }
    case 'reset-palette':
    case 'reset-special':
      return { type: request.type }
  }
}

function translatePaletteTarget(
  target: GhosttyTerminalPaletteTarget,
): TerminalPaletteTarget | undefined {
  switch (target.kind) {
    case 'palette':
      return { kind: 'palette', index: target.index }
    case 'special':
      return { kind: 'special', name: target.name }
    case 'dynamic':
      return { kind: 'dynamic', name: target.name }
  }
}
