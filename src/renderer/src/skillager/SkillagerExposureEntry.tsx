import type { ReactElement } from 'react'
import { exposurePermission } from './skillager-exposure-model'
import type { SkillagerExposureEntry as ExposureEntry } from '../../../shared/skillager-exposure'
export function SkillagerExposureEntry({
  value,
}: {
  readonly value: ExposureEntry | null
}): ReactElement {
  if (!value) return <p>Absent</p>
  return (
    <>
      <p>
        {value.type} · permissions <code>{exposurePermission(value.mode)}</code>
        {value.size !== undefined ? ` · ${value.size} bytes` : ''}
      </p>
      {value.sha256 ? (
        <p>
          SHA-256 <code>{value.sha256}</code>
        </p>
      ) : null}
      {value.linkTarget !== undefined ? (
        <p>
          Link: <code>{value.linkTarget}</code>
        </p>
      ) : null}
      {value.device !== undefined ? <p>Device: {value.device}</p> : null}
      {value.metadata ? <pre>{value.metadata}</pre> : null}
      {value.generatedFields?.map((policy) => (
        <pre key={policy}>{policy}</pre>
      ))}
    </>
  )
}
