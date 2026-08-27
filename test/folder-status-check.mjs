/**
 * What a recruiter may see before paying, and where a saved candidate stands.
 *
 * Three things, all of which used to be wrong in the same direction — the
 * product showed more of a person than the recruiter had bought:
 *
 *   1. The masked name carried the surname's initial ("Dana R."), and the
 *      avatar's initials carried it a second time.
 *   2. The photograph was served to any signed-in recruiter who put a candidate
 *      id in the URL, and the folders list handed out the filename unasked —
 *      so the one screen where masking did not apply was the saved list.
 *   3. Saving somebody was possible but not offered: the folder picker hid
 *      itself when the recruiter had no folders yet, which is exactly when they
 *      need it.
 *
 * The fourth section covers the status the folders now carry.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import {
  BASE, contactProofs, createReporter, json, makePdf, makePng, registerApprovedCompany,
} from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const MARKER = `@cking-folder-${RUN}.example.com`
const H = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` })
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const org = await registerApprovedCompany({
  companyName: `Acme Hiring ${RUN}`, email: `admin${MARKER}`, phone: '050-900-0001',
})
/* A second organization, to prove the gate is company-scoped: one company
   paying for a reveal must not open the photo for everybody else. */
const rival = await registerApprovedCompany({
  companyName: `Rival Corp ${RUN}`, email: `rival${MARKER}`, phone: '050-900-0002',
})

async function apply(first, last) {
  const email = `${first.toLowerCase()}${MARKER}`
  const phone = `0509${String(100000 + Math.floor(Math.random() * 800000)).slice(1)}`
  const form = new FormData()
  form.append('firstName', first)
  form.append('lastName', last)
  form.append('email', email)
  form.append('phone', phone)
  form.append('location', 'Tel Aviv')
  form.append('openToAllOpportunities', 'true')
  form.append('notes', 'Backend engineer on payment systems, ledgers and reconciliation.')
  /* Enough lines that the extractor accepts it — a two-line PDF reads as
     scanned and is refused before any of this gets a chance to run. */
  form.append('cv', new Blob([await makePdf([
    `${first} ${last}`,
    'Senior Backend Engineer',
    'Payments, ledgers and reconciliation systems.',
    'Node.js, PostgreSQL, Redis, Kafka, Docker, AWS.',
    'Built a double-entry ledger handling settlement across three currencies.',
    'Previously at a payments processor working on card authorisation flows.',
    'BSc Computer Science.',
  ])], { type: 'application/pdf' }), 'cv.pdf')
  form.append('photo', new Blob([makePng()], { type: 'image/png' }), 'me.png')
  const proofs = await contactProofs({ email, phone })
  form.append('emailProof', proofs.emailProof)
  form.append('phoneProof', proofs.phoneProof)
  // The 18+ affirmation and agreement the form now sends and the route now requires.
  if (!form.has('consent')) form.append('consent', 'true')
  return json(await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form }))
}

const hidden = await apply('Dana', 'Rosenberg')
const shown = await apply('Omer', 'Levi')

const folderOf = async (token, candidateId) => {
  const { folders } = await json(await fetch(`${BASE}/api/hr/folders`, { headers: H(token) }))
  return folders.flatMap((f) => f.items).find((i) => i.candidate_id === candidateId) ?? null
}

// --------------------------------------------------------------------------
section('A candidate can be saved before anyone has revealed them')

const made = await json(await fetch(`${BASE}/api/hr/folders`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ name: 'Payments shortlist' }),
}))
const folderId = made.id
check('a folder is created', Boolean(folderId))
check('and the status vocabulary comes with the folder list',
  Array.isArray((await json(await fetch(`${BASE}/api/hr/folders`, { headers: H(org.token) }))).statuses),
  'so the picker cannot offer a stage the server would reject')

const placed = await fetch(`${BASE}/api/hr/folders/${folderId}/items`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ candidateId: hidden.id }),
})
check('an unrevealed candidate can be placed in it', placed.status === 200,
  'saving is a judgement about fit, not about identity')
