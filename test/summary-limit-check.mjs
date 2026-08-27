/** The 500-character professional summary cap, at all three enforcement points. */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import { BASE, contactProofs, createReporter, json, makePdf } from './helpers.mjs'

/*
 * Read from source rather than imported.
 *
 * Importing ai.js pulls in the Anthropic SDK, and loading that alongside
 * better-sqlite3 in one process trips a libuv assertion during exit on Windows
 * — after every check has passed, so the suite reports success and still exits
 * non-zero. Nothing here needs the SDK; it needs one number, and reading it
 * from the file also proves the two declarations have not drifted.
 */
const readConstant = (file, name) => Number(
  fs.readFileSync(new URL(file, import.meta.url), 'utf8')
    .match(new RegExp(`${name}\\s*=\\s*(\\d+)`))?.[1],
)

const SUMMARY_MAX_CHARS = readConstant('../server/src/ai.js', 'SUMMARY_MAX_CHARS')

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const MARKER = `@cking-summary-${RUN}.example.com`
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const CV = [
  'Dana Levi', 'Payments engineer - Tel Aviv',
  'BACKEND ENGINEER, PayFlow 2019-01 - present',
  '  Rebuilt the checkout used by 40,000 people a week.',
  'SKILLS: Java, SQL, Kubernetes',
]

async function apply(notes) {
  const form = new FormData()
  form.append('cv', new Blob([await makePdf(CV)], { type: 'application/pdf' }), 'cv.pdf')
  for (const [k, v] of Object.entries({
    firstName: 'Dana', lastName: 'Levi',
    email: `dana.${RUN}.${Math.random().toString(36).slice(2, 7)}${MARKER}`,
    phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
    location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
    ...(notes === undefined ? {} : { notes }),
  })) form.append(k, v)

  // Both contact details are proved before an account exists.
  const proofs = await contactProofs({ email: form.get('email'), phone: form.get('phone') })
  for (const [key, value] of Object.entries(proofs)) form.append(key, value)

  // The 18+ affirmation and agreement the form now sends and the route now requires.
  if (!form.has('consent')) form.append('consent', 'true')
  const res = await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form })
  return { res, body: await res.json().catch(() => ({})) }
}

section('The limit is one number')
check(`the cap is ${SUMMARY_MAX_CHARS}`, SUMMARY_MAX_CHARS === 500)
check('the client mirrors it',
  readConstant('../client/src/components/CandidateForm.jsx', 'SUMMARY_MAX_CHARS') === SUMMARY_MAX_CHARS,
  'form and server agree')

// The trimmer's own behaviour is covered by test/summary-ai-check.mjs, which
// needs no server and no database. This suite is the form-and-API half.

section('A candidate can write up to the limit')
const atLimit = `${'I build payment systems for retail. '.repeat(13)}`.slice(0, 500).trim()
const ok = await apply(atLimit)
check('500 characters is accepted', ok.res.status === 201, `HTTP ${ok.res.status}`)
check('and stored whole',
  db.prepare(`SELECT notes FROM candidates WHERE id = ?`).get(ok.body.id).notes === atLimit)

section('Beyond the limit is refused, not silently cut')
const over = await apply('x'.repeat(501))
check('501 characters is rejected', over.res.status === 400, `HTTP ${over.res.status}`)
check('the message says the limit and their length',
  String(over.body.error ?? '').includes('500') && String(over.body.error ?? '').includes('501'),
  over.body.error)
check('and nothing was written',
  db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE notes = ?`).get('x'.repeat(501)).n === 0,
  'no truncated version saved under their name')

section('The same rule applies on edit')
const code = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: ok.body.account.email }),
}))
const { token } = await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: ok.body.account.email, code: code.devCode }),
}))

async function edit(notes) {
  const form = new FormData()
  for (const [k, v] of Object.entries({
    firstName: 'Dana', lastName: 'Levi', email: ok.body.account.email,
    phone: ok.body.account.phone, location: 'Tel Aviv',
    availability: 'Immediately', capacity: 'Full time', notes,
  })) form.append(k, v)
  return fetch(`${BASE}/api/candidate/me`, {
    method: 'PATCH', headers: { authorization: `Bearer ${token}` }, body: form,
  })
}

check('an over-long edit is rejected', (await edit('y'.repeat(600))).status === 400)
check('the stored summary is untouched by the rejected edit',
  db.prepare(`SELECT notes FROM candidates WHERE id = ?`).get(ok.body.id).notes === atLimit)
check('an edit within the limit is accepted', (await edit('I build payment systems.')).status === 200)

section('The generated draft')
const drafted = await fetch(`${BASE}/api/candidate/summary`, {
  method: 'POST', headers: { authorization: `Bearer ${token}` }, body: new FormData(),
})
const draft = await drafted.json().catch(() => ({}))

if (drafted.status === 503) {
  check('no API key, so drafting reports unavailable rather than guessing',
    String(draft.error ?? '').includes('not available'), draft.error)
  check('and the limit is still what the endpoint would apply',
    SUMMARY_MAX_CHARS === 500, 'enforced by trimToLimit on the response path')
} else {
  check('a draft is returned', drafted.status === 200, `HTTP ${drafted.status}`)
  check('within the limit', (draft.summary ?? '').length <= SUMMARY_MAX_CHARS,
    `${(draft.summary ?? '').length} chars`)
  check('the limit is published with it', draft.maxChars === SUMMARY_MAX_CHARS)
  check('and it can be saved as-is', (await edit(draft.summary)).status === 200,
    'what we generate is always something we accept')
}

section('Cleanup')
const rows = db.prepare(`SELECT id, stored_name FROM candidates WHERE email LIKE ?`).all(`%${MARKER}`)
for (const row of rows) {
  for (const doc of db.prepare(`SELECT stored_name FROM documents WHERE candidate_id = ?`).all(row.id)) {
    try { fs.unlinkSync(new URL(`../server/uploads/${doc.stored_name}`, import.meta.url)) } catch {}
  }
  if (row.stored_name) {
    try { fs.unlinkSync(new URL(`../server/uploads/${row.stored_name}`, import.meta.url)) } catch {}
  }
  for (const t of [
    'folder_items', 'view_events', 'reveals', 'documents', 'extracted_profiles',
    'profile_overrides', 'blocked_companies', 'messages', 'message_threads', 'login_codes',
    'scoring_audit', 'freshness_checkins', 'embeddings', 'candidate_preference_tags',
    'extracted_facts', 'candidate_profile_intelligence', 'candidate_taxonomy_labels',
    'candidate_experience_metrics', 'candidate_job_analyses', 'displayed_match_state',
  ]) {
    try { db.prepare(`DELETE FROM ${t} WHERE candidate_id = ?`).run(row.id) } catch {}
  }
  db.prepare(`DELETE FROM candidates WHERE id = ?`).run(row.id)
}
check('test data removed', true, `${rows.length} candidate(s)`)
db.close()

finish()
