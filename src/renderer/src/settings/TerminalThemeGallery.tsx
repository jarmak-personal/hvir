import { useDeferredValue, useState, type CSSProperties, type ReactElement } from 'react'

import type { AppTheme } from '../theme-model'
import {
  searchTerminalThemes,
  terminalThemeCatalogEntry,
  TERMINAL_THEME_CATALOG_SOURCE,
  type TerminalThemeCatalogEntry,
} from '../terminal/terminal-theme-catalog'
import type { TerminalColorTheme } from '../terminal/terminal-pane'

export function TerminalThemeGallery({
  lightThemeId,
  darkThemeId,
  onLightTheme,
  onDarkTheme,
}: {
  readonly lightThemeId: string
  readonly darkThemeId: string
  readonly onLightTheme: (id: string) => void
  readonly onDarkTheme: (id: string) => void
}): ReactElement {
  const [appearance, setAppearance] = useState<AppTheme>('dark')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const result = searchTerminalThemes(deferredQuery)
  const selectedId = appearance === 'light' ? lightThemeId : darkThemeId
  const selected = terminalThemeCatalogEntry(selectedId, appearance)
  const choose = appearance === 'light' ? onLightTheme : onDarkTheme

  return (
    <section
      className="terminal-theme-gallery"
      aria-labelledby="terminal-theme-gallery-title"
    >
      <header>
        <div>
          <strong id="terminal-theme-gallery-title">Theme gallery</strong>
          <small>
            {TERMINAL_THEME_CATALOG_SOURCE.expectedThemeCount} bundled Ghostty themes ·
            previews use color data only
          </small>
        </div>
        <fieldset className="terminal-theme-target">
          <legend>Theme selection</legend>
          {(['dark', 'light'] as const).map((target) => (
            <label key={target}>
              <input
                type="radio"
                name="terminal-theme-target"
                value={target}
                checked={appearance === target}
                onChange={() => setAppearance(target)}
              />
              {target === 'dark' ? 'Dark appearance' : 'Light appearance'}
            </label>
          ))}
        </fieldset>
      </header>

      <div className="terminal-theme-current">
        <span>Selected for {appearance} appearance</span>
        <TerminalThemePreview theme={selected} selected />
      </div>

      <label className="terminal-theme-search" htmlFor="settings-terminal-theme-search">
        <span>Search bundled themes</span>
        <input
          id="settings-terminal-theme-search"
          type="search"
          value={query}
          placeholder="Search by theme name"
          autoComplete="off"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <p className="terminal-theme-result-status" role="status">
        {result.total === 0
          ? 'No matching themes'
          : result.limited
            ? `Showing ${result.entries.length} of ${result.total} matches. Refine the search to see more.`
            : `${result.total} ${result.total === 1 ? 'theme' : 'themes'}`}
      </p>
      <div className="terminal-theme-results">
        {result.entries.map((theme) => (
          <button
            key={theme.id}
            type="button"
            className={theme.id === selected.id ? 'selected' : undefined}
            data-terminal-theme-id={theme.id}
            aria-pressed={theme.id === selected.id}
            aria-label={`Use ${theme.name} for ${appearance} appearance`}
            onClick={() => choose(theme.id)}
          >
            <TerminalThemePreview theme={theme} selected={theme.id === selected.id} />
          </button>
        ))}
      </div>
    </section>
  )
}

function TerminalThemePreview({
  theme,
  selected,
}: {
  readonly theme: TerminalThemeCatalogEntry
  readonly selected: boolean
}): ReactElement {
  const palette = theme.palette
  const colors = ansiColors(palette)
  return (
    <span className="terminal-theme-preview">
      <span className="terminal-theme-preview-heading">
        <span>
          <strong>{theme.name}</strong>
          <small>
            {theme.source === 'ghostty' ? 'Ghostty collection' : 'Hvir default'}
          </small>
        </span>
        {selected ? <em>Selected</em> : null}
      </span>
      <span
        className="terminal-theme-preview-screen"
        style={
          {
            '--theme-background': palette.background,
            '--theme-foreground': palette.foreground,
            '--theme-green': palette.green,
            '--theme-blue': palette.brightBlue,
            '--theme-cursor': palette.cursor,
            '--theme-cursor-text': palette.cursorText,
            '--theme-selection': palette.selectionBackground,
            '--theme-selection-text': palette.selectionForeground,
          } as CSSProperties
        }
      >
        <span>
          <i>~/hvir</i> <b>git status</b>
        </span>
        <span className="terminal-theme-preview-selection">ready for review</span>
        <span className="terminal-theme-preview-cursor">_</span>
      </span>
      <span className="terminal-theme-swatches" aria-hidden="true">
        {colors.map((color, index) => (
          <i key={`${color}-${index}`} style={{ backgroundColor: color }} />
        ))}
      </span>
    </span>
  )
}

function ansiColors(theme: TerminalColorTheme): readonly string[] {
  return [
    theme.black,
    theme.red,
    theme.green,
    theme.yellow,
    theme.blue,
    theme.magenta,
    theme.cyan,
    theme.white,
    theme.brightBlack,
    theme.brightRed,
    theme.brightGreen,
    theme.brightYellow,
    theme.brightBlue,
    theme.brightMagenta,
    theme.brightCyan,
    theme.brightWhite,
  ]
}
