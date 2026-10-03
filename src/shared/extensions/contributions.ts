import {
  EXTENSION_LIMITS,
  type ExtensionContribution,
  type ExtensionRailItem,
  type ExtensionAction,
  type ExtensionItemValue,
} from './contract'
import {
  extensionAssetPath,
  extensionId,
  extensionObject,
  extensionText,
} from './validation'
import { validateActionSchema } from './action-input'

export function extensionIcon(value: unknown): string {
  const icon = extensionText(value, 'item icon', 8)
  if ([...icon].length > 2 || /[<>]/u.test(icon))
    throw new Error('Use a short text glyph icon')
  return icon
}
export function validateContributionDeclarations(
  object: Record<string, unknown>,
  views: readonly ExtensionContribution[],
  warn: (object: Record<string, unknown>, known: readonly string[]) => void = () =>
    undefined,
): {
  railItems: readonly ExtensionRailItem[]
  actions: readonly ExtensionAction[]
  updater?: string
} {
  const list = (value: unknown, max: number): readonly unknown[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > max)
      throw new Error('Contribution count exceeds its limit')
    return value
  }
  const viewId = (value: unknown): string => {
    const id = extensionId(value)
    if (!views.some((view) => view.id === id))
      throw new Error('Contribution names an undeclared view')
    return id
  }
  const railItems = list(object['railItems'], EXTENSION_LIMITS.railItems).map((value) => {
    const item = extensionObject(value),
      click = extensionObject(item['click'])
    warn(item, ['id', 'placement', 'kind', 'icon', 'tooltip', 'label', 'click'])
    warn(click, ['view', 'placement'])
    if (
      !['header', 'session'].includes(item['placement'] as string) ||
      !['control', 'observation'].includes(item['kind'] as string) ||
      !['popup', 'viewer'].includes(click['placement'] as string)
    )
      throw new Error('Invalid rail contribution')
    return {
      id: extensionId(item['id']),
      placement: item['placement'] as 'header' | 'session',
      kind: item['kind'] as 'control' | 'observation',
      icon: extensionIcon(item['icon']),
      tooltip: extensionText(item['tooltip'], 'item tooltip', 160),
      ...(item['label'] === undefined
        ? {}
        : { label: extensionText(item['label'], 'item label', 24) }),
      click: {
        view: viewId(click['view']),
        placement: click['placement'] as 'popup' | 'viewer',
      },
    }
  })
  const actions = list(object['actions'], EXTENSION_LIMITS.actions).map((value) => {
    const action = extensionObject(value),
      effects = extensionObject(action['effects'])
    warn(action, [
      'id',
      'title',
      'view',
      'agents',
      'effects',
      'timeoutMs',
      'description',
      'inputSchema',
    ])
    warn(effects, ['delete', 'replace'])
    if (
      typeof action['agents'] !== 'boolean' ||
      typeof effects['delete'] !== 'boolean' ||
      typeof effects['replace'] !== 'boolean'
    )
      throw new Error('Declare agent access and delete/replace effects')
    if (
      action['timeoutMs'] !== undefined &&
      (typeof action['timeoutMs'] !== 'number' ||
        !Number.isInteger(action['timeoutMs']) ||
        action['timeoutMs'] < 1000 ||
        action['timeoutMs'] > EXTENSION_LIMITS.actionMaximumMs)
    )
      throw new Error('Invalid finite action deadline')
    return {
      ...(action['timeoutMs'] === undefined ? {} : { timeoutMs: action['timeoutMs'] }),
      id: extensionId(action['id']),
      title: extensionText(action['title'], 'action title', 80),
      view: viewId(action['view']),
      agents: action['agents'],
      ...(action['description'] === undefined
        ? {}
        : {
            description: extensionText(action['description'], 'action description', 500),
          }),
      ...(action['inputSchema'] === undefined
        ? {}
        : { inputSchema: validateActionSchema(action['inputSchema']) }),
      effects: { delete: effects['delete'], replace: effects['replace'] },
    }
  })
  for (const entries of [railItems, actions])
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
      throw new Error('Duplicate contribution identity')
  return {
    railItems,
    actions,
    ...(object['updater'] === undefined
      ? {}
      : {
          updater: extensionAssetPath(object['updater']),
        }),
  }
}

/** Bounded presentation data conveys no capability or trusted decision. */
export function validateExtensionItemValue(value: unknown): ExtensionItemValue {
  const item = extensionObject(value)
  const availability = item['availability']
  if (
    availability !== undefined &&
    !['current', 'stale', 'disconnected', 'failed'].includes(availability as string)
  )
    throw new Error('Invalid observation availability')
  const observedAt = item['observedAt']
  if (
    observedAt !== undefined &&
    (typeof observedAt !== 'number' ||
      !Number.isFinite(observedAt) ||
      observedAt < 0 ||
      observedAt > Date.now() + 1000)
  )
    throw new Error('Invalid observation timestamp')
  if (availability === 'current' && observedAt === undefined)
    throw new Error('Current observations need a timestamp')
  return {
    item: extensionId(item['item']),
    ...(item['session'] === undefined
      ? {}
      : { session: extensionText(item['session'], 'session identity', 80) }),
    ...(item['icon'] === undefined ? {} : { icon: extensionIcon(item['icon']) }),
    ...(item['label'] === undefined
      ? {}
      : { label: extensionText(item['label'], 'item label', 24) }),
    ...(item['tooltip'] === undefined
      ? {}
      : { tooltip: extensionText(item['tooltip'], 'item tooltip', 160) }),
    ...(availability === undefined
      ? {}
      : { availability: availability as ExtensionItemValue['availability'] }),
    ...(observedAt === undefined ? {} : { observedAt: observedAt }),
  }
}
