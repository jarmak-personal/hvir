import type { IpcRegistrar } from '../authority-router'
import type { IpcDeps } from '../deps'

type PreviewIpcDeps = Pick<IpcDeps, 'getProject' | 'rendererResources' | 'htmlPreviews'>

export function registerPreviewIpc(ipc: IpcRegistrar, deps: PreviewIpcDeps): void {
  ipc.handle('html-preview:create', async (req, context) => {
    const owner = context.owner()
    const { root, host } = deps.getProject()
    await ipc.authority.projectPath(req.path, root, host)
    deps.rendererResources.assertCurrent(owner)
    const preview = deps.htmlPreviews.create(req.content, owner, root)
    try {
      deps.rendererResources.register(
        owner,
        { lifetime: 'workspace', type: 'html-preview', root, id: preview.id },
        () => deps.htmlPreviews.release(preview.id, owner),
      )
      return preview
    } catch (error) {
      deps.htmlPreviews.release(preview.id, owner)
      throw error
    }
  })

  ipc.handleSend('html-preview:release', ({ id }, context) => {
    const owner = context.owner()
    void deps.rendererResources
      .disposeResource(owner, 'html-preview', id)
      .catch((error) => console.error('[html-preview] release failed', error))
  })
}
