import { createWorkerClient, workerPath } from '../worker-host'
import type { DocumentMarkdownProtocol } from '../../shared/presentation/document-markdown/contract'
import { DocumentMarkdownOwner } from './document-markdown-owner'
/** Native document adapter reuses established utility-process mechanics, without host calls. */
export function createDocumentMarkdownOwner(): DocumentMarkdownOwner {
  return new DocumentMarkdownOwner(() => {
    const worker = createWorkerClient<DocumentMarkdownProtocol>(
      workerPath('document-worker.js'),
      'hvir-document',
    )
    return {
      render: async (text) => (await worker.request('render', text)).html,
      dispose: () => worker.dispose(),
    }
  })
}
