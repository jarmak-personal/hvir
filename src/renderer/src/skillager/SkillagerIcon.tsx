import type { SkillagerAgent } from '../../../shared/skillager'

/** Small Skills glyphs; agent marks are illustrative, not provider branding or policy. */
export function SkillagerIcon({
  name,
  label,
}: {
  readonly name:
    | 'skill'
    | SkillagerAgent
    | 'original'
    | 'copy'
    | 'stub'
    | 'router'
    | 'library'
    | 'search'
    | 'refresh'
  readonly label?: string
}) {
  const paths = {
    skill: 'M6 2h7l4 4v11H6zM13 2v5h4M3 5v14h11M9 10h5M9 13h5',
    codex: 'M3 3h14v14H3zM6 7l3 3-3 3M11 13h3',
    claude: 'M10 2v16M2 10h16M4 4l12 12M4 16 16 4M7 3l6 14M3 7l14 6M3 13 17 7M7 17 13 3',
    original: 'M2.5 5H8l2 2h7.5v9h-15z',
    copy: 'M7 12l-2 2a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0M11 14a3 3 0 0 0 4 0l4-4a3 3 0 0 0-4-4l-2 2M7 11l6-2',
    stub: 'M4 2h8l4 4v12H4zM12 2v5h4M7 11h6M10 8l3 3-3 3',
    router: 'M10 2v5M4 12V7h12v5M2 12h4v5H2zM14 12h4v5h-4z',
    library: 'M4 3h12v14H5a2 2 0 0 1 0-4h11M6 3v10M9 6h4M9 9h3',
    search: 'M13 13l5 5M14 8.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0',
    refresh: 'M16 7a6.5 6.5 0 1 0 0 6M16 3v4h-4',
  }
  return (
    <span
      className="skillager-icon"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path d={paths[name]} />
      </svg>
    </span>
  )
}
