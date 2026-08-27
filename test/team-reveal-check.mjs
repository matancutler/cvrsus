/**
 * Saving is free, and a reveal belongs to the company that paid for it.
 *
 * The boundary that matters most here is the one between companies: sharing a
 * reveal across a team must not leak it to a rival who never paid.
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import Database from 'better-sqlite3'

import {
  BASE, approveCompanyById, contactProofs, createReporter, json, makePdf,
  registerAndSignIn, serverEnv,
} from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const MARKER = `@cking-teamreveal-${RUN}.example.com`
const H = (t) => ({ 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) })
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))


/** Proves the email and phone already in `form`, and appends the proofs. */
async function appendProofs(form) {
  const proofs = await contactProofs({ email: form.get('email'), phone: form.get('phone') })
  for (const [key, value] of Object.entries(proofs)) form.append(key, value)
}

async function apply(first) {
  const form = new FormData()
  form.append('cv', new Blob([await makePdf([
    `${first} Reveal`, 'Backend engineer - Tel Aviv',
    'BACKEND ENGINEER, PayFlow 2018-01 - present',
    '  Java services and SQL.',
    'SKILLS: Java, SQL',
  ])], { type: 'application/pdf' }), 'cv.pdf')
  for (const [k, v] of Object.entries({
    firstName: first, lastName: 'Reveal', email: `${first}.${RUN}${MARKER}`.toLowerCase(),
    phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
    location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
  })) form.append(k, v)
  // Both contact details are proved before an account exists.
  await appendProofs(form)
  // The 18+ affirmation and agreement the form now sends and the route now requires.
  if (!form.has('consent')) form.append('consent', 'true')
  return json(await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form }))
}

// Registering no longer returns a session, so this signs in afterwards the way
// an operator handing over the company key would.
const register = async (name, first, last) => registerAndSignIn({
  companyName: name, firstName: first, lastName: last,
  email: `${first.toLowerCase()}@example.com`,
})

section('Setup')
const alice = await register(`TeamA ${RUN}`, 'Alice', 'Admin')
const rival = await register(`Rival ${RUN}`, 'Ruth', 'Rival')
check('two companies created', Boolean(alice.token) && Boolean(rival.token))

// §15 — a company registers 'pending' and reaches nothing until it is approved.
await approveCompanyById(alice.company.id)
await approveCompanyById(rival.company.id)

const aliceCompany = db.prepare(`SELECT id FROM companies WHERE name = ?`).get(`TeamA ${RUN}`).id

/*
 * A colleague at Alice's company, created as a fixture.
 *
 * The HTTP route enforces the seat limit, and a new company's single seat is
 * already taken by its admin — so going through it would only be testing the
 * billing rule, not the reveal sharing this suite is about.
 */
const { createRecruiter } = await import('../server/src/accounts.js')
const bob = await createRecruiter({
  companyId: aliceCompany, firstName: 'Bob', lastName: 'Colleague',
})
const aliceKey = db.prepare(`SELECT join_key FROM companies WHERE id = ?`).get(aliceCompany).join_key
const bobLogin = await fetch(`${BASE}/api/recruiter/login`, {
  method: 'POST', headers: H(),
  body: JSON.stringify({ joinKey: aliceKey, username: bob.username, password: bob.initialPassword }),
})
const bobToken = bobLogin.status === 200 ? (await bobLogin.json()).token : null
check('a colleague at the same company can sign in', Boolean(bobToken), `HTTP ${bobLogin.status}`)

const candidate = await apply('Cass')
check('a candidate applied', Boolean(candidate.id))

section('Saving to a folder is free, with no reveal')
const folder = await json(await fetch(`${BASE}/api/hr/folders`, {
  method: 'POST', headers: H(alice.token), body: JSON.stringify({ name: `Shortlist ${RUN}` }),
}))
const folderId = folder.folders.find((f) => f.name === `Shortlist ${RUN}`).id

const saved = await fetch(`${BASE}/api/hr/folders/${folderId}/items`, {
  method: 'POST', headers: H(alice.token), body: JSON.stringify({ candidateId: candidate.id }),
})
check('an unrevealed candidate can be saved', saved.status === 200, `HTTP ${saved.status}`)
check('and it cost no reveal',
  db.prepare(`SELECT COUNT(*) AS n FROM reveals WHERE candidate_id = ?`).get(candidate.id).n === 0)
check('they are in the folder',
  db.prepare(`SELECT COUNT(*) AS n FROM folder_items WHERE candidate_id = ? AND folder_id = ?`)
    .get(candidate.id, folderId).n === 1)

const stillMasked = await json(await fetch(`${BASE}/api/hr/candidates/${candidate.id}`, {
  headers: H(alice.token),
}))
check('saving did not unmask them', stillMasked.revealed === false)
check('their surname is still withheld', stillMasked.candidate.name === undefined)

section('One reveal covers the whole team')
const revealRes = await json(await fetch(`${BASE}/api/hr/candidates/${candidate.id}/reveal`, {
  method: 'POST', headers: H(alice.token),
}))
check('Alice reveals them', revealRes.revealed === true)
check('and it is recorded as the first', revealRes.first === true)
check('exactly one reveal row exists',
  db.prepare(`SELECT COUNT(*) AS n FROM reveals WHERE candidate_id = ?`).get(candidate.id).n === 1)

