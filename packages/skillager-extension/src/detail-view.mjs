/* global AbortController */
import { libraryStatus, occurrenceFolder } from './catalog.mjs'
import { catalogCli } from './catalog-cli.mjs'
import { sameCurrentLibrary } from './library-first-use.mjs'
import { sourcePages, loadInstructionImages } from './reader.mjs'
import { bindSelectedTaskSurface } from './selected-task-surface.mjs'

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
  const tasks = bindSelectedTaskSurface(document, client, {
    context: () => context,
    choose: ports.choose,
    changed: ports.changed,
  })
  const { exposure } = tasks
  let detailInput,
    selectedRead,
    sourceReceipt,
    instructionText = '',
    renderedRead,
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
  function showSource(text) {
    // Move the exact rendered nodes; a representation change grants no new source read.
    if (renderedRead?.attached) {
      renderedRead.renderedScroll = body.scrollTop
      while (body.firstChild) renderedRead.content.appendChild(body.firstChild)
      renderedRead.attached = false
    }
    if (body.dataset.mode === 'source' && body.textContent === text) return
    body.textContent = text
    body.scrollTop = renderedRead?.sourceScroll ?? 0
  }
  async function showInstructions(text, revision = generation) {
    if (body.dataset.mode === 'source') {
      showSource(text)
      return
    }
    const read = renderedRead
    try {
      if (!read.ready) {
        if (!read.pending) {
          if (
            !available() ||
            read.revision !== generation ||
            read.controller.signal.aborted
          )
            throw new Error('Use Read current to prepare the rendered document')
          read.pending = (async () => {
            let receipt
            try {
              const result = await client.request(
                'source.render',
                { receipt: read.receipt },
                read.controller.signal,
              )
              receipt = result.receipt
              const html = result.sourceFallback
                ? null
                : await sourcePages(client, receipt, read.controller.signal)
              const current = () =>
                available() &&
                read === renderedRead &&
                read.revision === generation &&
                !read.controller.signal.aborted
              if (!current()) return
              read.ready = true
              if (html === null) read.content = null
              else {
                const template = document.createElement('template')
                template.innerHTML = html
                read.content = template.content
                // One admitted image pass can finish while Source is shown. Selection,
                // visibility and read retirement still cancel its public requests.
                read.images = loadInstructionImages(
                  client,
                  read.content,
                  read.receipt,
                  current,
                  read.controller.signal,
                )
              }
            } finally {
              if (receipt)
                await client
                  .request('source.read', { receipt, release: true })
                  .catch(() => {})
            }
          })()
        }
        await read.pending
      }
      if (
        !available() ||
        read !== renderedRead ||
        !read.ready ||
        body.dataset.mode === 'source'
      )
        return
      if (read.content === null) {
        showSource(text)
        setMode('source')
        say(
          'Complete current instructions in Source mode · rendered output exceeds the display bound',
        )
      } else if (!read.attached) {
        read.sourceScroll = body.scrollTop
        body.replaceChildren(read.content)
        body.scrollTop = read.renderedScroll ?? 0
        read.attached = true
      }
    } catch (error) {
      if (available() && read === renderedRead && revision === generation) {
        showSource(text)
        setMode('source')
        say(
          `Complete current instructions in Source mode · Rendering unavailable: ${error.message}`,
          'stale',
        )
      }
    }
  }

  async function readSelected() {
    if (
      !available() ||
      !detailInput?.row ||
      reading ||
      detailInput.row.kind === 'Installed Router'
    )
      return
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
      if (row.source === 'project') {
        const decision = await client.request(
          'source.request',
          { source: 'project' },
          controller.signal,
        )
        if (!available() || revision !== generation) return
        if (!decision.granted) {
          say('Read access was not granted.', 'unapproved')
          return
        }
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
      renderedRead?.controller.abort()
      renderedRead = {
        receipt: selected.receipt,
        revision,
        controller: new AbortController(),
      }
      body.dataset.mode = mode
      await showInstructions(text, revision)
      if (!available() || revision !== generation) return
      body.scrollTop = scroll
      element('detail-title').textContent = row.name
      element('source-label').textContent =
        `${row.kind} · ${selected.path.hostId}: ${selected.path.path}`
      element('details').dataset.sha256 = selected.sha256
      element('details').textContent =
        `Read ${new Date(selected.readAt).toLocaleTimeString()} · SHA-256 ${selected.sha256}`
      element('canonical').hidden = !row.canonical
      if (body.dataset.mode !== 'source' || mode === 'source') say('')
      await renderedRead.images
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
    if (detailInput?.row.kind === 'Installed Router') {
      void exposure.refresh()
      return
    }
    selectedScroll = body.scrollTop
    selectedRead?.abort()
    renderedRead?.controller.abort()
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
        path: occurrenceFolder(row),
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
      showSource(instructionText)
      setMode('source')
      if (
        renderedRead?.revision === generation &&
        element('reader-state').dataset.state === 'loading'
      )
        say('')
    }
  })
  on('rendered-mode', 'click', () => {
    if (instructionText) {
      setMode('rendered')
      void showInstructions(instructionText)
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
    renderedRead?.controller.abort()
    renderedRead = undefined
    instructionText = ''
    body.replaceChildren()
    generation++
    pendingSelection = false
    detailInput = undefined
    tasks.select(undefined)
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
    renderedRead?.controller.abort()
    generation++
    detailInput = input
    element('reader-empty')?.setAttribute('hidden', '')
    element('reader-content').hidden = false
    element('detail-title').textContent = input.row.name
    element('reveal-original').hidden =
      input.row.source !== 'project' || input.row.kind !== 'Project original'
    pendingSelection = true
    instructionText = ''
    renderedRead = undefined
    body.replaceChildren()
    const position = positions.get(
      `${input.row.host}:${input.row.workspaceId ?? ''}:${input.row.source}:${input.row.path}`,
    )
    setMode(position?.mode ?? 'rendered')
    selectedScroll = position?.scroll ?? 0
    const router = input.row.kind === 'Installed Router'
    for (const id of ['instructions', 'rendered-mode', 'source-mode', 'canonical'])
      element(id).hidden = router
    element('source-label').textContent =
      `${input.row.kind} · ${input.row.host}: ${input.row.path}`
    element('details').textContent = ''
    tasks.select(input)
    if (router) {
      pendingSelection = false
      say('')
    }
    if (available()) void readSelected()
  }
  return {
    tasks,
    restoreTasks: () => tasks.select(detailInput, { prepare: false }),
    select,
    context(next, options = {}) {
      const changed =
          JSON.stringify(next.workspace) !== JSON.stringify(context.workspace),
        hidden = !next.visible,
        renewed = next.visible && !context.visible
      context = next
      element('reader-manage').disabled = !available()
      if (changed || hidden) {
        if (reading && element('reader-state').dataset.state === 'loading')
          say('Read interrupted. Choose … → Refresh instructions.', 'stale')
        selectedRead?.abort()
        renderedRead?.controller.abort()
        generation++
      }
      if (options.tasks !== false) {
        if (renewed && detailInput) tasks.select(detailInput, { prepare: false })
        else if (changed || hidden) tasks.contextChanged()
      }
      if (next.input && next.input.selection !== detailInput?.selection)
        select(next.input)
      else if (pendingSelection && available()) void readSelected()
    },
    dispose() {
      selectedRead?.abort()
      renderedRead?.controller.abort()
      renderedRead = undefined
      instructionText = ''
      body.replaceChildren()
      generation++
      tasks.dispose()
      element('reader-manage').disabled = true
    },
  }
}
