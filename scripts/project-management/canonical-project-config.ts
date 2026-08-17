import type {
  CanonicalProjectField,
  CanonicalProjectSchema,
} from './canonical-project-fields.ts'

export interface CanonicalProjectConfiguration {
  repository: string
  owner: string
  number: number
  id: string
  fields: readonly CanonicalProjectField[]
}

/**
 * Public deployment identity for the one canonical hvir planning Project.
 *
 * GitHub node IDs are stable, non-secret identifiers. Update this contract deliberately after
 * provisioning or replacing a field, then confirm it with `npm run project:audit`.
 */
export const CANONICAL_PROJECT_CONFIGURATION = {
  repository: 'jarmak-personal/hvir',
  owner: 'jarmak-personal',
  number: 1,
  id: 'PVT_kwHOBkzMzc4Bdudr',
  fields: [
    singleSelectField('Status', 'PVTSSF_lAHOBkzMzc4BdudrzhYN-nI', [
      ['Todo', 'f75ad846'],
      ['In Progress', '47fc9ee4'],
      ['Done', '98236657'],
    ]),
    singleSelectField('Kind', 'PVTSSF_lAHOBkzMzc4BdudrzhYadk8', [
      ['Epic', '120ca550'],
      ['Feature', 'c4068c21'],
      ['Bug', 'e97479de'],
      ['Refactor', 'e3cf4f61'],
      ['Docs', 'e5770494'],
      ['Maintenance', 'ef3d5b07'],
      ['Enhancement', 'b1c96c87'],
    ]),
    valueField('Agent difficulty', 'PVTF_lAHOBkzMzc4BdudrzhfitMc', 'NUMBER'),
    singleSelectField('Risk', 'PVTSSF_lAHOBkzMzc4BdudrzhfitNY', [
      ['Low', '28938737'],
      ['Moderate', '1bfb208d'],
      ['High', 'aaa26654'],
      ['Critical', 'dc9fb332'],
    ]),
    singleSelectField('Estimate confidence', 'PVTSSF_lAHOBkzMzc4BdudrzhfitNc', [
      ['Low', '2775f9e4'],
      ['Medium', '86418556'],
      ['High', '94855958'],
    ]),
    valueField('Initial model', 'PVTF_lAHOBkzMzc4BdudrzhfitOY', 'TEXT'),
    valueField('Reasoning effort', 'PVTF_lAHOBkzMzc4BdudrzhfitOc', 'TEXT'),
    valueField('Model route', 'PVTF_lAHOBkzMzc4BdudrzhfitOg', 'TEXT'),
    valueField('Planning tokens', 'PVTF_lAHOBkzMzc4BdudrzhfitOk', 'NUMBER'),
    valueField('Implementation tokens', 'PVTF_lAHOBkzMzc4BdudrzhfitOo', 'NUMBER'),
    valueField('Review tokens', 'PVTF_lAHOBkzMzc4BdudrzhfitPk', 'NUMBER'),
    valueField('Own lifecycle tokens', 'PVTF_lAHOBkzMzc4BdudrzhfitPo', 'NUMBER'),
    valueField('Time to first candidate (ms)', 'PVTF_lAHOBkzMzc4BdudrzhfitPs', 'NUMBER'),
    singleSelectField('First-pass outcome', 'PVTSSF_lAHOBkzMzc4BdudrzhfitQo', [
      ['Pending', '26fea22a'],
      ['Accepted', 'e62ea645'],
      ['Rework required', '362fe7a6'],
      ['No candidate', '4e8e5271'],
    ]),
    valueField('Epic rollup tokens', 'PVTF_lAHOBkzMzc4BdudrzhfitQ0', 'NUMBER'),
  ],
} as const satisfies CanonicalProjectConfiguration

export function configuredProjectSchema(
  configuration: CanonicalProjectConfiguration,
): CanonicalProjectSchema {
  return {
    id: configuration.id,
    fields: configuration.fields.map((field) => ({
      ...field,
      ...(field.options === undefined
        ? {}
        : { options: field.options.map((option) => ({ ...option })) }),
    })),
  }
}

function valueField(
  name: string,
  id: string,
  dataType: 'NUMBER' | 'TEXT',
): CanonicalProjectField {
  return { typename: 'ProjectV2Field', id, name, dataType }
}

function singleSelectField(
  name: string,
  id: string,
  options: readonly (readonly [name: string, id: string])[],
): CanonicalProjectField {
  return {
    typename: 'ProjectV2SingleSelectField',
    id,
    name,
    options: options.map(([optionName, optionId]) => ({
      id: optionId,
      name: optionName,
    })),
  }
}