if (bobToken) {
  const bobSees = await json(await fetch(`${BASE}/api/hr/candidates/${candidate.id}`, {
    headers: H(bobToken),
  }))
  check('a colleague sees them revealed without paying', bobSees.revealed === true)
  check('with the full name', typeof bobSees.candidate.name === 'string')
  check('and is told who revealed them', bobSees.revealedBy?.name === 'Alice Admin',
    JSON.stringify(bobSees.revealedBy))

  const bobReveals = await json(await fetch(`${BASE}/api/hr/candidates/${candidate.id}/reveal`, {
    method: 'POST', headers: H(bobToken),
  }))
  check('a colleague pressing reveal is not charged', bobReveals.first === false)
  check('and no second row is written',
    db.prepare(`SELECT COUNT(*) AS n FROM reveals WHERE candidate_id = ?`).get(candidate.id).n === 1,
    'one disclosure, one ledger entry')
}

section('A different company still cannot see them')
const rivalSees = await json(await fetch(`${BASE}/api/hr/candidates/${candidate.id}`, {
  headers: H(rival.token),
}))
check('the rival sees them masked', rivalSees.revealed === false)
check('with no surname', rivalSees.candidate.name === undefined)
check('and no email', rivalSees.candidate.email === undefined)
check('and is not told who revealed them', !rivalSees.revealedBy,
  'another company having paid is not their business')

section('The search list carries the flag')
const search = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(alice.token),
  body: JSON.stringify({ jobDescription: `Backend engineer ${RUN}. Requirements: Java, SQL.` }),
}))
const row = search.results.find((r) => r.candidate.id === candidate.id)
check('the candidate appears in the search', Boolean(row))
check('flagged as revealed', row?.revealed === true)
check('naming who revealed them', row?.revealedBy?.name === 'Alice Admin')
check('and shown unmasked', typeof row?.candidate.name === 'string')

const rivalSearch = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(rival.token),
  body: JSON.stringify({ jobDescription: `Backend engineer ${RUN}. Requirements: Java, SQL.` }),
}))
const rivalRow = rivalSearch.results.find((r) => r.candidate.id === candidate.id)
check('the rival sees the same candidate', Boolean(rivalRow))
check('but not flagged as revealed', rivalRow?.revealed === false)
check('and still masked in the list', rivalRow?.candidate.name === undefined)

section('Save puts them in the search folder, creating it if needed')
const searchForSave = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(alice.token),
  body: JSON.stringify({ jobDescription: `Save probe ${RUN}. Requirements: Java.` }),
}))

// No chat and therefore no folder yet — the case where Save used to do nothing.
const savedOne = await fetch(`${BASE}/api/hr/search/${searchForSave.sessionId}/save`, {
  method: 'POST', headers: H(alice.token), body: JSON.stringify({ candidateId: candidate.id }),
})
check('saving works with no folder in existence', savedOne.status === 200, `HTTP ${savedOne.status}`)
const savedBody = await savedOne.json()
check('a folder was created for the search', Boolean(savedBody.folder), JSON.stringify(savedBody.folder?.name))
check('and the candidate is in it',
  db.prepare(`SELECT COUNT(*) AS n FROM folder_items WHERE candidate_id = ? AND folder_id = ?`)
    .get(candidate.id, savedBody.folder.id).n === 1)
check('still with no reveal charged',
  db.prepare(`SELECT COUNT(*) AS n FROM reveals WHERE candidate_id = ?`).get(candidate.id).n === 1,
  'the one Alice already spent, not a second')

// Pressing Save twice must not duplicate or error.
const savedTwice = await fetch(`${BASE}/api/hr/search/${searchForSave.sessionId}/save`, {
  method: 'POST', headers: H(alice.token), body: JSON.stringify({ candidateId: candidate.id }),
})
check('saving again is harmless', savedTwice.status === 200, `HTTP ${savedTwice.status}`)
check('and does not duplicate the entry',
  db.prepare(`SELECT COUNT(*) AS n FROM folder_items WHERE candidate_id = ?`).get(candidate.id).n === 1)

// The failure the recruiter actually hit: the folder existed, then went away.
db.prepare(`DELETE FROM folder_items WHERE folder_id = ?`).run(savedBody.folder.id)
db.prepare(`DELETE FROM folders WHERE id = ?`).run(savedBody.folder.id)
const savedAfterDelete = await fetch(`${BASE}/api/hr/search/${searchForSave.sessionId}/save`, {
  method: 'POST', headers: H(alice.token), body: JSON.stringify({ candidateId: candidate.id }),
})
check('a deleted folder is rebuilt rather than erroring', savedAfterDelete.status === 200,
  `HTTP ${savedAfterDelete.status}`)
check('and the candidate lands in the new one',
  (await savedAfterDelete.json()).folder?.id !== savedBody.folder.id)

