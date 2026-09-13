/**
 * Upload sniffing and rate limiting.
 *
 * Both exist because the two things this app accepts from strangers — files and
 * requests — are the two it cannot afford to take on trust. A CV is an
 * arbitrary binary from an unauthenticated person, and every public endpoint is
 * reachable by anyone who can type a URL.
 */
import fs from 'node:fs'
import path from 'node:path'

// ------------------------------------------------------------ file sniffing ---

/**
 * Signatures checked against a file's actual first bytes.
 *
 * An extension is a naming convention and Content-Type is a claim by the
 * uploader; neither is evidence. `payload.pdf` can be an HTML page, and a
 * browser asked to render it inline will run the script inside it.
 */
const SIGNATURES = [
  { type: 'application/pdf', ext: '.pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  // DOCX is a ZIP container, and so is a lot else — which is why the extension
  // must still agree. This says "a zip"; only .docx is offered as a document.
  { type: 'application/zip', ext: '.docx', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { type: 'image/jpeg', ext: '.jpg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/jpeg', ext: '.jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', ext: '.png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // RIFF....WEBP — a size field sits between, so the tail is checked separately.
  {
    type: 'image/webp',
    ext: '.webp',
    bytes: [0x52, 0x49, 0x46, 0x46],
    tail: { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  },
]

/**
 * Markup a browser would execute if it ever rendered the file.
 *
 * Checked explicitly rather than left to fail the allow-list, so the rejection
 * can say what was wrong. An SVG is a script container wearing an image's name,
 * which is why it is refused even where images are welcome.
 */
const MARKUP = [
  { label: 'an SVG', pattern: /<svg[\s>]/i },
  { label: 'an HTML page', pattern: /<!doctype\s+html|<html[\s>]|<script[\s>]/i },
]

const matches = (buffer, bytes, at = 0) =>
  bytes.every((byte, index) => buffer[at + index] === byte)

/**
 * What a file actually is, by content. Null for anything unrecognised.
 *
 * Reads only the head — enough for every signature, and it never pulls a 5MB
 * upload into memory to answer a question about its first eight bytes.
 */
export function sniffFile(filePath) {
  let handle
  try {
    handle = fs.openSync(filePath, 'r')
    const head = Buffer.alloc(256)
    const read = fs.readSync(handle, head, 0, 256, 0)
    const slice = head.subarray(0, read)

    // Markup first: leading whitespace or a BOM must not hide the tag.
    for (const { label, pattern } of MARKUP) {
      if (pattern.test(slice.toString('utf8'))) return { markup: label }
    }

    for (const signature of SIGNATURES) {
      if (!matches(slice, signature.bytes)) continue
      if (signature.tail && !matches(slice, signature.tail.bytes, signature.tail.at)) continue
      return { type: signature.type, ext: signature.ext }
    }

    return null
  } catch {
    return null
  } finally {
    if (handle !== undefined) fs.closeSync(handle)
  }
}

class UploadRejected extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

/**
 * Throws unless the file's real content matches one of `allowedExtensions`.
 *
 * The extension must agree with the content: a DOCX and an XLSX are both ZIPs,
 * and accepting "it is a zip" would accept a spreadsheet as a CV.
 */
export function assertFileContent(filePath, allowedExtensions, { label = 'file' } = {}) {
  const found = sniffFile(filePath)

  if (found?.markup) {
    throw new UploadRejected(
      `That ${label} is ${found.markup}, not a document or an image. Markup files are `
      + 'refused because a browser would run the script inside them.',
    )
  }

  if (!found) {
    throw new UploadRejected(
      `That ${label} is not a type we accept. Its contents do not match a PDF, DOCX, `
      + 'JPG, PNG or WebP, whatever the filename says.',
    )
  }

  if (!allowedExtensions.includes(found.ext)) {
    throw new UploadRejected(
      `That ${label} is really a ${found.ext.replace('.', '').toUpperCase()} file. `
      + `Accepted here: ${allowedExtensions.join(', ')}.`,
    )
  }

  /*
   * And the name has to agree with the bytes, not merely be on the same list.
   *
   * "The extension must agree with the content" is what this function has
   * always claimed to do, and until now it only asked whether the CONTENT was
   * allowed. For a CV both .pdf and .docx are, so a DOCX named cv.pdf satisfied
   * every check above — and then extractText dispatches on the FILENAME, handed
   * a zip to the PDF parser, and pdfjs threw something that is not an
   * UploadRejected. The caller got a 500 and a stack trace in the log for what
   * is an ordinary mistake: somebody renamed a file instead of exporting it.
   *
   * It read as refused for years because the error handler used to report every
   * unhandled throw as a 400 — the same status this raises — so the security
   * suite's "a DOCX renamed .pdf is refused" passed on a crash rather than on a
   * refusal. Giving internal faults their own status is what made the
   * difference visible.
   *
   * .jpg and .jpeg are one format under two names and the signature table
   * answers .jpg for both, so they are compared as equals rather than by string.
   */
  const claimed = path.extname(filePath).toLowerCase()
  const same = (a, b) => {
    const canon = (e) => (e === '.jpeg' ? '.jpg' : e)
    return canon(a) === canon(b)
  }

  if (claimed && !same(claimed, found.ext)) {
    throw new UploadRejected(
      `That ${label} is named ${claimed} but its contents are a `
      + `${found.ext.replace('.', '').toUpperCase()} file. Save it as a real `
      + `${claimed.replace('.', '').toUpperCase()} and upload it again.`,
    )
  }

  return found
}

// ------------------------------------------------------------ rate limiting ---

/**
 * A fixed-window counter, held in memory.
 *
 * In memory means per process: it holds for a single server, and a multi-node
 * deployment needs a shared store or the effective limit multiplies by the node
 * count. Stated here rather than discovered in production.
 *
 * Keyed by IP by default. Behind a proxy this needs `app.set('trust proxy', …)`,
 * or every request appears to come from the load balancer and one visitor locks
 * out everyone.
 */
const buckets = new Map()
let lastSweep = 0

/** Bounded sweep, so a long-running process cannot grow the map forever. */
function sweep(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}

export function rateLimit({ windowMs, max, keyOn, message }) {
  return (req, res, next) => {
    const now = Date.now()
    if (now - lastSweep > windowMs) { sweep(now); lastSweep = now }

    const who = keyOn ? keyOn(req) : (req.ip ?? req.socket?.remoteAddress ?? 'unknown')
    const key = `${req.method} ${req.route?.path ?? req.path}|${who}`

    const bucket = buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }

    bucket.count += 1
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
      res.setHeader('Retry-After', String(retryAfter))
      return res.status(429).json({
        error: message ?? `Too many requests. Try again in ${retryAfter} second(s).`,
      })
    }

    return next()
  }
}

/** Clears every counter. Tests only — never call this from a request path. */
export function resetRateLimits() {
  buckets.clear()
}
