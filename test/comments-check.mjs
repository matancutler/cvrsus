/**
 * A team's notes on a candidate: whether one exists shows on the card, and a
 * note can be deleted by the right people and nobody else.
 *
 * Who may delete is the part worth proving. A team's notes are a shared record —
 * "screened by Dana in June" — so a recruiter quietly deleting a colleague's note
 * would defeat the reason they exist. The author may; an organization admin may,
 * so a departed colleague's note is not stuck forever; nobody else, and nobody
 * at all from another company.
 */
import fs from 'node:fs'

import { BASE, contactProofs, createReporter, json, makePdf, registerApprovedCompany } from './helpers.mjs'

const { check, section, finish } = createReporter()

const RUN = Date.now().toString(36)
const MARK = `cking-comments-${RUN}`
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

const { default: Database } = await import('better-sqlite3')
const db = new Database(new URL('../server/data/cking.db', import.meta.url).pathname.slice(1))

const phoneFor = () => `052-${Math.floor(1000000 + Math.random() * 8999999)}`

/* The admin, and a colleague who is not one. */
const alice = await registerApprovedCompany({
  companyName: `${MARK} Ltd`, email: `alice.${RUN}@${MARK}.example.com`, phone: phoneFor(),
})
const { createRecruiter } = await import('../server/src/accounts.js')
const bobAccount = await createRecruiter({ companyId: alice.company.id, firstName: 'Bob', lastName: 'Colleague' })
const bobLogin = await json(await fetch(`${BASE}/api/recruiter/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ joinKey: alice.company.joinKey, username: bobAccount.username, password: bobAccount.initialPassword }),
}))

/* Someone at a different company entirely. */
const stranger = await registerApprovedCompany({
  companyName: `${MARK}-other Ltd`, email: `eve.${RUN}@${MARK}.example.com`, phone: phoneFor(),
})

/* A candidate to write about. */
const email = `cand.${RUN}@${MARK}.example.com`
const phone = phoneFor()
const form = new FormData()
form.append('cv', new Blob([await makePdf([
  'Comment Subject', 'Operations analyst - Tel Aviv', 'ANALYST, Co 2020 - present',
  '  Reviewed transactions daily and built the reconciliation process.', 'SKILLS: Excel, SQL',
])], { type: 'application/pdf' }), 'cv.pdf')
for (const [k, v] of Object.entries({
  firstName: 'Comment', lastName: 'Subject', email, phone,
  location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
})) form.append(k, v)
for (const [k, v] of Object.entries(await contactProofs({ email, phone }))) form.append(k, v)
form.append('consent', 'true')
const candidate = await json(await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form }))

const as = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
const path = `${BASE}/api/hr/candidates/${candidate.id}/comments`

const post = async (token, body) => json(await fetch(path, { method: 'POST', headers: as(token), body: JSON.stringify({ body }) }))
const list = async (token) => (await json(await fetch(path, { headers: as(token) }))).comments
const remove = (token, id) => fetch(`${path}/${id}`, { method: 'DELETE', headers: as(token) })
const commented = async (token) => (await json(await fetch(`${BASE}/api/hr/comments/commented`, { headers: as(token) }))).commented

section('Setup')
check('a colleague who is not an admin can sign in', Boolean(bobLogin.token))
check('a candidate exists to write about', Boolean(candidate.id))

section('Whether a note exists, without opening it')
check('nothing noted yet', !(await commented(alice.token)).some((r) => r.candidateId === candidate.id))

await post(bobLogin.token, `Bob screened them ${RUN}`)
await post(alice.token, `Alice agrees ${RUN}`)

const counted = (await commented(alice.token)).find((r) => r.candidateId === candidate.id)
check('the candidate is now listed as noted', Boolean(counted))
check('with how many notes', counted?.count === 2, `${counted?.count}`)
check('and another company does not see it',
  !(await commented(stranger.token)).some((r) => r.candidateId === candidate.id),
  'notes are company-scoped, and so is knowing they exist')

section('Who may delete')
const bobView = await list(bobLogin.token)
const bobsNote = bobView.find((c) => c.body.startsWith('Bob'))
const alicesNote = bobView.find((c) => c.body.startsWith('Alice'))
check('the author sees Delete on their own note', bobsNote?.canDelete === true)
check('but not on a colleague’s', alicesNote?.canDelete === false)

const refused = await remove(bobLogin.token, alicesNote.id)
check('and the server refuses it anyway', refused.status === 403, `HTTP ${refused.status}`)
check('the note is still there', (await list(alice.token)).some((c) => c.id === alicesNote.id))

const adminView = await list(alice.token)
check('an admin sees Delete on every note', adminView.every((c) => c.canDelete === true))

const foreign = await remove(stranger.token, bobsNote.id)
check('another company cannot delete one', foreign.status === 404,
  `HTTP ${foreign.status} — an id guessed from elsewhere finds nothing`)

const adminRemoved = await remove(alice.token, bobsNote.id)
check('an admin can delete a colleague’s note', adminRemoved.status === 200, `HTTP ${adminRemoved.status}`)

const ownRemoved = await remove(alice.token, alicesNote.id)
check('and their own', ownRemoved.status === 200)
check('once the last note goes, the candidate is no longer marked',
  !(await commented(alice.token)).some((r) => r.candidateId === candidate.id))

const gone = await remove(alice.token, alicesNote.id)
check('deleting it twice says it no longer exists', gone.status === 404)

section('The page')
const popover = read('../client/src/components/CommentsPopover.jsx')
check('the icon carries a dot when notes exist',
  /known > 0 && <span className="comments-dot"/.test(popover))
check('Delete is only drawn where the server allows it', /comment\.canDelete &&/.test(popover))
check('and asks first', /window\.confirm\('Delete this comment\?/.test(popover))
const store = read('../client/src/commented.js')
check('the counts are forgotten on sign-out',
  /addEventListener\(SIGNED_OUT, resetCommentCounts\)/.test(store),
  'another company signing in to the same tab must not see these dots')

section('Cleanup')
const { deleteCandidateCompletely } = await import('../server/src/profiles.js')
db.prepare('DELETE FROM candidate_comments WHERE candidate_id = ?').run(candidate.id)
for (const name of deleteCandidateCompletely(candidate.id)) {
  const p = new URL(`../server/uploads/${name}`, import.meta.url).pathname.slice(1)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}
for (const companyId of [alice.company.id, stranger.company.id]) {
  const recruiters = db.prepare('SELECT id FROM recruiters WHERE company_id = ?').all(companyId).map((r) => r.id)
  if (recruiters.length) {
    db.prepare(`DELETE FROM recruiter_password_resets WHERE recruiter_id IN (${recruiters.join(',')})`).run()
    db.prepare(`DELETE FROM seat_usage_periods WHERE recruiter_id IN (${recruiters.join(',')})`).run()
    db.prepare('DELETE FROM recruiters WHERE company_id = ?').run(companyId)
  }
  db.prepare('DELETE FROM billing_ledger WHERE company_id = ?').run(companyId)
  db.prepare('DELETE FROM companies WHERE id = ?').run(companyId)
}
check('test data removed',
  !db.prepare('SELECT id FROM companies WHERE name LIKE ?').get(`${MARK}%`)
  && !db.prepare('SELECT id FROM candidates WHERE id = ?').get(candidate.id))
db.close()

finish()
