// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { HostPath } from '../src/shared/host-path'
import { localPath } from '../src/shared/host-path'
import { SkillagerReviewContent } from '../src/renderer/src/skillager/SkillagerReviewContent'
import { useSkillagerReview } from '../src/renderer/src/skillager/use-skillager-review'

vi.mock('../src/renderer/src/viewer/SourceView', () => ({
  SourceView: ({
    path,
    content,
    readOnly,
  }: {
    path: HostPath
    content: string
    readOnly: boolean
  }) => (
    <pre data-host={path.hostId} data-path={path.path} data-read-only={readOnly}>
      {content}
    </pre>
  ),
}))
const tabs = [] as const
function Harness({ diff }: { diff?: string }) {
  const controller = useSkillagerReview({
    agent: 'codex',
    tabs,
    onAccepted: () => undefined,
  })
  return (
    <SkillagerReviewContent
      id="review"
      source={false}
      diff={diff}
      diffPath={localPath('/library/skills/review/SKILL.md')}
      controller={controller}
    />
  )
}
it('renders an exact reviewed diff without requiring a selected file and keeps its qualified identity', () => {
  const element = document.createElement('div'),
    root = createRoot(element)
  document.body.append(element)
  try {
    act(() => root.render(<Harness />))
    expect(element.textContent).toContain('Choose a file')
    act(() =>
      root.render(
        <Harness diff={'- old instructions\n+ reviewed accepted instructions'} />,
      ),
    )
    const source = element.querySelector('pre')!
    expect(source.textContent).toBe(
      '- old instructions\n+ reviewed accepted instructions',
    )
    expect(source.dataset).toMatchObject({
      host: 'local',
      path: '/library/skills/review/SKILL.md',
      readOnly: 'true',
    })
    expect(element.textContent).not.toContain('Choose a file')
  } finally {
    act(() => root.unmount())
    element.remove()
  }
})