check('and they are actually in there', Boolean(await folderOf(org.token, hidden.id)))

// --------------------------------------------------------------------------
section('Before a reveal, nothing points at a person')

const before = await folderOf(org.token, hidden.id)
check('the folder shows a first name alone', before.display_name === 'Dana',
  `got ${JSON.stringify(before.display_name)}`)
check('no surname initial rides along', !/\bR\b|R\./.test(before.display_name))
check('the folder reports them as not revealed', before.revealed === false)
check('no photo is offered', before.has_photo === false)
/* The filename is identifying in its own right, which is why file_name is
   withheld too. This list used to forward it from the join. */
check('and the photo filename never crosses the wire',
  !('photo_name' in before), `keys: ${Object.keys(before).join(', ')}`)

const search = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(org.token),
  body: JSON.stringify({ jobDescription: 'Backend engineer for payments and ledgers.' }),
}))
const row = search.results.find((r) => r.candidate.id === shown.id)
check('search results mask the same way', row.candidate.display_name === 'Omer',
  `got ${JSON.stringify(row.candidate.display_name)}`)
check('and carry no photo flag before a reveal', !row.candidate.has_photo)

/*
 * The route, not just the payload. Withholding a field while leaving the file
 * addressable withholds nothing — ids are sequential.
 */
const denied = await fetch(`${BASE}/api/hr/candidates/${hidden.id}/photo`, { headers: H(org.token) })
check('the photo route refuses an unrevealed candidate', denied.status === 403,
  `got ${denied.status}`)

// --------------------------------------------------------------------------
section('The reveal releases the name and the face together')

await json(await fetch(`${BASE}/api/hr/candidates/${hidden.id}/reveal`, {
  method: 'POST', headers: H(org.token),
}))
const after = await folderOf(org.token, hidden.id)
check('the folder now shows the full name', after.display_name === 'Dana Rosenberg',
  `got ${JSON.stringify(after.display_name)}`)
check('and offers the photo', after.has_photo === true)
check('the photo route now serves it',
  (await fetch(`${BASE}/api/hr/candidates/${hidden.id}/photo`, { headers: H(org.token) })).status === 200)

/* Company-scoped, like every other reveal in the product. */
const rivalPhoto = await fetch(`${BASE}/api/hr/candidates/${hidden.id}/photo`, { headers: H(rival.token) })
check('another company still cannot see that photo', rivalPhoto.status === 403,
  'one organization paying must not unlock the face for everyone else')

// --------------------------------------------------------------------------
section('Status follows what actually happened')

const statusOf = async (candidateId) => (await folderOf(org.token, candidateId))?.status ?? null

await fetch(`${BASE}/api/hr/folders/${folderId}/items`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ candidateId: shown.id }),
})
check('saved but not revealed reads "Potential reveal"',
  (await statusOf(shown.id)).key === 'potential')
check('revealed but unmessaged reads "Yet to be contacted"',
  (await statusOf(hidden.id)).key === 'to_contact',
  'the reveal moved it with nobody typing anything')

await json(await fetch(`${BASE}/api/hr/threads/${hidden.id}`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ body: 'Are you open to a chat?' }),
}))
check('sending a message reads "Contacted"', (await statusOf(hidden.id)).key === 'contacted')

/* The candidate's side of the conversation, written directly — the point is
   what the status does when a reply exists, not how it got there. */
const thread = db.prepare(
  `SELECT id FROM message_threads WHERE candidate_id = ? ORDER BY id DESC LIMIT 1`,
).get(hidden.id)
db.prepare(`
  INSERT INTO messages (thread_id, candidate_id, recruiter_id, sender, body, created_at)
  VALUES (?, ?, ?, 'candidate', ?, ?)
`).run(thread.id, hidden.id, org.recruiter.id, 'Yes, happy to talk.', new Date().toISOString())
check('their reply reads "Replied"', (await statusOf(hidden.id)).key === 'replied',
  'nobody has to remember to move it — which is why these four are derived')
check('and none of that counted as pinned', (await statusOf(hidden.id)).pinned === false)

// --------------------------------------------------------------------------
section('And the recruiter can overrule it')

