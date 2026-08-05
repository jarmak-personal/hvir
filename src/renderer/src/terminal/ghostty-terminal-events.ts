import type {
  TerminalEvent as GhosttyTerminalEvent,
  TerminalPaletteRequest as GhosttyTerminalPaletteRequest,
  TerminalPaletteTarget as GhosttyTerminalPaletteTarget,
} from 'ghostty-web'

import type {
  TerminalEvent,
  TerminalPaletteRequest,
  TerminalPaletteTarget,
} from './terminal-pane'

/** Translate the closed Ghostty event union without leaking its types past the pane. */
export function translateGhosttyTerminalEvent(
  event: GhosttyTerminalEvent,
): TerminalEvent | undefined {
  switch (event.type) {
    case 'title':
      return { type: 'title', title: event.title }
    case 'working-directory':
      return { type: 'working-directory', uri: event.uri }
    case 'bell':
      return { type: 'bell' }
    case 'notification':
      return { type: 'notification', title: event.title, body: event.body }
    case 'progress':
      return event.progress === undefined
        ? { type: 'progress', state: event.state }
        : { type: 'progress', state: event.state, progress: event.progress }
    case 'semantic':
      return {
        type: 'semantic',
        action: event.action,
        options: event.options,
        provenance: { ...event.provenance },
      }
    case 'palette':
      return {
        type: 'palette',
        operation: event.operation,
        request: translatePaletteRequest(event.request),
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
): TerminalPaletteRequest {
  switch (request.type) {
    case 'set':
      return {
        type: 'set',
        target: translatePaletteTarget(request.target),
        color: { ...request.color },
      }
    case 'query':
    case 'reset':
      return {
        type: request.type,
        target: translatePaletteTarget(request.target),
      }
    case 'reset-palette':
    case 'reset-special':
      return { type: request.type }
  }
}

function translatePaletteTarget(
  target: GhosttyTerminalPaletteTarget,
): TerminalPaletteTarget {
  switch (target.kind) {
    case 'palette':
      return { kind: 'palette', index: target.index }
    case 'special':
      return { kind: 'special', name: target.name }
    case 'dynamic':
      return { kind: 'dynamic', name: target.name }
  }
}
