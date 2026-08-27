/**
 * A profile made once, and never made again.
 *
 * The bug this exists for: a candidate created a profile, signed out, came back
 * to the site and was served the account-creation form — nothing on it knew
 * they had an account — filled it in, and from that moment their own email
 * signed them into the new empty row while everything they had built sat on a
 * row no lookup in the codebase could return.
 *
 * Four things had to be true at once for that to happen, and each is checked
 * here separately, because fixing one of them is not fixing the bug:
 *
 *   1. `candidates.email` had no unique constraint and the apply route had no
 *      guard, so a second row could exist.
 *   2. Applying binds the session to the row it inserted; signing in resolves
 *      to the NEWEST row. They agree only while there is one.
 *   3. Sign-up accepted a seven-digit phone that sign-in could never resolve,
 *      so some accounts were unreachable from the moment they were made.
 *   4. The landing page never asked whether the visitor was already signed in.
 *
 * The Professional Summary rides the same lifecycle, so it is checked here too:
 * a guarantee that survives a page refresh but not a sign-out is not one.
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import Database from 'better-sqlite3'

import { BASE, contactProofs, createReporter, json, makePdf } from './helpers.mjs'
import { duplicateIdentities, emailKey } from '../server/src/db.js'
import { normalizeDestination } from '../server/src/verification.js'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const MARKER = `@cking-persist-${RUN}.example.com`
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

/* Digits, and per run: a phone number identifies an account now, so two runs
   sharing one would have the second refused as a repeat of the first. RUN is
   base 36 and carries letters, which a phone field will not take. */
const PHONE_RUN = String(Date.now()).slice(-6)
const phoneFor = (tail) => `052-${PHONE_RUN.slice(0, 3)}-${tail}`

const J = { 'content-type': 'application/json' }
const H = (token) => ({ ...J, authorization: `Bearer ${token}` })

const CV = [
  'Dana Persist', 'Product Manager',
  'PRODUCT MANAGER, Monday.com 2019-01 - present',
  '  Led B2B SaaS products end to end. Six years of experience in product.',
  '  Worked with engineering, design and sales on roadmap and delivery.',
  'SOFTWARE ENGINEER, Ziv Haddad Systems Ltd 2016-01 - 2018-12',
  '  Built internal tooling in Python and SQL for a small consultancy.',
  'SKILLS: Product, Roadmap, SQL, Analytics',
]

async function apply(fields = {}) {
  const email = fields.email ?? `dana.${RUN}${MARKER}`
  const phone = fields.phone ?? phoneFor('4001')

  const form = new FormData()
  form.append('cv', new Blob([await makePdf(CV)], { type: 'application/pdf' }), 'cv.pdf')
  for (const [key, value] of Object.entries({
    firstName: 'Dana', lastName: 'Persist', email, phone,
    location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
    openToRelocation: 'yes', openToAllOpportunities: 'true', consent: 'true',
    ...fields,
  })) form.append(key, value)

  for (const [key, value] of Object.entries(await contactProofs({ email, phone }))) {
    form.append(key, value)
  }

  const res = await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form })
  return { res, body: await res.json().catch(() => ({})), email, phone }
}

/** The whole sign-in round trip, exactly as the portal walks it. */
async function signIn(identifier) {
  const asked = await fetch(`${BASE}/api/candidate/request-code`, {
    method: 'POST', headers: J, body: JSON.stringify({ identifier }),
  })
  if (!asked.ok) return { status: asked.status, token: null }

  const code = (await asked.json()).devCode
  const done = await fetch(`${BASE}/api/candidate/verify-code`, {
    method: 'POST', headers: J, body: JSON.stringify({ identifier, code }),
  })
  return { status: done.status, token: (await done.json().catch(() => ({}))).token ?? null }
}

const me = async (token) => json(await fetch(`${BASE}/api/candidate/me`, { headers: H(token) }))

// --------------------------------------------------------------- the loop ---

section('A profile survives signing out and back in')

const first = await apply()
check('the profile is created', first.res.status === 201, `HTTP ${first.res.status}`)
const id = first.body.id

const initial = await me(first.body.token)
check('and loads straight away', initial.candidate?.id === id)
check('with the CV attached', initial.documents?.length >= 1)

