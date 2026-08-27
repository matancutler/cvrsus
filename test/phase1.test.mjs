/**
 * Phase 1 — candidate intake, per Product Spec v2 §5.
 *
 *   npm run test:phase1
 *
 * Covers the five document slots, the new intake fields, PDF and DOCX
 * acceptance, and the hard-delete cascade. Every candidate it creates is
 * deleted through the product's own delete route, so it is safe to re-run
 * against a database with real candidates in it.
 */
import {
  BASE, contactProofs, createReporter, deleteCandidate, json, makePdf, makePng, serverEnv,
} from './helpers.mjs'

const { check, section, finish } = createReporter()

const MARKER = '@cking-phase1.example.com'

/*
 * Per run, like the email above.
 *
 * These were fixed strings, which was fine while a phone number identified
 * nobody: two runs could hold the same one. The apply route resolves an
 * identity by phone as well as by email now and refuses a second account for
 * either, so a run whose cleanup did not happen used to poison every run
 * after it. The last four digits stay readable so the fixtures are still
 * told apart at a glance.
 */
const PHONE_RUN = String(Date.now()).slice(-5, -2)
const phoneFor = (tail) => `052-${PHONE_RUN}-${tail}`

const RUN = Date.now().toString(36)

const CV_LINES = [
  'Dana Reyes',
  'Senior Frontend Engineer - Tel Aviv-Yafo',
  'Senior frontend engineer with 8 years of experience building React',
  'applications in TypeScript. Led a team of four and mentored two juniors.',
  'Senior Frontend Engineer, Volt Analytics - Mar 2019 - Present',
  'Frontend Developer, Kestrel Media - Jan 2017 - Feb 2019',
  'SKILLS: React, TypeScript, JavaScript, Next.js, GraphQL, CSS, Git',
]

/** Smallest structurally valid DOCX: a zip with the parts Word requires. */
function makeDocx(text) {
  const files = [
    ['[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>'],
    ['_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>'],
    ['word/document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + text.split('\n').map((line) =>
        `<w:p><w:r><w:t xml:space="preserve">${line.replace(/[<&>]/g, '')}</w:t></w:r></w:p>`).join('')
      + '</w:body></w:document>'],
  ]

  return zip(files)
}

/** Minimal stored (uncompressed) zip writer — enough for mammoth to read. */
function zip(files) {
  const chunks = []
  const central = []
  let offset = 0

  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (buf) => {
    let c = 0xFFFFFFFF
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
  }

  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(content, 'utf8')
    const sum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)

    chunks.push(local, nameBuf, data)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(sum, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBuf.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...chunks, centralBuf, end])
}

async function apply(fields, { slots = {}, photo = false, verify = true } = {}) {
  const form = new FormData()

  for (const [slot, file] of Object.entries(slots)) {
    form.append(slot, new Blob([file.bytes], { type: file.type }), file.name)
  }
  if (photo) form.append('photo', new Blob([makePng()], { type: 'image/png' }), 'me.png')
  // City is required and free text now.
  const withCity = { location: 'Tel Aviv', ...fields }
  for (const [key, value] of Object.entries(withCity)) form.append(key, value)

  // Both contact details are proved at account creation, so the tests walk the
  // same round trip a person does. `verify: false` is how a test checks that
  // an unproved application is refused.
  if (verify && withCity.email && withCity.phone) {
    const proofs = await contactProofs(withCity)
    for (const [key, value] of Object.entries(proofs)) form.append(key, value)
  }

  // The 18+ affirmation and agreement the form now sends and the route now requires.
  if (!form.has('consent')) form.append('consent', 'true')
  return fetch(`${BASE}/api/candidates`, { method: 'POST', body: form })
}

const pdf = async (lines) => ({ bytes: await makePdf(lines), type: 'application/pdf', name: 'cv.pdf' })
const docx = (text, name) => ({ bytes: makeDocx(text), type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name })

// ------------------------------------------------------------------ health ---

section('Health')
let health
try {
  health = await json(await fetch(`${BASE}/api/health`))
} catch {
  console.error(`\nCould not reach ${BASE}. Start it with: npm run dev:server\n`)
  process.exit(1)
}
check('server responds', health.ok === true, `${health.candidates} candidates on file`)

// -------------------------------------------------------------- five slots ---

section('Document slots')

const baseFields = {
  firstName: 'Dana', lastName: 'Reyes', email: `dana.${RUN}${MARKER}`,
  phone: phoneFor('2000'), location: 'Tel Aviv-Yafo', availability: 'Within 1 month',
  notes: 'Senior frontend engineer.',
}

const noCv = await apply(baseFields, { slots: { cover_letter: await pdf(['Cover letter only']) } })
check('CV slot is required', noCv.status === 400)

const full = await json(await apply(baseFields, {
  slots: {
    cv: await pdf(CV_LINES),
    cover_letter: docx('Dear hiring manager,\nI would like to apply.', 'cover.docx'),
    // §7 renamed the slots: three anonymous "additional" rows became named
    // types, so a certificate is filed as a certification and a recommendation
    // as a recommendation.
    recommendation_1: await pdf(['Recommendation letter from a previous manager.']),
    certification_1: docx('Certificate of completion — advanced React.', 'cert.docx'),
    additional: await pdf(['Portfolio summary and selected project write-ups.']),
  },
  photo: true,
}))
check('all five slots accepted in one submission', full.documents === 5, `${full.documents} stored`)

