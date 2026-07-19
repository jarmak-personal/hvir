import { useRef, useState, type ReactElement } from 'react'

import type { SshPromptRequest } from '../../../shared'
import { useModalKeyboard } from '../workbench/use-modal-keyboard'

export function SshPromptDialog({
  prompt,
  onAnswer,
}: {
  readonly prompt: SshPromptRequest
  readonly onAnswer: (answers?: readonly string[]) => void
}): ReactElement {
  const dialogRef = useRef<HTMLFormElement>(null)
  const [answers, setAnswers] = useState(() => prompt.prompts.map(() => ''))
  const [verifiedChangedKey, setVerifiedChangedKey] = useState(false)
  const changedKey = prompt.kind === 'host-key-changed'
  useModalKeyboard(dialogRef, () => onAnswer(undefined))
  return (
    <div className="modal-backdrop">
      <form
        className="project-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-prompt-title"
        tabIndex={-1}
        onSubmit={(event) => {
          event.preventDefault()
          onAnswer(prompt.kind === 'host-key' || changedKey ? ['yes'] : answers)
        }}
      >
        <h2 id="ssh-prompt-title">{prompt.title}</h2>
        {prompt.instructions ? <p>{prompt.instructions}</p> : null}
        {(prompt.kind === 'host-key' || changedKey) && prompt.fingerprint ? (
          <div className={changedKey ? 'ssh-host-key-changed' : undefined}>
            {changedKey && prompt.previousFingerprint ? (
              <label>
                Saved fingerprint
                <code className="ssh-host-fingerprint">{prompt.previousFingerprint}</code>
              </label>
            ) : null}
            <label>
              {changedKey ? 'Presented fingerprint' : 'Fingerprint'}
              <code className="ssh-host-fingerprint">{prompt.fingerprint}</code>
            </label>
            {changedKey ? (
              <label className="ssh-host-key-confirm">
                <input
                  type="checkbox"
                  checked={verifiedChangedKey}
                  onChange={(event) => setVerifiedChangedKey(event.target.checked)}
                />
                I verified this host key through a trusted channel.
              </label>
            ) : null}
          </div>
        ) : (
          prompt.prompts.map((item, index) => (
            <label key={`${item.text}:${index}`}>
              {item.text}
              <input
                autoFocus={index === 0}
                type={item.echo ? 'text' : 'password'}
                value={answers[index]}
                onChange={(event) =>
                  setAnswers((current) =>
                    current.map((answer, at) =>
                      at === index ? event.target.value : answer,
                    ),
                  )
                }
              />
            </label>
          ))
        )}
        <div className="dialog-actions">
          <button type="button" onClick={() => onAnswer(undefined)}>
            Cancel
          </button>
          <button
            type="submit"
            autoFocus={prompt.kind === 'host-key'}
            disabled={changedKey && !verifiedChangedKey}
          >
            {changedKey
              ? 'Replace Saved Key'
              : prompt.kind === 'host-key'
                ? 'Trust Host'
                : 'Continue'}
          </button>
        </div>
      </form>
    </div>
  )
}
