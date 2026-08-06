import { clipboard } from 'electron'

import {
  readClipboardFileList,
  type ClipboardFileListFormat,
  type ClipboardFileListSource,
} from './clipboard-file-list'

/** Electron edge read only by the explicit Files paste command. */
export class ElectronClipboardFileSource implements ClipboardFileListSource {
  constructor(
    private readonly source: Pick<
      typeof clipboard,
      'availableFormats' | 'readBuffer'
    > = clipboard,
  ) {}

  availableFormats(): readonly string[] {
    return this.source.availableFormats()
  }

  readBuffer(format: ClipboardFileListFormat): Uint8Array {
    return this.source.readBuffer(format)
  }

  readPaths(): readonly string[] {
    return readClipboardFileList(this)
  }
}
