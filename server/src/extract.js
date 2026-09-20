import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import mammoth from 'mammoth'

import { transcribeImage } from './ai.js'

const require = createRequire(import.meta.url)
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))

// Resolved through the filesystem rather than the package exports map, which
// keeps this working regardless of how pdfjs-dist declares its entry points.
const pdfjsEntry = pathToFileURL(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.mjs')).href
const standardFontDataUrl = pathToFileURL(path.join(pdfjsRoot, 'standard_fonts') + path.sep).href

let pdfjs = null

/** pdfjs-dist is ESM-only and slow to initialise, so it is loaded once, lazily. */
async function loadPdfjs() {
  if (!pdfjs) pdfjs = await import(pdfjsEntry)
  return pdfjs
}

/** Spec §5.2 — every document slot accepts PDF or DOCX. */
export const SUPPORTED_EXTENSIONS = ['.pdf', '.docx']

/*
 * The types that are read by looking at them rather than by parsing them.
 *
 * Kept next to the parsers because the difference matters to the caller: these
 * cost a model call and need a key, where a PDF costs neither.
 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']

const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/*
 * Below the API's own per-image ceiling, with room for base64.
 *
 * Base64 inflates by a third, so the 5MB an upload is allowed to be becomes
 * about 6.7MB on the wire and is refused there — as a generic failure, several
 * seconds after the person pressed the button. Refusing it here costs nothing
 * and can say which file and why.
 */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024

class UnreadableImage extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

/** Pulls plain text out of an uploaded CV. Throws on unsupported types. */
export async function extractText(filePath, originalName) {
  const ext = path.extname(originalName || filePath).toLowerCase()

  if (ext === '.pdf') {
    return normalize(await extractPdf(filePath))
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath })
    return normalize(result.value)
  }

  /*
   * Markdown is already the text; there is nothing to extract from it.
   *
   * The syntax is left in place rather than stripped. What reads this is a
   * model, and a heading marked with a hash or a requirement marked with a
   * dash is structure it can use — removing the marks to produce "clean"
   * prose would throw away the outline of the posting and leave a wall of
   * sentences. Size is bounded by the upload limit, as every other format is.
   */
  if (ext === '.md' || ext === '.markdown') {
    return normalize(await fs.readFile(filePath, 'utf8'))
  }

  if (IMAGE_EXTENSIONS.includes(ext)) {
    const bytes = await fs.readFile(filePath)

    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new UnreadableImage(
        'That image is too large to read. Crop it, or save the posting as a PDF.',
      )
    }

    const text = await transcribeImage(bytes.toString('base64'), IMAGE_MEDIA_TYPES[ext])

    /* null means the model was unreachable or unconfigured; an empty string
       means it looked and there were no words. Different problems, and the
       person can act on only one of them. */
    if (text === null) {
      throw new UnreadableImage(
        'Reading images is unavailable right now. Attach a PDF or Word file, or paste the text.',
      )
    }
    if (!text.trim()) {
      throw new UnreadableImage(
        'No text could be read from that image. A sharper or less cropped picture usually works.',
      )
    }

    return normalize(text)
  }

  if (ext === '.txt' || ext === '.md') {
    return normalize(await fs.readFile(filePath, 'utf8'))
  }

  throw new Error(`Unsupported file type "${ext}". Upload a PDF or DOCX file.`)
}

/**
 * Reads every page's text layer. Scanned PDFs have no text layer and yield an
 * empty string, which the caller turns into a "please upload a text-based
 * version" message.
 */
async function extractPdf(filePath) {
  const { getDocument } = await loadPdfjs()
  const data = new Uint8Array(await fs.readFile(filePath))

  const loadingTask = getDocument({
    data,
    standardFontDataUrl,
    isEvalSupported: false,
    useSystemFonts: false,
  })
  const doc = await loadingTask.promise

  try {
    const pages = []
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber)
      const content = await page.getTextContent()

      let text = ''
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue
        text += item.str
        if (item.hasEOL) text += '\n'
      }
      pages.push(text)
      page.cleanup()
    }
    return pages.join('\n')
  } finally {
    // Releases the worker and its buffers; without this each upload leaks memory.
    await loadingTask.destroy()
  }
}

/** Collapses the ragged whitespace PDF extraction tends to produce. */
function normalize(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Years of experience used to be estimated here from employment date ranges.
// That heuristic is gone: it was guesswork presented as a number, and a wrong
// one shaped both the match score and what a recruiter saw.
