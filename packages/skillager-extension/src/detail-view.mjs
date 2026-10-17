/* global AbortController */
import { libraryStatus } from './catalog.mjs'
import { catalogCli } from './catalog-cli.mjs'
import { sameCurrentLibrary } from './library-first-use.mjs'
import { sourcePages, loadInstructionImages } from './reader.mjs'
import { bindSelectedSkill } from './selected-skill-view.mjs'

/** One selected occurrence owns its body, position and contextual task lifecycle. */
export function bindSkillReader(document, client, ports) {
  const element = (id) => document.getElementById(id),
    body = element('instructions')
  let context = { visible: false },
    generation = 0
  const available = () => client.alive && context.visible
  const cli = catalogCli(
    client,
    () => context,
    () => generation,
  )
  const say = (message, kind = 'ready') => {
    element('reader-state').textContent = message
    element('reader-state').dataset.state = kind
  }
  const on = (id, event, callback) =>
    element(id)?.addEventListener(event, callback, { signal: client.signal })
  element('reader-manage').disabled = true
  const task = bindSelectedSkill(document, client, { context: () => context })
  let detailInput,
    selectedRead,
    sourceReceipt,
    instructionText = '',
    renderedHtml,
    reading = false,
    pendingSelection = false,
    selectedScroll = 0
  const positions = new Map()
  function setMode(mode) {
    body.dataset.mode = mode
    for (const name of ['rendered', 'source'])
      element(`${name}-mode`).setAttribute('aria-pressed', String(name === mode))
  }
  function rememberPosition() {
    if (detailInput) {
      positions.set(
        `${detailInput.row.host}:${detailInput.row.workspaceId ?? ''}:${detailInput.row.source}:${detailInput.row.path}`,
        {
          scroll: body.scrollTop,
          mode: body.dataset.mode,
        },
      )
      if (positions.size > 16) positions.delete(positions.keys().next().value)
    }
  }
  async function showInstructions(text, revision = generation) {
    if (body.dataset.mode === 'source') {
      body.textContent = text
      return
    }
    let renderReceipt
    try {
      let html = renderedHtml
      if (html === undefined) {
        const result = await client.request('source.render', { receipt: sourceReceipt })
        renderReceipt = result.receipt
        html = result.sourceFallback ? null : await sourcePages(client, renderReceipt)
      }
      if (!available() || revision !== generation || body.dataset.mode === 'source')
        return
      renderedHtml = html
      if (html === null) {
        body.textContent = text
        setMode('source')
        say(
          'Complete current instructions in Source mode · rendered output exceeds the display bound',
        )
      } else body.innerHTML = html
    } catch (error) {
      if (available() && revision === generation) {
        body.textContent = text
        setMode('source')
        say(
          `Complete current instructions in Source mode · Rendering unavailable: ${error.message}`,
          'stale',
        )
      }
    } finally {
      if (renderReceipt)
        await client
          .request('source.read', { receipt: renderReceipt, release: true })
          .catch(() => {})
    }
  }

  async function readSelected() {
    if (!available() || !detailInput?.row || reading) return
    const selecting = pendingSelection
    pendingSelection = false
    reading = true
    const controller = new AbortController()
    selectedRead = controller
    const revision = generation,
      row = detailInput.row
    let readingLibrary
    const scroll = selecting ? selectedScroll : body.scrollTop,
      mode = body.dataset.mode
    say('Reading selected current file…', 'loading')
    try {
      if (sourceReceipt)
        await client
          .request('source.read', { receipt: sourceReceipt, release: true })
          .catch(() => {})
      if (
        row.host !== 'local' ||
        (row.source === 'project' && row.workspaceId !== context.workspace?.id)
      )
        throw new Error('Selected source does not match its observing host/workspace')
      if (row.source === 'library') {
        // Selected metadata prefills a proposal, not authority or current library truth.
        // Bounded detail input can omit the root; resolve it through public status then.
        const observed = detailInput.library?.root
          ? detailInput.library
          : sameCurrentLibrary(
              detailInput.library,
              libraryStatus(await cli(['library', 'status', '--json'])),
            )
        if (!available() || revision !== generation) return
        readingLibrary = observed
        const decision = await client.request(
          'source.request',
          {
            source: 'library',
            root: { hostId: 'local', path: observed.root },
          },
          controller.signal,
        )
        if (!available() || revision !== generation) return
        if (!decision.granted) {
          say('Read access was not granted. The skill remains selected.', 'unapproved')
          return
        }
        sameCurrentLibrary(
          observed,
          libraryStatus(await cli(['library', 'status', '--json'])),
        )
        if (!available() || revision !== generation) return
      }
      const selected = await client.request('source.select', {
        source: row.source,
        path: { hostId: row.host, path: row.path },
        ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
      })
      if (!available() || revision !== generation) return
      sourceReceipt = selected.receipt
      const text = await sourcePages(client, selected.receipt)
      if (readingLibrary)
        sameCurrentLibrary(
          readingLibrary,
          libraryStatus(await cli(['library', 'status', '--json'])),
        )
      if (!available() || revision !== generation) return
      instructionText = text
      renderedHtml = undefined
      body.dataset.mode = mode
      await showInstructions(text, revision)
      if (!available() || revision !== generation) return
      body.scrollTop = scroll
      element('detail-title').textContent = row.name
      element('source-label').textContent =
        `${row.kind} · ${selected.path.hostId}: ${selected.path.path}`
      element('details').dataset.sha256 = selected.sha256
      element('details').textContent =
        `Observation: ${row.status} · Current file read ${new Date(selected.readAt).toLocaleTimeString()} · File SHA-256 ${selected.sha256}. Current-file bytes are not an accepted tree snapshot. Reading does not approve or run this skill.${row.matched && row.matched !== row.skillId ? ` Ranking matched ${row.matched}.` : ''}`
      element('canonical').hidden = !row.canonical
      if (body.dataset.mode !== 'source' || mode === 'source') say('')
      if (body.dataset.mode !== 'source')
        await loadInstructionImages(
          client,
          body,
          selected.receipt,
          () => available() && revision === generation && body.dataset.mode !== 'source',
        )
    } catch (error) {
      if (available() && revision === generation)
        say(
          `${error.message} · The selected source remains selected; no other occurrence was substituted.`,
          'error',
        )
    } finally {
      controller.abort()
      if (selectedRead === controller) selectedRead = undefined
      reading = false
      if (pendingSelection && available()) void readSelected()
    }
  }
  on('read-current', 'click', () => {
    selectedScroll = body.scrollTop
    selectedRead?.abort()
    generation++
    pendingSelection = true
    void readSelected()
  })
  on('reveal-original', 'click', async () => {
    const row = detailInput?.row
    if (
      !available() ||
      row?.source !== 'project' ||
      row.kind !== 'Project original' ||
      row.workspaceId !== context.workspace?.id ||
      row.host !== context.workspace?.host
    )
      return
    try {
      await client.request('source.reveal', {
        source: 'project',
        workspaceId: row.workspaceId,
        path: { hostId: row.host, path: row.path.slice(0, row.path.lastIndexOf('/')) },
      })
      say(
        'Original folder revealed in Files. Its separate file actions own deletion; no original was removed.',
      )
    } catch (error) {
      say(error.message, 'error')
    }
  })
  on('source-mode', 'click', () => {
    if (instructionText) {
      body.textContent = instructionText
      setMode('source')
    }
  })
  on('rendered-mode', 'click', () => {
    if (instructionText) {
      setMode('rendered')
      const revision = generation,
        receipt = sourceReceipt
      void showInstructions(instructionText, revision).then(
        () =>
          available() &&
          revision === generation &&
          receipt &&
          loadInstructionImages(
            client,
            body,
            receipt,
            () =>
              available() && revision === generation && body.dataset.mode !== 'source',
          ),
      )
    }
  })
  on('canonical', 'click', async () => {
    const canonical = detailInput?.row.canonical
    if (!canonical || !available()) return
    try {
      const value = await cli(['library', 'status', canonical.skill_id, '--json']),
        current = libraryStatus(value)
      if (
        !current.initialized ||
        current.id !== canonical.library_id ||
        !canonical.skill_id.startsWith('lib/') ||
        value.skill?.id !== canonical.skill_id ||
        value.skill?.status === 'missing'
      )
        throw new Error(
          'Canonical relationship no longer matches the connected current library',
        )
      await ports.choose(
        {
          id: canonical.skill_id,
          name: value.skill.name ?? canonical.skill_id,
          description: value.skill.summary ?? '',
          path: value.skill.entrypoint,
          source: 'library',
          host: 'local',
          kind: 'Your library',
          status: value.skill.acceptance ?? 'observed',
        },
        current,
      )
    } catch (error) {
      say(error.message, 'error')
    }
  })

  on('close-instructions', 'click', () => {
    rememberPosition()
    selectedRead?.abort()
    generation++
    pendingSelection = false
    detailInput = undefined
    task.select(undefined)
    element('reader-content').hidden = true
    element('reader-empty')?.removeAttribute('hidden')
  })
  on('reader-manage', 'click', () => {
    if (!available()) return
    void client
      .request('viewer.open-own', {
        contributionId: 'management',
        ...(detailInput?.row.source === 'library'
          ? {
              input: {
                row: {
                  id: detailInput.row.canonical?.skill_id ?? detailInput.row.id,
                  source: 'library',
                },
              },
            }
          : {}),
      })
      .catch((error) => say(error.message, 'error'))
  })
  function select(input) {
    rememberPosition()
    selectedRead?.abort()
    generation++
    detailInput = input
    element('reader-empty')?.setAttribute('hidden', '')
    element('reader-content').hidden = false
    element('detail-title').textContent = input.row.name
    element('reveal-original').hidden =
      input.row.source !== 'project' || input.row.kind !== 'Project original'
    pendingSelection = true
    instructionText = ''
    renderedHtml = undefined
    body.replaceChildren()
    const position = positions.get(
      `${input.row.host}:${input.row.workspaceId ?? ''}:${input.row.source}:${input.row.path}`,
    )
    setMode(position?.mode ?? 'rendered')
    selectedScroll = position?.scroll ?? 0
    task.select(input)
    if (available()) void readSelected()
  }
  return {
    select,
    context(next) {
      const changed =
          JSON.stringify(next.workspace) !== JSON.stringify(context.workspace),
        hidden = !next.visible,
        renewed = next.visible && !context.visible
      context = next
      element('reader-manage').disabled = !available()
      if (changed || hidden) {
        selectedRead?.abort()
        generation++
      }
      if (changed || hidden || renewed) task.contextChanged()
      if (next.input && next.input.selection !== detailInput?.selection)
        select(next.input)
      else if (pendingSelection && available()) void readSelected()
    },
    dispose() {
      selectedRead?.abort()
      generation++
      task.dispose()
      element('reader-manage').disabled = true
    },
  }
}
