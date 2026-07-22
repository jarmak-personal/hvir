export const KIND_DEFINITIONS = [
  {
    label: 'kind:epic',
    option: 'Epic',
  },
  {
    label: 'kind:feature',
    option: 'Feature',
  },
  {
    label: 'kind:bug',
    option: 'Bug',
  },
  {
    label: 'kind:refactor',
    option: 'Refactor',
  },
  {
    label: 'kind:docs',
    option: 'Docs',
  },
  {
    label: 'kind:maintenance',
    option: 'Maintenance',
  },
  {
    label: 'kind:enhancement',
    option: 'Enhancement',
  },
] as const

export type KindDefinition = (typeof KIND_DEFINITIONS)[number]
export type KindLabel = KindDefinition['label']
export type KindOption = KindDefinition['option']

export type KindEvent =
  | { action: 'labeled' | 'unlabeled'; label: string }
  | { action: 'opened' | 'reopened' | 'closed' | 'reconcile' }

export interface KindPlan {
  state: 'valid' | 'missing' | 'ambiguous'
  kind?: KindDefinition
  labelsToAdd: KindLabel[]
  labelsToRemove: string[]
  ignoredEvent: boolean
  detail: string
}

const definitionsByLabel = new Map<string, KindDefinition>(
  KIND_DEFINITIONS.map((definition) => [definition.label, definition]),
)

export function isKindLabel(label: string): label is KindLabel {
  return definitionsByLabel.has(label)
}

export function planKindLabels(labels: readonly string[], event: KindEvent): KindPlan {
  const scopedLabels = [
    ...new Set(labels.filter((label) => label.startsWith('kind:'))),
  ].sort()

  if (event.action === 'labeled' && isKindLabel(event.label)) {
    if (!scopedLabels.includes(event.label)) {
      return assessKindLabels(scopedLabels, true)
    }

    return {
      state: 'valid',
      kind: definitionsByLabel.get(event.label),
      labelsToAdd: [],
      labelsToRemove: scopedLabels.filter((label) => label !== event.label),
      ignoredEvent: false,
      detail: 'The newly applied kind is authoritative.',
    }
  }

  if (
    event.action === 'unlabeled' &&
    isKindLabel(event.label) &&
    scopedLabels.length === 0
  ) {
    return {
      state: 'valid',
      kind: definitionsByLabel.get(event.label),
      labelsToAdd: [event.label],
      labelsToRemove: [],
      ignoredEvent: false,
      detail: 'The sole kind removal will be reversed.',
    }
  }

  return assessKindLabels(
    scopedLabels,
    (event.action === 'labeled' || event.action === 'unlabeled') &&
      !isKindLabel(event.label),
  )
}

function assessKindLabels(
  scopedLabels: readonly string[],
  ignoredEvent: boolean,
): KindPlan {
  if (scopedLabels.length === 0) {
    return {
      state: 'missing',
      labelsToAdd: [],
      labelsToRemove: [],
      ignoredEvent,
      detail: 'The issue has no kind label; no category was inferred.',
    }
  }

  if (scopedLabels.length === 1) {
    const kind = definitionsByLabel.get(scopedLabels[0]!)
    if (kind !== undefined) {
      return {
        state: 'valid',
        kind,
        labelsToAdd: [],
        labelsToRemove: [],
        ignoredEvent,
        detail: 'The issue has exactly one recognized kind.',
      }
    }
  }

  return {
    state: 'ambiguous',
    labelsToAdd: [],
    labelsToRemove: [],
    ignoredEvent,
    detail: `The issue has unsupported or competing kind labels: ${scopedLabels.join(', ')}.`,
  }
}