const rejected = await apply(
  { ...baseFields, email: `reject.${RUN}${MARKER}` },
  { slots: { cv: { bytes: Buffer.from('plain text'), type: 'text/plain', name: 'cv.txt' } } },
)
check('a .txt CV is rejected', rejected.status === 400)

// ------------------------------------------------------------ verification ---

section('Contact details are proved before an account exists')

const unproved = await apply(
  { ...baseFields, email: `unproved.${RUN}${MARKER}` },
  { slots: { cv: await pdf(CV_LINES) }, verify: false },
)
check('an application with no proof is refused', unproved.status === 400,
  `HTTP ${unproved.status}`)

// A proof names the address it was issued for, so one verified address cannot
// stand in for another — the check that makes the whole thing worth doing.
const borrowedProofs = await contactProofs({
  email: `someone.else.${RUN}${MARKER}`, phone: phoneFor('9000'),
})
const borrowed = await apply(
  { ...baseFields, email: `borrower.${RUN}${MARKER}`, ...borrowedProofs },
  { slots: { cv: await pdf(CV_LINES) }, verify: false },
)
check('a proof for a different address is refused', borrowed.status === 400,
  `HTTP ${borrowed.status}`)

const wrongCode = await fetch(`${BASE}/api/verify/confirm`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ channel: 'email', destination: `nobody.${RUN}${MARKER}`, code: '000000' }),
})
check('a code nobody asked for is refused', wrongCode.status === 400)

section('City')

const noCity = await apply(
  { ...baseFields, email: `nocity.${RUN}${MARKER}`, location: '' },
  { slots: { cv: await pdf(CV_LINES) } },
)
check('an application with no city is refused', noCity.status === 400, `HTTP ${noCity.status}`)

// Free text now: the old dropdown only offered Israeli cities and an "Other".
const abroad = await json(await apply(
  {
    ...baseFields,
    email: `abroad.${RUN}${MARKER}`,
    /* Its own number. baseFields carries one, and sharing it made these three
       fixtures the same person as far as the apply route is concerned — which
       it now says rather than quietly creating a second row for. */
    phone: phoneFor('2100'),
    location: 'Lisbon',
  },
  { slots: { cv: await pdf(CV_LINES) } },
))
check('any city is accepted, not just a listed one', abroad.id > 0)

section('Capacity')

const freelance = await json(await apply(
  {
    ...baseFields,
    email: `freelance.${RUN}${MARKER}`,
    phone: phoneFor('2200'),
    capacity: 'Freelance',
  },
  { slots: { cv: await pdf(CV_LINES) } },
))
check('Freelance is an accepted capacity', freelance.id > 0)

// ------------------------------------------------------------- intake fields ---

section('Intake fields')

const withExtras = await json(await apply({
  ...baseFields,
  email: `extras.${RUN}${MARKER}`,
  phone: phoneFor('3000'),
  openToRelocation: 'yes',
  capacity: 'Part time',
  noticePeriod: '30 days',
  blockedCompanies: 'Acme Ltd\nRival Corp',
  consent: 'true',
}, { slots: { cv: await pdf(CV_LINES) } }))
check('application with the new fields is accepted', withExtras.id > 0)

// ----------------------------------------------------------------- sign in ---

section('Candidate account')

const codeResponse = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: `extras.${RUN}${MARKER}` }),
}))
const { token } = await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: `extras.${RUN}${MARKER}`, code: codeResponse.devCode }),
}))
const auth = { Authorization: `Bearer ${token}` }

const me = await json(await fetch(`${BASE}/api/candidate/me`, { headers: auth }))
check('relocation stored', me.candidate.open_to_relocation === true)
check('capacity stored', me.candidate.capacity === 'Part time', me.candidate.capacity)
check('notice period stored', me.candidate.notice_period === '30 days')
check('consent timestamped', Boolean(me.candidate.consent_at))
check('blocked companies stored', me.blockedCompanies.length === 2, me.blockedCompanies.join(', '))
// §7 — the CV plus seven supporting slots: one cover letter, two
// certifications, three recommendations and one additional document.
check('slot list is exposed to the client', me.slots.length === 8, String(me.slots.length))
check('the picker types and ceilings are exposed too',
  me.documentTypes?.length === 4
  && me.documentTypes.reduce((total, type) => total + type.max, 0) === 7,
  JSON.stringify(me.documentTypes))
check('CV document recorded', me.documents.some((doc) => doc.slot === 'cv'))
check('profile completion computed', typeof me.completion === 'number', String(me.completion))

// Sign in as the five-slot candidate to check every document survived.
const fullCode = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: `dana.${RUN}${MARKER}` }),
}))
const fullToken = (await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: `dana.${RUN}${MARKER}`, code: fullCode.devCode }),
}))).token
const fullAuth = { Authorization: `Bearer ${fullToken}` }

