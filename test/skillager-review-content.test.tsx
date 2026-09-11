// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { HostPath } from '../src/shared/host-path'
import { localPath } from '../src/shared/host-path'
import { SkillagerReviewContent } from '../src/renderer/src/skillager/SkillagerReviewContent'
import { SkillagerReview } from '../src/renderer/src/skillager/SkillagerReview'
import { SkillagerDetails } from '../src/renderer/src/skillager/SkillagerDetails'
import type { SkillagerMetadata } from '../src/shared/skillager'
import type { SkillagerExposureController } from '../src/renderer/src/skillager/use-skillager-exposure'
import type { SkillagerReviewController } from '../src/renderer/src/skillager/use-skillager-review'
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

it('retains disabled update controls and a checking hint while the workspace refreshes', () => {
  const element = document.createElement('div'),
    root = createRoot(element)
  const metadata: SkillagerMetadata = {
    id: 'lib/demo',
    name: 'Demo',
    description: '',
    source: { type: 'collection', ownership: 'library' },
    trust: 'reviewed',
    tags: [],
    matchReasons: [],
    exposure: 'unknown',
    contentHash: 'a'.repeat(64),
    workspaceFreshness: 'fresh',
    workspaceCheckedAt: 1,
    workspace: {
      id: 'lib-demo',
      skillId: 'lib/demo',
      mode: 'native',
      status: 'source_update',
      expectedSourceHash: 'a'.repeat(64),
      target: localPath('/workspace/.agents/skills/lib-demo'),
    },
  }
  const review = vi.fn(),
    start = vi.fn()
  const controller: SkillagerReviewController = {
    states: {
      review: {
        detail: {
          reviewId: 'retained',
          root: localPath('/library/skills/demo'),
          skillId: 'lib/demo',
          hash: metadata.contentHash!,
          canAccept: false,
          files: [],
          findings: [],
          scanRisk: 'low',
          lintStatus: 'ok',
          history: { available: true, versions: [] },
          update: {
            request: {
              connectionId: 'connection',
              requestId: 1,
              workspaceRoot: localPath('/workspace'),
              destination: {
                projectId: 'project',
                workspaceId: 'workspace',
                root: localPath('/workspace'),
              },
              agent: 'codex',
              skillId: 'lib/demo',
              action: 'update',
              mode: 'native',
              exposure: metadata.workspace,
            },
            diff: {
              fromHash: 'b'.repeat(64),
              toHash: metadata.contentHash!,
              text: 'reviewed diff',
            },
          },
        },
      },
    },
    review,
    history: vi.fn(),
    content: vi.fn(),
    diff: vi.fn(),
    accept: vi.fn(),
    asset: vi.fn(),
    mode: vi.fn(),
  }
  // This view consumes only the start action; the menu belongs to the details view.
  const exposures = { start } as unknown as SkillagerExposureController
  document.body.append(element)
  const render = (freshness: SkillagerMetadata['workspaceFreshness']) => {
    const row = { ...metadata, workspaceFreshness: freshness }
    act(() =>
      root.render(
        <>
          <SkillagerDetails metadata={row} />
          <SkillagerReview
            tab={{ id: 'review', metadata: row }}
            controller={controller}
            exposures={exposures}
          />
        </>,
      ),
    )
  }
  try {
    render('fresh')
    const reviewButton = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Review workspace update',
    )!
    const previewButton = [...element.querySelectorAll('button')].find(
      (button) => button.textContent === 'Preview workspace update…',
    )!
    expect(reviewButton.disabled).toBe(false)
    expect(previewButton.disabled).toBe(false)
    render('checking')
    expect(element.contains(reviewButton)).toBe(true)
    expect(element.contains(previewButton)).toBe(true)
    expect(reviewButton.disabled).toBe(true)
    expect(previewButton.disabled).toBe(true)
    expect(element.textContent).toContain(
      'Checking workspace copy before another review or preview',
    )
    expect(element.querySelector('.skillager-freshness')?.textContent).toContain(
      'checking',
    )
    expect(element.querySelector('.skillager-freshness')?.textContent).not.toContain(
      'stale',
    )
    act(() => {
      reviewButton.click()
      previewButton.click()
    })
    expect(review).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    render('fresh')
    expect(reviewButton.disabled).toBe(false)
    expect(previewButton.disabled).toBe(false)
    act(() => previewButton.click())
    expect(start).toHaveBeenCalledWith(metadata, 'update', 'retained')
  } finally {
    act(() => root.unmount())
    element.remove()
  }
})
