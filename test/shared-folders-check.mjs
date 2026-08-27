/**
 * Folders belong to the company, not to the person who made them.
 *
 * They used to be private — "yours alone, colleagues do not see them" — which
 * is the wrong default for a shared seat model: two recruiters working the same
 * role each kept their own shortlist, neither could see the other's, and a
 * reveal one of them paid for was invisible to the other until they happened to
 * hit the same candidate in a search.
 *
 * The half of this that matters most is the half that must NOT have changed:
 * sharing within a company must not become sharing between companies. The
 * second section is entirely about that.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import {
  BASE, contactProofs, createReporter, json, makePdf, registerApprovedCompany,
} from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const MARKER = `@cking-shared-${RUN}.example.com`
const H = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` })
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const org = await registerApprovedCompany({
  companyName: `Acme Hiring ${RUN}`, email: `admin${MARKER}`, phone: '050-770-0001',
})
const rival = await registerApprovedCompany({
  companyName: `Rival Corp ${RUN}`, email: `rival${MARKER}`, phone: '050-770-0002',
})

/* A second seat at the first company — the colleague the sharing is for.
   Granted directly: buying seats is the billing suite's subject, and going
   through checkout here would make this file fail for reasons about money. */
db.prepare(`UPDATE companies SET purchased_seats = 1 WHERE id = ?`).run(org.company.id)

const invite = new FormData()
invite.append('firstName', 'Noa')
invite.append('lastName', 'Barak')
/* Contact details on a colleague account are proved by a code to the address,
   the same as everywhere else — they used to be accepted unverified here. */