const setStatus = (candidateId, status) => fetch(
  `${BASE}/api/hr/folders/items/${candidateId}/status`,
  { method: 'PATCH', headers: H(org.token), body: JSON.stringify({ status }) },
)

await setStatus(hidden.id, 'shortlisted')
const pinned = await statusOf(hidden.id)
check('a decision sticks', pinned.key === 'shortlisted' && pinned.label === 'Shortlisted')
check('and is marked as chosen rather than worked out', pinned.pinned === true,
  'so a row that has stopped tracking events is visible as such')

await setStatus(hidden.id, '')
const released = await statusOf(hidden.id)
check('clearing it returns to the derived stage', released.key === 'replied' && released.pinned === false)

check('an unknown status is refused',
  (await setStatus(hidden.id, 'hired-obviously')).status === 400)
/* Scoped to this recruiter's own folders: an id from another workspace must
   update nothing rather than reach across. */
const strangerId = (await apply('Tal', 'Bergman')).id
check('a candidate in nobody\'s folder is a 404, not a silent no-op',
  (await setStatus(strangerId, 'shortlisted')).status === 404)

// --------------------------------------------------------------------------
section('Cleanup')
const ids = db.prepare(`SELECT id FROM candidates WHERE email LIKE ?`).all(`%${MARKER}`).map((r) => r.id)
const leftovers = []
if (ids.length) {
  const list = ids.join(',')
  for (const r of db.prepare(`
    SELECT stored_name AS n FROM candidates WHERE id IN (${list}) AND stored_name IS NOT NULL
    UNION ALL SELECT photo_name FROM candidates WHERE id IN (${list}) AND photo_name IS NOT NULL
    UNION ALL SELECT stored_name FROM documents WHERE candidate_id IN (${list}) AND stored_name IS NOT NULL
  `).all()) leftovers.push(r.n)
  db.exec(`
    DELETE FROM messages WHERE candidate_id IN (${list});
    DELETE FROM message_threads WHERE candidate_id IN (${list});
    DELETE FROM documents WHERE candidate_id IN (${list});
    DELETE FROM organization_reveals WHERE candidate_id IN (${list});
    DELETE FROM reveals WHERE candidate_id IN (${list});
    DELETE FROM view_events WHERE candidate_id IN (${list});
    DELETE FROM folder_items WHERE candidate_id IN (${list});
    DELETE FROM candidates WHERE id IN (${list});
  `)
}
for (const companyId of [org.company.id, rival.company.id]) {
  const recruiters = db.prepare(`SELECT id, photo_name FROM recruiters WHERE company_id = ?`).all(companyId)
  for (const r of recruiters) if (r.photo_name) leftovers.push(r.photo_name)
  const rl = recruiters.length ? recruiters.map((r) => r.id).join(',') : '-1'
  db.exec(`
    DELETE FROM folder_items WHERE folder_id IN (SELECT id FROM folders WHERE recruiter_id IN (${rl}));
    DELETE FROM folders WHERE recruiter_id IN (${rl});
    DELETE FROM seat_usage_periods WHERE recruiter_id IN (${rl});
    DELETE FROM billing_ledger WHERE company_id = ${companyId};
    DELETE FROM organization_reveals WHERE company_id = ${companyId};
    DELETE FROM reveals WHERE company_id = ${companyId};
    DELETE FROM view_events WHERE company_id = ${companyId};
    DELETE FROM recruiters WHERE company_id = ${companyId};
    DELETE FROM companies WHERE id = ${companyId};
  `)
}
const uploads = fileURLToPath(new URL('../server/uploads/', import.meta.url))
for (const name of leftovers) {
  try { fs.unlinkSync(uploads + name) } catch (error) { if (error.code !== 'ENOENT') throw error }
}
check('test data removed',
  db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE email LIKE ?`).get(`%${MARKER}`).n === 0
  && leftovers.every((n) => !fs.existsSync(uploads + n)),
  `${ids.length} candidate(s), 2 companies, ${leftovers.length} file(s)`)
db.close()

finish()
