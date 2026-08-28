import type { ReactElement } from 'react'

export function SessionsOverviewNotice({
  title,
  detail,
  action,
}: {
  readonly title: string
  readonly detail: string
  readonly action?: ReactElement
}): ReactElement {
  return (
    <section className="sessions-notice">
      <h2>{title}</h2>
      <p>{detail}</p>
      {action}
    </section>
  )
}
