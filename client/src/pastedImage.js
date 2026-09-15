/**
 * The image on the clipboard, if there is one, as a file worth uploading.
 *
 * Pasting a screenshot is how people move a job description around — it is
 * quicker than saving the picture and finding it again in a file dialog, and it
 * is what somebody tries first after taking the screenshot. Handling it is a
 * few lines; not handling it reads as the paste being broken.
 *
 * Returns null for anything that is not an image, so ordinary text paste falls
 * through untouched and the caller does not have to think about it.
 */

const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export default function pastedImage(clipboardData) {
  const items = [...(clipboardData?.items ?? [])]
  const entry = items.find((item) => (
    item.kind === 'file' && EXTENSIONS[item.type]
  ))
  if (!entry) return null

  const file = entry.getAsFile()
  if (!file) return null

  /*
   * A name, because the server decides how to read a file by its extension.
   *
   * Chrome hands over "image.png" and Safari hands over an empty name, and on
   * Windows a screenshot pasted from the clipboard often arrives as a bare
   * blob. `path.extname('')` is '', which the upload refuses as an unsupported
   * type — so the name is rebuilt from the MIME type, which is the one thing
   * every browser does set.
   */
  const extension = EXTENSIONS[file.type] ?? EXTENSIONS[entry.type]
  const named = /\.[a-z0-9]+$/i.test(file.name ?? '')

  return named ? file : new File([file], `pasted-image.${extension}`, { type: file.type || entry.type })
}