await fetch(`${BASE}/api/auth/sign-out`, { method: 'POST', headers: H(first.body.token) })

const back = await signIn(first.email)
check('signing in again works', back.status === 200 && Boolean(back.token))

const returned = await me(back.token)
check('and opens the SAME profile', returned.candidate?.id === id,
  'not a new row that happens to have the same address on it')
check('the CV is still attached', returned.documents?.length === initial.documents?.length)
check('the city is still theirs', returned.candidate?.location === 'Tel Aviv')
check('and so are their preferences', returned.preferences?.openToAll === true)

section('Either contact detail opens the same account')

const byPhone = await signIn(first.phone)
check('signing in by phone works', byPhone.status === 200 && Boolean(byPhone.token))
check('and reaches the same row', (await me(byPhone.token)).candidate?.id === id,
  'an email and a phone on one account are one identity, not two')

section('A second application on the same details is refused')

/*
 * The heart of it. This used to insert a second row, and every sign-in
 * afterwards resolved the address to that row instead of this one.
 */
const again = await apply({ email: first.email })
check('a repeat application is refused', again.res.status === 409, `HTTP ${again.res.status}`)
check('and is told where to go instead', /sign in/i.test(again.body.error ?? ''))

const sameByPhone = await apply({ email: `other.${RUN}${MARKER}`, phone: first.phone })
check('a repeat on the phone alone is refused too', sameByPhone.res.status === 409,
  'one identity is either contact detail, not both together')

