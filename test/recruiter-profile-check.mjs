/**
 * A recruiter's own contact details: kept at sign-up, and editable afterwards.
 *
 * Two claims, and the second is the one with teeth. Keeping what registration
 * collected is easy to assert and easy to believe. Letting somebody edit their
 * own account is where a self-service route can quietly become the
 * administrator route with the gate taken off — so most of this is about what
 * PATCH /api/recruiter/me refuses: an unproved contact change, somebody else's
 * account, and a rename that would move the credential they sign in with.
 */
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'

import { BASE, contactProofs, createReporter, json, registerAndSignIn, approveCompanyById } from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const NAME = `Profile ${RUN}`
const EMAIL = `dana.${RUN}@example.com`
const PHONE = '052-555-0100'
const WEBSITE = 'example.com'

const H = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })
const me = (token) => fetch(`${BASE}/api/recruiter/me`, { headers: H(token) })
const save = (token, body) => fetch(`${BASE}/api/recruiter/me`, {
  method: 'PATCH', headers: H(token), body: JSON.stringify(body),
})

// ---------------------------------------------------------------------------

section('Sign-up keeps what it collected')

const org = await registerAndSignIn({
  companyName: NAME, firstName: 'Dana', lastName: `Prof${RUN}`,
  email: EMAIL, phone: PHONE, website: WEBSITE,
})
await approveCompanyById(org.company.id)
const token = org.token

const row = db.prepare(`SELECT * FROM recruiters WHERE id = ?`).get(org.recruiter.id)
check('the email is on the account', row.email === EMAIL, row.email ?? '(none)')
check('so is the phone number', row.phone === PHONE, row.phone ?? '(none)')
/* Stored with a scheme even though it was typed without one — a bare host is a
   clear answer to "website" and is completed rather than refused. */
check('and the website, completed to a URL', row.website === `https://${WEBSITE}`, row.website ?? '(none)')

const profile = await json(await me(token))
check('and the profile hands all three back', profile.recruiter.email === EMAIL
  && profile.recruiter.phone === PHONE
  && profile.recruiter.website === `https://${WEBSITE}`,
JSON.stringify({ email: profile.recruiter.email, phone: profile.recruiter.phone, website: profile.recruiter.website }))

// ---------------------------------------------------------------------------

section('Editing your own name')

const renamed = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: EMAIL, phone: PHONE, website: WEBSITE,
})
check('a recruiter can rename themselves', renamed.status === 200, `HTTP ${renamed.status}`)

const after = await json(await me(token))
check('the new name is returned', after.recruiter.firstName === 'Danielle'
  && after.recruiter.lastName === 'Prophet',
`${after.recruiter.firstName} ${after.recruiter.lastName}`)

/*
 * The username is the credential. Deriving it from the name at creation is a
 * convenience; rewriting it on a rename would sign somebody out of their own
 * account for fixing a typo in their surname.
 */
check('but the username they sign in with does not move',
  after.recruiter.username === org.recruiter.username,
  `${org.recruiter.username} -> ${after.recruiter.username}`)

check('and the name is still theirs after signing in again',
  db.prepare(`SELECT first_name FROM recruiters WHERE id = ?`).get(org.recruiter.id).first_name === 'Danielle')

// ---------------------------------------------------------------------------

section('A changed contact has to be proved')

const NEW_EMAIL = `moved.${RUN}@example.com`
const NEW_PHONE = '052-555-0199'

const unproved = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: NEW_EMAIL, phone: PHONE, website: WEBSITE,
})
check('a new email with no proof is refused', unproved.status === 400, `HTTP ${unproved.status}`)
check('and says which one to verify',
  /email/i.test((await unproved.json()).error ?? ''))

const unprovedPhone = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: EMAIL, phone: NEW_PHONE, website: WEBSITE,
})
check('a new phone number with no proof is refused too', unprovedPhone.status === 400,
  `HTTP ${unprovedPhone.status}`)

check('and nothing was written on the way to refusing',
  db.prepare(`SELECT email, phone FROM recruiters WHERE id = ?`).get(org.recruiter.id).email === EMAIL)

/* A proof is for one destination. One made out to a different address must not
   let a third one through — that would make the check a formality. */
const wrongProof = await contactProofs({ email: `elsewhere.${RUN}@example.com`, phone: PHONE })
const mismatched = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: NEW_EMAIL, phone: PHONE, website: WEBSITE,
  emailProof: wrongProof.emailProof,
})
check('a proof for a different address does not cover this one', mismatched.status === 400,
  `HTTP ${mismatched.status}`)

