/**
 * Applying signs you in and lands you on your own account.
 *
 * The security question this suite exists to answer: an application made with
 * an email address that already has an account must open the profile it just
 * created, and must not reach the older one.
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import Database from 'better-sqlite3'

import { BASE, contactProofs, createReporter, json, makePdf } from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const MARKER = `@cking-autosignin-${RUN}.example.com`
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const CV = [
  'Candidate One', 'Backend engineer - Tel Aviv',
  'BACKEND ENGINEER, PayFlow 2019-01 - present',
  '  Java services and SQL.',
  'SKILLS: Java, SQL',
]


/** Proves the email and phone already in `form`, and appends the proofs. */
async function appendProofs(form) {
  const proofs = await contactProofs({ email: form.get('email'), phone: form.get('phone') })
  for (const [key, value] of Object.entries(proofs)) form.append(key, value)
}

async function apply(email, first = 'Candidate') {
  const form = new FormData()
  form.append('cv', new Blob([await makePdf(CV)], { type: 'application/pdf' }), 'cv.pdf')
  for (const [k, v] of Object.entries({
    firstName: first, lastName: 'One', email,
    phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
    location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
  })) form.append(k, v)
  // Both contact details are proved before an account exists.
  await appendProofs(form)
  // The 18+ affirmation and agreement the form now sends and the route now requires.
  if (!form.has('consent')) form.append('consent', 'true')
  const res = await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form })
  return { res, body: await res.json().catch(() => ({})) }
}

const meWith = (token) => fetch(`${BASE}/api/candidate/me`, {
  headers: { authorization: `Bearer ${token}` },
})

section('Applying returns a session')
const email = `one.${RUN}${MARKER}`
const first = await apply(email)
check('the application succeeds', first.res.status === 201, `HTTP ${first.res.status}`)
check('a session token comes back', typeof first.body.token === 'string' && first.body.token.length > 20)
check('the reference is returned for the confirmation', Boolean(first.body.id))
check('so is what was read', typeof first.body.charactersRead === 'number')

section('That session opens their own account')
const mine = await meWith(first.body.token)
check('the account loads without signing in', mine.status === 200, `HTTP ${mine.status}`)
const account = await mine.json()
check('and it is the profile just created', account.candidate.email === email)
check('with their own reference', account.candidate.id === first.body.id)

section('A second application on the same address is refused')
/*
 * This section used to assert the opposite — that a second application created
 * a separate account, and that its token could not reach the first. The
 * property it was protecting is real: a token belongs to the row it was issued
 * for and is never resolved from the email. The mechanism it tested was the
 * bug.
 *
 * One address had no unique constraint and no guard, so a second application
 * inserted another row. Sign-in then resolved that address to the NEWEST row —
 * this suite only ever exercised the freshly-issued token, which is the one
 * case where the two agree. Through the sign-in door, the original owner's own
 * email now opened the impostor's empty profile, and everything they had built
 * was unreachable. That is what people reported as "it forgot my profile".
 *
 * Refusing the second application is the same guarantee, held earlier: there is
 * no shadow row to reach, so nothing has to be prevented from reaching it.
 */
const second = await apply(email, 'Impostor')
check('it is refused rather than given an account of its own', second.res.status === 409,
  `HTTP ${second.res.status}`)
check('and says what to do instead', /sign in/i.test(second.body.error ?? ''))
check('no second row was created',
  db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE lower(email) = lower(?)`)
    .get(email).n === 1)
check('and the original token still opens the original',
  (await json(await meWith(first.body.token))).candidate.id === first.body.id)

/* The other half of the same property: the address resolves to that one row,
   through the sign-in door as well as through the token. */
const asked = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: email }),
}))
const signedIn = await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: email, code: asked.devCode }),
}))
check('signing in with that address opens the original profile',
  (await json(await meWith(signedIn.token))).candidate.id === first.body.id,
  'the whole of the persistence bug was this line disagreeing with the token above')

section('The door is the email address, and only that')
/*
 * The phone is proved once, at signup, and sold to recruiters as part of a
 * Reveal. It is not a way in.
 *
 * Every email this product depends on goes to one address — the freshness
 * reminders, the notice that somebody revealed them, the warning before the
 * profile is hidden. Signing in through that mailbox is what keeps "active"
 * meaning something. A code by SMS would let a candidate whose inbox is dead
 * reset their activity clock and go on looking current to recruiters who are
 * paying to reach them.
 */
const byPhone = await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  /* Any phone-shaped string does: the refusal is about the channel, not about
     whether this number is on file. */
  body: JSON.stringify({ identifier: '052-123-4567' }),
})
check('a phone number is refused at sign-in', byPhone.status === 400, `${byPhone.status}`)
check('and the refusal says where to go instead',
  /email address you applied with/.test((await byPhone.clone().json()).error))
/* 400 rather than 404: the number is not being looked up and failing, it is
   not being accepted as an identifier at all. */
check('the account is not consulted to decide that',
  byPhone.status !== 404,
  'a 404 would leak whether a number is on file, to anyone who asks')

section('The session is a real candidate session, not a bypass')
const recruiterRoute = await fetch(`${BASE}/api/hr/candidates`, {
  headers: { authorization: `Bearer ${first.body.token}` },
})
check('it is refused on recruiter routes', recruiterRoute.status === 401 || recruiterRoute.status === 403,
  `HTTP ${recruiterRoute.status}`)

const tampered = `${first.body.token.slice(0, -3)}zzz`
check('a tampered token is refused', (await meWith(tampered)).status === 401)
check('no token is still refused', (await fetch(`${BASE}/api/candidate/me`)).status === 401)

section('The client goes to the account rather than the sign-in page')
const bundlePath = fs.readdirSync(new URL('../client/dist/assets/', import.meta.url))
  .find((name) => name.startsWith('index-') && name.endsWith('.js'))
const bundle = fs.readFileSync(new URL(`../client/dist/assets/${bundlePath}`, import.meta.url), 'utf8')
check('the built UI stores the returned session', bundle.includes('justApplied'))
check('and navigates to /account', bundle.includes('"/account"') || bundle.includes("'/account'"))
check('the confirmation travels with them', bundle.includes('Your profile is live'))

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