check('there is exactly one row for that address',
  db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE lower(email) = lower(?)`)
    .get(first.email).n === 1)

const afterAttempts = await signIn(first.email)
check('and it is still the original that signs in',
  (await me(afterAttempts.token)).candidate?.id === id)

section('A number that cannot sign in cannot sign up')

/*
 * Sign-up accepted seven digits; phoneKey needs nine to build a lookup key at
 * all. The gap between them was an account that could never be reached by
 * phone, whose owner met "no application was found" and an offer to create one.
 */
const shortAsked = await fetch(`${BASE}/api/verify/request`, {
  method: 'POST', headers: J,
  body: JSON.stringify({ channel: 'phone', destination: '03-123456' }),
})
check('a number too short to resolve cannot even be verified',
  shortAsked.status === 400, `HTTP ${shortAsked.status}`)

/*
 * And every unkeyable number is its own destination, not one shared one.
 *
 * normalizeDestination returned '' for anything phoneKey could not key, so a
 * code proved against "03-123456" satisfied a check for "7654321" and for
 * "abcdefg" — one proof for every malformed number, which is not a
 * verification. Both are refused outright now, which is what makes them
 * different rather than equal.
 */
const otherShort = await fetch(`${BASE}/api/verify/request`, {
  method: 'POST', headers: J,
  body: JSON.stringify({ channel: 'phone', destination: '7654321' }),
})
check('and so is a different one', otherShort.status === 400)

section('The profile edits, and the edits survive too')

const edit = new FormData()
for (const [key, value] of Object.entries({
  firstName: 'Dana', lastName: 'Persist', email: first.email, phone: first.phone,
  location: 'Haifa', availability: 'Within 1 month', capacity: 'Full time',
})) edit.append(key, value)

const saved = await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: { authorization: `Bearer ${afterAttempts.token}` }, body: edit,
})
check('the edit saves', saved.ok, `HTTP ${saved.status}`)

const reopened = await signIn(first.email)
const afterEdit = await me(reopened.token)
check('the edit is there after signing out and in', afterEdit.candidate?.location === 'Haifa')
check('and it is still one row', afterEdit.candidate?.id === id)
check('with the CV still attached', afterEdit.documents?.length >= 1)

section('The Professional Summary is part of that lifecycle')

/*
 * Nobody wrote one on this profile, so one was made. The point of checking it
 * here rather than only in the summary suite is that it has to survive the same
 * round trip everything else does — a summary that is regenerated on every load
 * is not persisted, and one that vanishes on sign-out is not either.
 */
const summary = afterEdit.candidate?.notes
check('a summary exists without anyone having asked for one', Boolean(summary),
  'generated from the CV when the candidate writes none')
check('and it names no employer from the CV',
  !/Monday\.com|Ziv Haddad/i.test(String(summary)), String(summary).slice(0, 80))

const laterStill = await signIn(first.email)
check('it is the same summary on the next sign-in',
  (await me(laterStill.token)).candidate?.notes === summary,
  'persisted, not regenerated per request')

section('The sign-up form is always the sign-up form')

/*
 * This section used to assert the opposite, and the reversal is the point.
 *
 * The page briefly hid the form behind a "You already have a profile" card
 * whenever the browser held a candidate session. It stopped one person making
 * a second account and, in exchange, stopped the other person at a shared
 * computer making their first — with no way past it, since the card's only
 * button went to somebody else's profile.
 *
 * Duplicates are the server's job, and it does it on the details typed rather
 * than on a guess about who is reading. So the form renders unconditionally,
 * and a collision comes back as an error on the form naming the field.
 */
const upload = fs.readFileSync(new URL('../client/src/pages/UploadPage.jsx', import.meta.url), 'utf8')
check('nothing stands in front of the form',
  !upload.includes('You already have a profile') && !upload.includes('signedIn'),
  'a shared computer has more than one person at it')
check('and a duplicate is an error on the form, not a card instead of it',
  !upload.includes("state: 'exists'")
  && upload.includes("error={status.state === 'error' ? status.message : ''}"),
  'the server names the detail that is taken, and the field stays there to fix')

const portal = fs.readFileSync(new URL('../client/src/pages/CandidatePortal.jsx', import.meta.url), 'utf8')
check('only a refusal ends the session',
  /error\?\.status === 401/.test(portal) && !/load\(\)\.catch\(\(\) => signOutRequest\(\)\)/.test(portal),
  'a 500 or a dropped connection used to sign the candidate out')

// ---------------------------------------------------------------- cleanup ---


section('An identity cannot be claimed from the edit side either')

/*
 * The apply route refuses a second row; the edit route did not, so the same
 * collision could be made from the other direction — point this profile's phone
 * at a number another row already holds, and every sign-in with it lands on
 * whichever row is newer.
 */
const second = await apply({
  email: `rival.${RUN}${MARKER}`, phone: phoneFor('4009'), firstName: 'Rival',
})
check('a second, genuinely different candidate is fine', second.res.status === 201,
  `HTTP ${second.res.status}`)

const rivalIn = await signIn(second.email)
const steal = new FormData()
for (const [key, value] of Object.entries({
  firstName: 'Rival', lastName: 'Persist', email: second.email,
  /* Their own row's phone pointed at the first candidate's number, with a real
     proof for it — proving control of a destination is not proof that the
     account already using it is yours. */
  phone: first.phone, location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
  phoneProof: (await contactProofs({ email: second.email, phone: first.phone })).phoneProof,
})) steal.append(key, value)

const stolen = await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: { authorization: `Bearer ${rivalIn.token}` }, body: steal,
})
check('taking a contact detail another profile uses is refused', stolen.status === 409,
  `HTTP ${stolen.status}`)
check('and the number still opens the original profile',
  (await me((await signIn(first.phone)).token)).candidate?.id === id)

section('And the form can still change a contact detail')

/*
 * The other half of that rule. The edit form asked a candidate to verify a new
 * number, waited for the code, enabled the button — and then never sent the
 * proof, so the server refused something the interface had just approved.
 */
const form = fs.readFileSync(
  new URL('../client/src/components/CandidateForm.jsx', import.meta.url), 'utf8')
check('the edit form sends its proofs',
  !/if \(!isEdit\) \{\s*\n\s*data\.append\('emailProof'/.test(form)
  && /data\.append\('emailProof', proofs\.email\)/.test(form),
  'they were sent only when creating an account, so no edit could change either')

const moved = phoneFor('4011')
const change = new FormData()
for (const [key, value] of Object.entries({
  firstName: 'Dana', lastName: 'Persist', email: first.email, phone: moved,
  location: 'Haifa', availability: 'Within 1 month', capacity: 'Full time',
  phoneProof: (await contactProofs({ email: first.email, phone: moved })).phoneProof,
})) change.append(key, value)

const changed = await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: { authorization: `Bearer ${(await signIn(first.email)).token}` },
  body: change,
})
check('a proved new number saves', changed.ok, `HTTP ${changed.status}`)
check('and signing in with it opens the same profile',
  (await me((await signIn(moved)).token)).candidate?.id === id)


section('One mailbox is one account')

/*
 * Gmail and Googlemail treat dots and +tags as decoration: dana.smith@gmail.com
 * and danasmith+jobs@gmail.com are one inbox and one person. Before this, that
 * person signed up with one spelling, came back with the other, was told no
 * application existed, and was invited to create a second profile on a mailbox
 * they already had — which is how a profile goes missing.
 *
 * The other half matters just as much. Everywhere else a dot in the local part
 * is significant, and folding it would hand one person another person's
 * account. So every case below is paired with its negative.
 */
for (const [label, a, b, same] of [
  ['a dot', 'dana.persist@gmail.com', 'danapersist@gmail.com', true],
  ['several dots', 'd.a.n.a@gmail.com', 'dana@gmail.com', true],
  ['a +tag', 'dana@gmail.com', 'dana+jobs@gmail.com', true],
  ['a +tag and dots together', 'da.na+jobs@gmail.com', 'dana@gmail.com', true],
  ['capitalisation', 'Dana.Persist@Gmail.COM', 'danapersist@gmail.com', true],
  ['googlemail', 'dana.persist@googlemail.com', 'danapersist@googlemail.com', true],
  ['googlemail is its own domain', 'dana@googlemail.com', 'dana@gmail.com', false],
  ['a dot at another provider', 'dana.persist@outlook.com', 'danapersist@outlook.com', false],
  ['a +tag at another provider', 'dana@company.com', 'dana+jobs@company.com', false],
  ['one letter', 'dana@gmail.com', 'danna@gmail.com', false],
]) {
  check(`${label}: ${same ? 'one mailbox' : 'two mailboxes'}`,
    (emailKey(a) === emailKey(b)) === same, `${emailKey(a)} vs ${emailKey(b)}`)
}

check('case is folded everywhere, not only at Gmail',
  emailKey('DANA@Company.COM') === emailKey('dana@company.com'), emailKey('DANA@Company.COM'))
check('and the rest of a non-Gmail address is left exactly as written',
  emailKey('J.Smith+cv@Company.com') === 'j.smith+cv@company.com',
  emailKey('J.Smith+cv@Company.com'))

section('Sign-up, sign-in and the codes agree on what that means')

/*
 * The risk this closes: sign-up, sign-in, the login codes and the duplicate
 * guard each have to decide whether two addresses are one identity. There were
 * two functions doing it — the lookup folded Gmail aliases, the verification
 * path only lowercased — and when they disagreed the evidence was a profile
 * nobody could reach. There is one function now, and this is the check that
 * keeps it one.
 */
check('the verification path canonicalises through the lookup key',
  ['Dana.Persist@gmail.com', 'dana+x@GMAIL.com', 'j.smith@company.com', 'A.B@Example.com']
    .every((address) => normalizeDestination('email', address) === emailKey(address)))

const verificationSource = fs.readFileSync(
  new URL('../server/src/verification.js', import.meta.url), 'utf8')
check('and does not keep a second one of its own',
  verificationSource.includes('emailKey(text)')
  && !/return\s+text\.toLowerCase\(\)/.test(verificationSource))

check('the lookup decides by domain, not by how the typed address happens to look',
  fs.readFileSync(new URL('../server/src/db.js', import.meta.url), 'utf8')
    .includes('if (aliasable(value)) {'),
  'gating on "the typed address has dots" missed the case where the stored one did')

section('An aliased address cannot open a second account')

/* Real Gmail spellings, made unique by the run, cleaned up by exact address. */
const gmailFixtures = []
const gmail = `dana.persist.${PHONE_RUN}@gmail.com`
const gmailAliased = `danapersist${PHONE_RUN}+jobs@GMAIL.com`

const firstGmail = await apply({ email: gmail, phone: phoneFor('4021') })
check('a Gmail profile is created', firstGmail.res.status === 201, `HTTP ${firstGmail.res.status}`)
gmailFixtures.push(gmail)

const secondGmail = await apply({ email: gmailAliased, phone: phoneFor('4022') })
check('the same mailbox, dotless and +tagged and capitalised, is refused',
  secondGmail.res.status === 409, `HTTP ${secondGmail.res.status}`)
check('and the refusal says which detail is taken',
  /email address/i.test(secondGmail.body.error ?? ''), secondGmail.body.error)

check('signing in with the spelling that was refused opens the profile it clashed with',
  (await me((await signIn(gmailAliased)).token))?.candidate?.id === firstGmail.body.id,
  'refused a new account and given the old one — the two halves of one rule')

/* The negative, end to end: at any other domain the dots are part of the name. */
const dotted = await apply({ email: `a.b.alias.${RUN}${MARKER}`, phone: phoneFor('4023') })
const undotted = await apply({ email: `abalias.${RUN}${MARKER}`, phone: phoneFor('4024') })
check('elsewhere, the same letters without the dots are a different person',
  dotted.res.status === 201 && undotted.res.status === 201,
  `HTTP ${dotted.res.status} then ${undotted.res.status}`)

section('Duplicates that already exist are found and reported')

/*
 * A guard cannot undo the rows written before it. Those are the ones that would
 * strand somebody, so this makes a pair the way history would have — straight
 * into the table, past the check — and asks whether we can still see it.
 *
 * Reported, not merged: merging two profiles means choosing whose CV, reveals
 * and conversations survive, and that is the owner's call, not a boot step.
 */
const legacy = await apply({ email: `legacy.${RUN}${MARKER}`, phone: phoneFor('4025') })
gmailFixtures.push(gmailAliased.toLowerCase())
db.prepare(`UPDATE candidates SET email = ?, phone = ? WHERE id = ?`).run(
  gmailAliased.toLowerCase(),
  `+972-52-${PHONE_RUN.slice(0, 3)}-4021`,
  legacy.body.id,
)

const clashes = duplicateIdentities()
const emailGroup = clashes.byEmail.find((group) => group.ids.includes(legacy.body.id))
const phoneGroup = clashes.byPhone.find((group) => group.ids.includes(legacy.body.id))

check('the pair is reported by mailbox', Boolean(emailGroup), JSON.stringify(clashes.byEmail))
check('and both spellings are named in the one group',
  Boolean(emailGroup?.ids.includes(firstGmail.body.id)), JSON.stringify(emailGroup))
check('and by number, across the formats it was written in',
  Boolean(phoneGroup?.ids.includes(firstGmail.body.id)), JSON.stringify(phoneGroup))
check('the report leaves both profiles standing',
  db.prepare(`SELECT COUNT(*) n FROM candidates WHERE id IN (?, ?)`)
    .get(legacy.body.id, firstGmail.body.id).n === 2,
  'nothing is merged or deleted behind the candidate')

section('Cleanup')

const { deleteCandidateCompletely } = await import('../server/src/profiles.js')
const { UPLOAD_DIR } = await import('../server/src/db.js')
const path = await import('node:path')

const mine = db.prepare(`SELECT id FROM candidates WHERE email LIKE ?`).all(`%${MARKER}`)
let unlinked = 0
for (const row of mine) {
  for (const stored of deleteCandidateCompletely(row.id)) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, stored)); unlinked += 1 } catch { /* gone */ }
  }
}
/*
 * The Gmail rows cannot carry the marker — a real aliasing domain is the whole
 * point of them — so they go by the exact addresses this run generated. An
 * equality match on a string we built ourselves can only reach our own rows.
 */
let extra = 0
for (const address of gmailFixtures) {
  const row = db.prepare(`SELECT id, email FROM candidates WHERE email = ?`).get(address)
  if (!row) continue
  if (row.email !== address) throw new Error(`refusing to erase ${row.id}: not this run's`)
  for (const stored of deleteCandidateCompletely(row.id)) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, stored)); unlinked += 1 } catch { /* gone */ }
  }
  extra += 1
}

check('test data removed', true, `${mine.length + extra} candidate(s), ${unlinked} file(s)`)
db.close()

finish()