const proofs = await contactProofs({ email: NEW_EMAIL, phone: NEW_PHONE })
const proved = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: NEW_EMAIL, phone: NEW_PHONE, website: WEBSITE,
  ...proofs,
})
check('with proof, both are saved', proved.status === 200, `HTTP ${proved.status}`)

const settled = db.prepare(`SELECT email, phone FROM recruiters WHERE id = ?`).get(org.recruiter.id)
check('and the account now holds them', settled.email === NEW_EMAIL && settled.phone === NEW_PHONE,
  JSON.stringify(settled))

/* Unchanged is not the same as unproved: re-saving what is already on file
   must not demand a fresh code for something nobody touched. */
const untouched = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: NEW_EMAIL, phone: NEW_PHONE, website: WEBSITE,
})
check('saving without changing a contact needs no new proof', untouched.status === 200,
  `HTTP ${untouched.status}`)

// ---------------------------------------------------------------------------

section('What the route will not do')

const blank = await save(token, {
  firstName: '', lastName: 'Prophet', email: NEW_EMAIL, phone: NEW_PHONE, website: WEBSITE,
})
check('a blank first name is refused', blank.status === 400, `HTTP ${blank.status}`)

const noSite = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet', email: NEW_EMAIL, phone: NEW_PHONE, website: '',
})
check('and so is a missing website', noSite.status === 400, `HTTP ${noSite.status}`)

const anonymous = await fetch(`${BASE}/api/recruiter/me`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ firstName: 'Nobody', lastName: 'Here', email: NEW_EMAIL, phone: NEW_PHONE, website: WEBSITE }),
})
check('a stranger cannot reach it', anonymous.status === 401, `HTTP ${anonymous.status}`)

/*
 * The route takes no target id at all, which is what keeps it from being the
 * administrator's edit route with the gate removed. A colleague's id in the
 * body has to change nothing.
 */
const other = await registerAndSignIn({
  companyName: `Other ${RUN}`, firstName: 'Omri', lastName: `Other${RUN}`,
  email: `omri.${RUN}@example.com`,
})
const beforeOther = db.prepare(`SELECT first_name FROM recruiters WHERE id = ?`).get(other.recruiter.id)

await save(token, {
  id: other.recruiter.id, recruiterId: other.recruiter.id,
  firstName: 'Hijacked', lastName: 'Prophet',
  email: NEW_EMAIL, phone: NEW_PHONE, website: WEBSITE,
})
const afterOther = db.prepare(`SELECT first_name FROM recruiters WHERE id = ?`).get(other.recruiter.id)
check('an id in the body reaches nobody else',
  afterOther.first_name === beforeOther.first_name,
  `${beforeOther.first_name} -> ${afterOther.first_name}`)
check('it edited the caller instead',
  db.prepare(`SELECT first_name FROM recruiters WHERE id = ?`).get(org.recruiter.id).first_name === 'Hijacked')

// ------------------------------------------------------------------ tidy ---

section('Cleanup')

const ids = db.prepare(`SELECT id FROM companies WHERE name IN (?, ?)`).all(NAME, `Other ${RUN}`).map((r) => r.id)
if (ids.length) {
  const list = ids.join(',')
  const rl = db.prepare(`SELECT id FROM recruiters WHERE company_id IN (${list})`).all()
    .map((r) => r.id).join(',') || '-1'
  db.exec(`
    DELETE FROM retrieval_sessions WHERE recruiter_id IN (${rl});
    DELETE FROM jobs WHERE recruiter_id IN (${rl});
    DELETE FROM folder_items WHERE folder_id IN (SELECT id FROM folders WHERE recruiter_id IN (${rl}));
    DELETE FROM folders WHERE recruiter_id IN (${rl});
    DELETE FROM seat_usage_periods WHERE recruiter_id IN (${rl});
    DELETE FROM seat_purchases WHERE company_id IN (${list});
    DELETE FROM billing_ledger WHERE company_id IN (${list});
    DELETE FROM organization_reveals WHERE company_id IN (${list});
    DELETE FROM recruiters WHERE company_id IN (${list});
    DELETE FROM companies WHERE id IN (${list});
  `)
}
check('test companies removed', db.prepare(
  `SELECT COUNT(*) AS n FROM companies WHERE name IN (?, ?)`,
).get(NAME, `Other ${RUN}`).n === 0)

finish()