const fullMe = await json(await fetch(`${BASE}/api/candidate/me`, { headers: fullAuth }))
check('all five documents listed on the account', fullMe.documents.length === 5,
  fullMe.documents.map((d) => d.slot).join(', '))

const ownCv = await fetch(`${BASE}/api/candidate/me/documents/cv`, { headers: fullAuth })
check('candidate can download their own CV', ownCv.ok)

const removed = await json(await fetch(`${BASE}/api/candidate/me/documents/additional`, {
  method: 'DELETE', headers: fullAuth,
}))
check('an optional slot can be cleared', removed.documents.length === 4)

const cvRemoval = await fetch(`${BASE}/api/candidate/me/documents/cv`, {
  method: 'DELETE', headers: fullAuth,
})
check('the CV slot cannot be cleared', cvRemoval.status === 400)

// ------------------------------------------------------------ profile edit ---

section('Editing')

const edit = new FormData()
for (const [key, value] of Object.entries({
  firstName: 'Dana', lastName: 'Reyes', email: `dana.${RUN}${MARKER}`,
  phone: phoneFor('2000'), location: 'Tel Aviv-Yafo', openToRelocation: 'no', capacity: 'Full time',
  blockedCompanies: 'Acme Ltd',
})) edit.append(key, value)

const edited = await json(await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: fullAuth, body: edit,
}))
check('relocation can be turned off', edited.candidate.open_to_relocation === false)
check('capacity can be changed', edited.candidate.capacity === 'Full time')
check('blocked companies can be replaced', edited.blockedCompanies.length === 1)

const replaceCv = new FormData()
for (const [key, value] of Object.entries({
  firstName: 'Dana', lastName: 'Reyes', email: `dana.${RUN}${MARKER}`, phone: phoneFor('2000'),
  location: 'Tel Aviv-Yafo',
})) replaceCv.append(key, value)
replaceCv.append('cv', new Blob([makeDocx('Dana Reyes\nUpdated CV in Word format.\nReact and TypeScript.')],
  { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'updated.docx')

const afterReplace = await json(await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: fullAuth, body: replaceCv,
}))
check('CV can be replaced with a DOCX',
  afterReplace.documents.find((d) => d.slot === 'cv')?.file_name === 'updated.docx',
  afterReplace.documents.find((d) => d.slot === 'cv')?.file_name)

// ---------------------------------------------------------------- deletion ---

section('Account deletion')

const preview = await json(await fetch(`${BASE}/api/candidate/me/deletion-preview`, { headers: fullAuth }))
check('deletion preview counts documents', preview.preview.documents >= 1,
  JSON.stringify(preview.preview))

/*
 * Deletion asks for an acknowledgement, and the endpoint checks it.
 *
 * The dialog gates its Confirm button on a ticked box, but a gate on the page
 * is not a gate on the route: a DELETE that fired on an empty body would be one
 * stray request away from an emptied account. This is that check.
 */
const unacknowledged = await fetch(`${BASE}/api/candidate/me`, {
  method: 'DELETE', headers: { ...fullAuth, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
})
check('deletion refuses an unacknowledged request', unacknowledged.status === 400)

const alsoRefused = await deleteCandidate(fullToken, { acknowledged: false })
check('and refuses one that says so explicitly', alsoRefused.status === 400)

const deleted = await json(await deleteCandidate(fullToken))
check('account deleted', deleted.deleted === true, `${deleted.filesRemoved} files removed`)

check('the session dies with the account',
  (await fetch(`${BASE}/api/candidate/me`, { headers: fullAuth })).status === 404)

check('a deleted account can no longer request a sign-in code',
  (await fetch(`${BASE}/api/candidate/request-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: `dana.${RUN}${MARKER}` }),
  })).status === 404)

// --------------------------------------------------------------- cleanup ---

section('Cleanup')

/**
 * Removes an account the way its owner would: sign in with a code, then delete.
 *
 * This suite deliberately holds no database handle — it is meant to be safe to
 * run against a database with real candidates in it — so everything it creates
 * has to leave through the product's own routes.
 */
async function removeAccount(email) {
  const requested = await fetch(`${BASE}/api/candidate/request-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email }),
  })
  if (!requested.ok) return false

  const { devCode } = await requested.json()
  const signedIn = await json(await fetch(`${BASE}/api/candidate/verify-code`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email, code: devCode }),
  }))

  const gone = await fetch(`${BASE}/api/candidate/me`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${signedIn.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ acknowledged: true }),
  })
  return gone.ok
}

// The accounts the city and capacity checks created.
for (const email of [`abroad.${RUN}${MARKER}`, `freelance.${RUN}${MARKER}`]) {
  await removeAccount(email)
}

const secondPreview = await fetch(`${BASE}/api/candidate/me/deletion-preview`, { headers: auth })
if (secondPreview.ok) {
  await fetch(`${BASE}/api/candidate/me`, {
    method: 'DELETE', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ acknowledged: true }),
  })
}

const stillThere = await fetch(`${BASE}/api/candidate/me`, { headers: auth })
check('test accounts removed', stillThere.status === 404)

finish()
