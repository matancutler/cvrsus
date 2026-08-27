import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import mammoth from 'mammoth'

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
