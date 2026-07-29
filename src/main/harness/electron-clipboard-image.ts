import { clipboard } from 'electron'

import {
  REMOTE_IMAGE_PASTE_MAX_BYTES,
  REMOTE_IMAGE_PASTE_MAX_DIMENSION,
  REMOTE_IMAGE_PASTE_MAX_PIXELS,
  type ClipboardPng,
  type ClipboardPngSource,
  RemoteImagePasteCoordinator,
  type RemoteImagePasteCoordinatorOptions,
} from './remote-image-paste'

/** Reads the application host clipboard only when called for an explicit gesture. */
export class ElectronClipboardPngSource implements ClipboardPngSource {
  read(): ClipboardPng | 'too-large' | undefined {
    const image = clipboard.readImage()
    if (image.isEmpty()) return undefined
    const { width, height } = image.getSize(1)
    if (
      width < 1 ||
      height < 1 ||
      width > REMOTE_IMAGE_PASTE_MAX_DIMENSION ||
      height > REMOTE_IMAGE_PASTE_MAX_DIMENSION ||
      width * height > REMOTE_IMAGE_PASTE_MAX_PIXELS
    ) {
      return 'too-large'
    }
    const bytes = image.toPNG()
    return bytes.byteLength > REMOTE_IMAGE_PASTE_MAX_BYTES
      ? 'too-large'
      : { width, height, bytes }
  }
}

export function createElectronRemoteImagePasteCoordinator(
  options: Omit<RemoteImagePasteCoordinatorOptions, 'clipboard'>,
): RemoteImagePasteCoordinator {
  return new RemoteImagePasteCoordinator({
    ...options,
    clipboard: new ElectronClipboardPngSource(),
  })
}