const foreignSave = await fetch(`${BASE}/api/hr/search/${searchForSave.sessionId}/save`, {
  method: 'POST', headers: H(rival.token), body: JSON.stringify({ candidateId: candidate.id }),
})
check('another recruiter cannot save into this search', foreignSave.status === 403,
  `HTTP ${foreignSave.status}`)

section('The UI renders the flag')
const bundlePath = fs.readdirSync(new URL('../client/dist/assets/', import.meta.url))
  .find((name) => name.startsWith('index-') && name.endsWith('.js'))
const bundle = fs.readFileSync(new URL(`../client/dist/assets/${bundlePath}`, import.meta.url), 'utf8')
check('a revealed chip exists', bundle.includes('chip-revealed'))
/*
 * The negative case is no longer a chip on the row. It reported "not revealed"
 * from under the summary and offered no way to change that, with the action two
 * levels down the corner menu — so it became the button, in the corner, first.
 * The chip itself still exists on the profile dialog and the public demo, which
 * is why this asks for the button by name rather than for the chip's absence.
 */
check('and an unrevealed row carries the reveal button', bundle.includes('result-reveal'),
  'the same struck-through eye, where it can be pressed')
check('which says what it costs before it is pressed',
  bundle.includes('details and CV, for one reveal'),
  'a reveal is spent, not free — a bare "reveal" invites a click nobody meant')
check('the dialog credits the colleague', bundle.includes('free for everyone on your team'))
check('and the gate says saving is free', bundle.includes('including saving them to a folder'))
check('Save calls the endpoint that creates the folder', bundle.includes('/save'))

section('Cleanup')
const ids = db.prepare(`SELECT id FROM candidates WHERE email LIKE ?`).all(`%${MARKER}`).map((r) => r.id)
for (const id of ids) {
  for (const doc of db.prepare(`SELECT stored_name FROM documents WHERE candidate_id = ?`).all(id)) {
    try { fs.unlinkSync(new URL(`../server/uploads/${doc.stored_name}`, import.meta.url)) } catch {}
  }
  const c = db.prepare(`SELECT stored_name FROM candidates WHERE id = ?`).get(id)
  if (c?.stored_name) { try { fs.unlinkSync(new URL(`../server/uploads/${c.stored_name}`, import.meta.url)) } catch {} }
  for (const t of [
    'folder_items', 'view_events', 'reveals', 'documents', 'extracted_profiles',
    'profile_overrides', 'blocked_companies', 'messages', 'message_threads', 'login_codes',
    'scoring_audit', 'freshness_checkins', 'embeddings', 'candidate_preference_tags',
    'extracted_facts', 'candidate_profile_intelligence', 'candidate_taxonomy_labels',
    'candidate_experience_metrics', 'candidate_job_analyses', 'displayed_match_state',
  ]) {
    try { db.prepare(`DELETE FROM ${t} WHERE candidate_id = ?`).run(id) } catch {}
  }
  db.prepare(`DELETE FROM candidates WHERE id = ?`).run(id)
}

const companies = db.prepare(`SELECT id FROM companies WHERE name LIKE 'TeamA %' OR name LIKE 'Rival %'`)
  .all().map((r) => r.id)
if (companies.length) {
  const list = companies.join(',')
  const recruiters = db.prepare(`SELECT id FROM recruiters WHERE company_id IN (${list})`).all().map((r) => r.id)
  const rl = recruiters.length ? recruiters.join(',') : '-1'
  db.exec(`
    DELETE FROM displayed_match_state WHERE session_id IN (SELECT id FROM retrieval_sessions WHERE recruiter_id IN (${rl}));
    DELETE FROM candidate_job_analyses WHERE job_id IN (SELECT id FROM jobs WHERE recruiter_id IN (${rl}));
    DELETE FROM job_match_profiles WHERE job_id IN (SELECT id FROM jobs WHERE recruiter_id IN (${rl}));
    DELETE FROM retrieval_sessions WHERE recruiter_id IN (${rl});
    DELETE FROM jobs WHERE recruiter_id IN (${rl});
    DELETE FROM folder_items WHERE folder_id IN (SELECT id FROM folders WHERE recruiter_id IN (${rl}));
    DELETE FROM folders WHERE recruiter_id IN (${rl});
    DELETE FROM search_chat_turns WHERE chat_id IN (SELECT id FROM search_chats WHERE recruiter_id IN (${rl}));
    DELETE FROM search_chats WHERE recruiter_id IN (${rl});
    DELETE FROM scoring_audit WHERE recruiter_id IN (${rl});
    DELETE FROM view_events WHERE company_id IN (${list});
    DELETE FROM reveals WHERE company_id IN (${list});
    DELETE FROM organization_reveals WHERE company_id IN (${list});
    DELETE FROM billing_ledger WHERE company_id IN (${list});
    DELETE FROM seat_usage_periods WHERE recruiter_id IN (SELECT id FROM recruiters WHERE company_id IN (${list}));
    DELETE FROM seat_purchases WHERE company_id IN (${list});
    DELETE FROM recruiters WHERE company_id IN (${list});
    DELETE FROM companies WHERE id IN (${list});
  `)
}
check('test data removed', true, `${ids.length} candidate(s), ${companies.length} company(ies)`)
db.close()

finish()
