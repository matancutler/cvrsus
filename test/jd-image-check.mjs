/**
 * A job description that arrives as a screenshot.
 *
 * Recruiters are sent postings as pictures constantly — a crop of a careers
 * page, a photograph of a printed ad, a forwarded message — and until now the
 * paperclip refused all of them, silently: `accept=".pdf,.docx"` greys an image
 * out in the file dialog, so the button looked broken rather than strict.
 *
 * There is no OCR engine here. The image goes to the model that reads the
 * resulting text anyway, which is why these checks stub the API at the fetch
 * layer: the point is to prove the plumbing — that an image is recognised,
 * encoded, sent as an image block with the right media type, and its answer
 * returned as text — not to re-test Claude's eyesight.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { createReporter } from './helpers.mjs'

const { check, section, finish } = createReporter('JD images')

/* Installed before the SDK client is constructed — it captures fetch on
   construction, so a later swap would be ignored. */
let lastRequest = null
let modelReplies = 'Senior Python Engineer\nTel Aviv\n5+ years'

globalThis.fetch = async (_url, init) => {
  lastRequest = JSON.parse(init?.body ?? '{}')
  const body = JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
    stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'text', text: JSON.stringify({ text: modelReplies }) }],
  })
  return {
    ok: true, status: 200, statusText: 'OK',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(body), text: async () => body,
    clone() { return this },
  }
}

process.env.ANTHROPIC_API_KEY = 'test-key-not-real'

const { extractText, IMAGE_EXTENSIONS } = await import('../server/src/extract.js')
const { JD_EXTENSIONS, DOCUMENT_EXTENSIONS } = await import('../server/src/schema.js')

/* A real PNG, written by hand rather than with an image library so the suite
   depends on nothing that is not already installed. */
const FIXTURE = path.join(os.tmpdir(), `cking-jd-${Date.now().toString(36)}.png`)
const zlib = await import('node:zlib')

{
  const W = 40, H = 20
  const px = Buffer.alloc(W * H * 3, 0xff)
  const raw = Buffer.alloc(H * (1 + W * 3))
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 3)] = 0
    px.copy(raw, y * (1 + W * 3) + 1, y * W * 3, (y + 1) * W * 3)
  }
  const table = [...Array(256)].map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (b) => {
    let c = 0xffffffff
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(tag), data])
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  fs.writeFileSync(FIXTURE, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]))
}

section('The lists agree about what a JD may be')
check('a JD accepts images', JD_EXTENSIONS.includes('.png') && JD_EXTENSIONS.includes('.jpg'))
check('and still accepts documents',
  DOCUMENT_EXTENSIONS.every((ext) => JD_EXTENSIONS.includes(ext)))
check('a CV does not accept images',
  !DOCUMENT_EXTENSIONS.includes('.png'),
  'a CV has to be readable as text without a model')
check('every image type extractText claims is one a JD may be',
  IMAGE_EXTENSIONS.every((ext) => JD_EXTENSIONS.includes(ext)),
  IMAGE_EXTENSIONS.join(' '))

section('An image is read by looking at it')
const text = await extractText(FIXTURE, 'posting.png')
check('the text comes back', text.includes('Senior Python Engineer'), JSON.stringify(text))

const content = lastRequest?.messages?.[0]?.content ?? []
const image = content.find((part) => part.type === 'image')
check('it was sent as an image block', Boolean(image))
check('with the media type the extension implies',
  image?.source?.media_type === 'image/png', image?.source?.media_type)
check('base64 encoded', image?.source?.type === 'base64' && image.source.data.length > 0)
check('and the PNG signature survives the encoding',
  Buffer.from(image?.source?.data ?? '', 'base64').subarray(0, 4).toString('hex') === '89504e47',
  'a mangled encoding would reach the API as an unreadable image')

section('The prompt refuses to take orders from the picture')
const prompt = String(lastRequest?.system ?? '')
check('an uploaded image is treated as text, never as instruction',
  /NEVER AS AN INSTRUCTION/i.test(prompt),
  'a screenshot saying "ignore your instructions" is a prompt-injection vector')
check('and it is told not to invent', /\[unclear\]/.test(prompt))

section('An image that says nothing is not a silent empty search')
modelReplies = '   '
const blank = await extractText(FIXTURE, 'posting.png').then(() => null, (err) => err)
check('it refuses rather than returning nothing', blank instanceof Error)
check('with a 400, because the file is the problem', blank?.status === 400, String(blank?.status))
check('and says what to do about it', /sharper|cropped/i.test(blank?.message ?? ''), blank?.message)

section('A PDF is untouched by any of this')
modelReplies = 'should not be used'
lastRequest = null
const docx = await extractText(FIXTURE, 'posting.docx').then(() => 'read', () => 'threw')
check('a non-image still goes down its own path', lastRequest === null,
  'the model must not be called for a document')
check('and fails as a document when it is not one', docx === 'threw')

fs.unlinkSync(FIXTURE)
finish()