invite.append('email', `noa${MARKER}`)
invite.append('phone', '0507770003')
for (const [key, value] of Object.entries(
  await contactProofs({ email: `noa${MARKER}`, phone: '0507770003' }),
)) invite.append(key, value)
const created2 = await json(await fetch(`${BASE}/api/recruiter`, {
  method: 'POST', headers: { authorization: `Bearer ${org.token}` }, body: invite,
}))
const made = created2.created
const colleagueSignIn = await json(await fetch(`${BASE}/api/recruiter/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    joinKey: made.joinKey ?? org.company.joinKey,
    username: made.username,
    password: made.password,
  }),
}))
const colleague = colleagueSignIn.token

async function apply(first, last) {
  const email = `${first.toLowerCase()}${MARKER}`
  const phone = `0506${String(100000 + Math.floor(Math.random() * 800000)).slice(1)}`
  const form = new FormData()
  form.append('firstName', first)
  form.append('lastName', last)
  form.append('email', email)
  form.append('phone', phone)
  form.append('location', 'Tel Aviv')
  form.append('openToAllOpportunities', 'true')
  form.append('notes', 'Backend engineer on payment systems and ledgers.')
  form.append('cv', new Blob([await makePdf([
    `${first} ${last}`, 'Senior Backend Engineer',
    'Payments, ledgers and reconciliation systems.',
    'Node.js, PostgreSQL, Redis, Kafka, Docker, AWS.',
    'Built a double-entry ledger settling across three currencies.',
    'BSc Computer Science.',
  ])], { type: 'application/pdf' }), 'cv.pdf')
  const proofs = await contactProofs({ email, phone })
  form.append('emailProof', proofs.emailProof)
  form.append('phoneProof', proofs.phoneProof)
  // The 18+ affirmation and agreement the form now sends and the route now requires.
  if (!form.has('consent')) form.append('consent', 'true')
  return json(await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form }))
}

const dana = await apply('Dana', 'Rosenberg')
const foldersOf = async (token) => (await json(await fetch(`${BASE}/api/hr/folders`, { headers: H(token) }))).folders

// --------------------------------------------------------------------------
section('A colleague sees the same folders')

const created = await json(await fetch(`${BASE}/api/hr/folders`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ name: 'Payments shortlist' }),
}))
const folderId = created.id

const seen = await foldersOf(colleague)
check('a folder made by the admin appears for the colleague',
  seen.some((f) => f.id === folderId), `colleague sees ${seen.length} folder(s)`)
check('and it says who made it', seen.find((f) => f.id === folderId)?.created_by === 'Maya Cohen',
  `got ${JSON.stringify(seen.find((f) => f.id === folderId)?.created_by)}`)
check('the colleague is told it is not theirs', seen.find((f) => f.id === folderId)?.mine === false)

// --------------------------------------------------------------------------
section('And can work in it')

check('the colleague can add a candidate to it',
  (await fetch(`${BASE}/api/hr/folders/${folderId}/items`, {
    method: 'POST', headers: H(colleague), body: JSON.stringify({ candidateId: dana.id }),
  })).status === 200)
check('and the admin sees the addition',
  (await foldersOf(org.token)).find((f) => f.id === folderId).items.length === 1)

check('the colleague can set a status on it',
  (await fetch(`${BASE}/api/hr/folders/items/${dana.id}/status`, {
    method: 'PATCH', headers: H(colleague), body: JSON.stringify({ status: 'shortlisted' }),
  })).status === 200)
const afterStatus = (await foldersOf(org.token)).find((f) => f.id === folderId).items[0]
check('and the admin sees that too', afterStatus.status.key === 'shortlisted')

check('the colleague can rename it',
  (await fetch(`${BASE}/api/hr/folders/${folderId}`, {
    method: 'PATCH', headers: H(colleague), body: JSON.stringify({ name: 'Payments — final' }),
  })).status === 200)
check('and the admin sees the new name',
  (await foldersOf(org.token)).find((f) => f.id === folderId).name === 'Payments — final')

/* The status derives from what the team did, not what the caller did. */
await json(await fetch(`${BASE}/api/hr/candidates/${dana.id}/reveal`, {
  method: 'POST', headers: H(org.token),
}))
await fetch(`${BASE}/api/hr/folders/items/${dana.id}/status`, {
  method: 'PATCH', headers: H(colleague), body: JSON.stringify({ status: '' }),
})
await json(await fetch(`${BASE}/api/hr/threads/${dana.id}`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ body: 'Are you open to a chat?' }),
}))
const derived = (await foldersOf(colleague)).find((f) => f.id === folderId).items[0]
check('a colleague messaging counts as the team having contacted them',
  derived.status.key === 'contacted',
  'otherwise a shared list reads "yet to be contacted" over a running conversation')

// --------------------------------------------------------------------------
section('But another company sees nothing')
/*
 * The whole risk of this change. Sharing within a company must not have become
 * sharing between them.
 */
const rivalFolders = await foldersOf(rival.token)
check('the rival company has no folders of its own', rivalFolders.length === 0,
  `got ${rivalFolders.length}`)
check('reading the shared folder by id is refused',
  (await fetch(`${BASE}/api/hr/folders/${folderId}`, {
    method: 'PATCH', headers: H(rival.token), body: JSON.stringify({ name: 'Mine now' }),
  })).status === 404)
check('and the name is untouched',
  (await foldersOf(org.token)).find((f) => f.id === folderId).name === 'Payments — final')
check('adding a candidate to it is refused',
  (await fetch(`${BASE}/api/hr/folders/${folderId}/items`, {
    method: 'POST', headers: H(rival.token), body: JSON.stringify({ candidateId: dana.id }),
  })).status === 404)
check('setting a status on its candidate is refused',
  (await fetch(`${BASE}/api/hr/folders/items/${dana.id}/status`, {
    method: 'PATCH', headers: H(rival.token), body: JSON.stringify({ status: 'shortlisted' }),
  })).status === 404)
check('deleting it is refused',
  (await fetch(`${BASE}/api/hr/folders/${folderId}`, {
    method: 'DELETE', headers: H(rival.token),
  })).status === 404)
check('and it is still there afterwards',
  (await foldersOf(org.token)).some((f) => f.id === folderId))

// --------------------------------------------------------------------------
section('A departing colleague does not take the team\'s folders')
/*
 * The folders are the company's work, often paid for in reveals. Deleting the
 * person who happened to create one used to delete it.
 */
const colleagueId = made.id ?? db.prepare(`SELECT id FROM recruiters WHERE username = ?`).get(made.username)?.id
const ownFolder = await json(await fetch(`${BASE}/api/hr/folders`, {
  method: 'POST', headers: H(colleague), body: JSON.stringify({ name: 'Noa working list' }),
}))
check('the colleague made one of their own', Boolean(ownFolder.id))

const removed = await fetch(`${BASE}/api/recruiter/${colleagueId}`, {
  method: 'DELETE', headers: H(org.token), body: JSON.stringify({ confirm: made.username }),
})
check('the admin can remove them', removed.status === 200, `got ${removed.status}`)

const afterRemoval = await foldersOf(org.token)
check('their folder survives them', afterRemoval.some((f) => f.id === ownFolder.id),
  'it is the company\'s shortlist, not their private working material')
check('and is now attributed to somebody who still exists',
  Boolean(afterRemoval.find((f) => f.id === ownFolder.id)?.created_by))

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
    DELETE FROM folder_items WHERE folder_id IN (SELECT id FROM folders WHERE company_id = ${companyId});
    DELETE FROM folders WHERE company_id = ${companyId};
    DELETE FROM messages WHERE recruiter_id IN (${rl});
    DELETE FROM message_threads WHERE recruiter_id IN (${rl});
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
