/**
 * A job description pasted or attached as a picture.
 *
 * Two controls reach the same route and only one of them was widened: the
 * search composer took images while the Triage builder — a separate paperclip
 * on a separate page — still offered ".pdf,.docx", so the file dialog greyed
 * out every screenshot in the folder. Both are checked here so the next person
 * to add an attach control finds out that there is more than one.
 *
 * pastedImage is checked directly because the case that breaks it cannot be
 * seen by eye: a clipboard blob with no filename, which the server refuses as
 * an unsupported type because path.extname('') is ''.
 */
import fs from 'node:fs'

import { createReporter } from './helpers.mjs'
import pastedImage from '../client/src/pastedImage.js'
import { JD_EXTENSIONS } from '../server/src/schema.js'

const { check, section, finish } = createReporter()

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

section('Every control that attaches a job description offers pictures')
for (const [label, path] of [
  ['the search composer', '../client/src/components/SearchHero.jsx'],
  ['the Triage builder', '../client/src/components/TriageTab.jsx'],
]) {
  const source = read(path)
  /* One accept is a plain string and the other is a ternary on a prop, so the
     match runs to the end of the attribute rather than assuming a quote comes
     first. Only the accepts that mention .pdf are job-description controls —
     the Triage CV picker is documents-only by design. */
  const accepts = [...source.matchAll(/accept=.*/g)]
    .map((m) => m[0])
    .filter((a) => a.includes('.pdf'))
  check(`${label} has a job-description picker`, accepts.length > 0)
  check(`${label} offers images`, accepts.some((a) => /png/.test(a)),
    accepts.join(' | ') || 'no accept attribute found')
}

section('And both take a pasted one')
for (const [label, path] of [
  ['the search composer', '../client/src/components/SearchHero.jsx'],
  ['the Triage builder', '../client/src/components/TriageTab.jsx'],
]) {
  const source = read(path)
  check(`${label} handles paste`, /onPaste=/.test(source) && /pastedImage\(/.test(source),
    'a textarea ignores a pasted image unless something reads the clipboard')
}

section('A clipboard image becomes a file the server can read')
/* The shape a browser actually hands over: an items list whose entries answer
   kind, type and getAsFile(). */
const clipboard = (name, type) => ({
  items: [{
    kind: 'file',
    type,
    getAsFile: () => new File([new Uint8Array([1, 2, 3])], name, { type }),
  }],
})

const named = pastedImage(clipboard('screenshot.png', 'image/png'))
check('a named PNG keeps its name', named?.name === 'screenshot.png', named?.name)

/* Safari, and a Windows screenshot pasted straight from the clipboard. */
const blank = pastedImage(clipboard('', 'image/png'))
check('a nameless blob is given one', Boolean(blank?.name), blank?.name)
check('and the extension matches its type', blank?.name?.endsWith('.png'), blank?.name,)

const jpeg = pastedImage(clipboard('', 'image/jpeg'))
check('a JPEG is named .jpg, not .jpeg', jpeg?.name?.endsWith('.jpg'), jpeg?.name)

section('The name it invents is one the upload accepts')
for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
  const file = pastedImage(clipboard('', type))
  const ext = `.${file.name.split('.').pop()}`
  check(`${type} → ${ext} is an accepted job-description type`,
    JD_EXTENSIONS.includes(ext),
    'the server decides how to read a file by its extension')
}

section('Both server gates agree about what a job description may be')
/*
 * There are two, and they are in different functions: multer's fileFilter
 * refuses by NAME before anything is written, and assertUploadsAreWhatTheyClaim
 * sniffs the BYTES afterwards. A widened client with only one of them widened
 * fails confusingly — the dialog offers a PNG and the upload rejects it — so
 * both are checked against the same list.
 */
const server = read('../server/src/index.js')
const jdFilter = server.slice(server.indexOf("file.fieldname === 'jd'"))
check('the name filter uses the job-description list',
  /JD_EXTENSIONS/.test(jdFilter.slice(0, 400)),
  'multer refuses by extension before the file is even stored')
check('and so does the byte sniff',
  /jd, allowed: JD_EXTENSIONS/.test(server),
  'a .pdf that is really something else is still refused')
check('while a CV stays documents-only',
  /allowedFor\('cv'\)/.test(server) && !JD_EXTENSIONS.every((e) => e === '.pdf' || e === '.docx'),
  'a CV has to be readable as text without a model; a JD does not')

section('Anything that is not an image is left alone')
check('pasted text falls through',
  pastedImage({ items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] }) === null,
  'ordinary paste must keep working')
check('a pasted PDF falls through',
  pastedImage(clipboard('cv.pdf', 'application/pdf')) === null,
  'the dialog handles documents; paste is for pictures')
check('an empty clipboard is not an error', pastedImage(undefined) === null)
check('and neither is one with no items', pastedImage({}) === null)

finish()
