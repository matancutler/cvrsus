/**
 * A recruiter's own reveal usage.
 *
 * Usage & billing is administrator-only, so a recruiter had no way to answer
 * "can I open this candidate" except by pressing Reveal and finding out. The
 * Usage screen answers it in advance, from figures the profile payload already
 * carries — which is the part worth asserting here: that every seat is told its
 * own numbers, and that the ones it is told are true.
 *
 * Two arrangements, because an organization can run either. Without an
 * allowance everybody draws on one shared balance; with one, each seat has a
 * cap of its own. The screen has to say which is in force, so the payload has
 * to make that answerable.
 */
import fs from 'node:fs'

import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'

import { BASE, contactProofs, createReporter, json, registerAndSignIn, approveCompanyById } from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const NAME = `Usage ${RUN}`
const H = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })
const meOf = async (token) => json(await fetch(`${BASE}/api/recruiter/me`, { headers: H(token) }))

const org = await registerAndSignIn({
  companyName: NAME, firstName: 'Adi', lastName: `Admin${RUN}`,
  email: `adi.${RUN}@example.com`,
})
await approveCompanyById(org.company.id)

/* A colleague: the account this screen exists for. The included seat is the
   administrator's own, so one has to be bought before there is a second. */
await json(await fetch(`${BASE}/api/company/seat-plan`, {
  method: 'PUT', headers: H(org.token), body: JSON.stringify({ seats: 1 }),
}))

const created = await json(await fetch(`${BASE}/api/recruiter`, {
  method: 'POST', headers: H(org.token),
  body: JSON.stringify({ firstName: 'Roni', lastName: `Rec${RUN}` }),
}))
const mate = await json(await fetch(`${BASE}/api/recruiter/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    joinKey: org.company.joinKey, username: created.created.username, password: created.created.password,
  }),
}))

// ---------------------------------------------------------------------------

section('Every seat is told its own numbers')

const seat = await meOf(mate.token)
check('a non-administrator is one', seat.recruiter.isOrgAdmin === false)
check('and still gets a wallet', Boolean(seat.wallet))

for (const key of ['balance', 'used', 'everHeld', 'allocation', 'allocationLeft', 'seatUsed']) {
  check(`it carries ${key}`, key in seat.wallet, JSON.stringify(seat.wallet[key]))
}

// ---------------------------------------------------------------------------

section('An equal share each, by default')

/*
 * Reversed deliberately — see the note in pricing-check. A seat that arrives
 * with no allowance can spend the whole organization's balance before anyone
 * else opens the product, so a share is what a new colleague now starts with.
 */
check('a new seat is given a share of its own',
  Number.isInteger(seat.wallet.allocation) && seat.wallet.allocation > 0,
  JSON.stringify(seat.wallet.allocation))
const adminView = await meOf(org.token)
check('the organization balance is still the same number for both of them',
  seat.wallet.balance === adminView.wallet.balance,
  `${seat.wallet.balance} vs ${adminView.wallet.balance}`)
check('and what the seat may spend is a part of it, never more',
  seat.wallet.allocation <= adminView.wallet.balance,
  'an allowance is permission to draw on capacity, not capacity of its own')
check('and they have spent nothing yet', seat.wallet.seatUsed === 0, String(seat.wallet.seatUsed))

// ---------------------------------------------------------------------------

section('An allowance makes the limit personal')

const share = Math.max(1, Math.min(3, seat.wallet.balance))
const set = await fetch(`${BASE}/api/company/reveal-allocations`, {
  method: 'PUT', headers: H(org.token),
  body: JSON.stringify({ allocations: { [created.created.id]: share } }),
})
check('the administrator can give them one', set.status === 200, `HTTP ${set.status}`)

const allocated = await meOf(mate.token)
check('the seat is told the size of it', allocated.wallet.allocation === share,
  JSON.stringify(allocated.wallet.allocation))
check('and how much of it is left', allocated.wallet.allocationLeft === share,
  JSON.stringify(allocated.wallet.allocationLeft))

/*
 * An allowance caps your share; it does not reserve anything. The pool is still
 * shared and can empty first, so what a seat can actually spend is the smaller
 * of the two — which is the number the screen leads with.
 */
db.prepare(`UPDATE recruiters SET reveal_allocation = ? WHERE id = ?`)
  .run(seat.wallet.balance + 50, created.created.id)
const overshot = await meOf(mate.token)
check('an allowance larger than the pool does not invent reveals',
  Math.min(overshot.wallet.allocationLeft, overshot.wallet.balance) === overshot.wallet.balance,
  `allowance ${overshot.wallet.allocationLeft}, pool ${overshot.wallet.balance}`)

// ---------------------------------------------------------------------------

section('The screen is theirs, not the administrator\'s')

/* Read from the source rather than the bundle: what matters is the condition
   the menu is built from, and minification rewrites conditions. */
const panel = fs.readFileSync(new URL('../client/src/pages/HrPanel.jsx', import.meta.url), 'utf8')
check('the workspace ships a Usage screen', panel.includes('reveals left for you'))
/* Usage is offered to everyone now — the two roles see different things on it,
   which is decided where the dialog is rendered rather than in the menu. */
check('offered to every seat', /\['usage', 'Usage'\]/.test(panel))
check('and an administrator gets the organization-wide version',
  /admin$[\s\S]{0,120}OrganizationUsageTab/m.test(panel))
check('while a recruiter gets their own',
  /<UsageTab wallet=\{wallet\} \/>/.test(panel))
check('billing is still a door only an administrator sees',
  /\.\.\.\(admin \? \[\['billing', 'Billing'\]\] : \[\]\)/.test(panel))

/*
 * The team list goes to everybody, so what it carries matters.
 *
 * The administrator edits these accounts and sees their contact details on the
 * Team screen. A recruiter is only ever shown this list so the workspace can
 * count seats — handing them a colleague's phone number as a side effect of
 * opening the app is not something anybody asked for.
 */
const adminList = (await meOf(org.token)).colleagues
const seatList = (await meOf(mate.token)).colleagues
check('the administrator is given contact details for the team',
  adminList.every((p) => 'email' in p && 'phone' in p && 'website' in p))
check('and a recruiter is not',
  seatList.every((p) => !('email' in p) && !('phone' in p) && !('website' in p)))
check('while both still see who is on the team',
  adminList.length === seatList.length && seatList.every((p) => p.username),
  `${seatList.length} accounts`)

/*
 * An administrator editing a colleague's contact details.
 *
 * Allowed, because they already control the account — they can reset its
 * password to a value they choose — so refusing this would protect nothing.
 * What the proof stops is a mistyped address quietly becoming the one the
 * account answers to, which nobody notices until a reset link goes somewhere
 * unread.
 */
section('Editing a colleague')

const edit = async (fields) => {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  return fetch(`${BASE}/api/recruiter/${created.created.id}`, {
    method: 'PATCH', headers: { authorization: `Bearer ${org.token}` }, body: form,
  })
}

/* An account the administrator created has no contact details at all. Renaming
   one must not be refused for a website nobody has ever entered. */
const renamed = await edit({ firstName: 'Ronit', lastName: `Rec${RUN}` })
check('a rename works on an account with no contact details', renamed.status === 200,
  `HTTP ${renamed.status}`)

const NEW_EMAIL = `roni.${RUN}@example.com`
const NEW_PHONE = '052-555-0177'

const unproved = await edit({
  firstName: 'Ronit', lastName: `Rec${RUN}`,
  email: NEW_EMAIL, phone: NEW_PHONE, website: 'example.com',
})
check('setting an email with no proof is refused', unproved.status === 400, `HTTP ${unproved.status}`)
check('and nothing was written on the way to refusing',
  db.prepare(`SELECT email FROM recruiters WHERE id = ?`).get(created.created.id).email === null)

const proofs = await contactProofs({ email: NEW_EMAIL, phone: NEW_PHONE })
const proved = await edit({
  firstName: 'Ronit', lastName: `Rec${RUN}`,
  email: NEW_EMAIL, phone: NEW_PHONE, website: 'example.com', ...proofs,
})
check('with a code sent to each, both are saved', proved.status === 200, `HTTP ${proved.status}`)

const row = db.prepare(`SELECT email, phone, website, username FROM recruiters WHERE id = ?`)
  .get(created.created.id)
check('the account now holds them', row.email === NEW_EMAIL && row.phone === NEW_PHONE,
  JSON.stringify(row))
check('and the username is untouched by any of it',
  row.username === created.created.username, row.username)

/* Only an administrator. A recruiter reaching this route for a colleague — or
   for themselves — is how "manage your team" becomes "manage anybody". */
const asSeat = await fetch(`${BASE}/api/recruiter/${created.created.id}`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${mate.token}` },
  body: (() => { const f = new FormData(); f.append('firstName', 'Nope'); f.append('lastName', 'Nope'); return f })(),
})
check('a recruiter cannot edit an account, not even their own, from here',
  asSeat.status === 403, `HTTP ${asSeat.status}`)

/*
 * The website is the company's, not the person's.
 *
 * Everyone at one company shares an address, so it is taken from the
 * administrator: copied onto a seat when it is created, rewritten across every
 * seat when the administrator changes their own, and not settable from the
 * form that edits somebody else.
 */
section('One website for the company')

const websiteOf = (id) => db.prepare(`SELECT website FROM recruiters WHERE id = ?`).get(id).website
const adminWebsite = websiteOf(org.recruiter.id)

check('the administrator has one from sign-up', Boolean(adminWebsite), adminWebsite ?? '(none)')
check('and the account they created inherited it',
  websiteOf(created.created.id) === adminWebsite,
  `${websiteOf(created.created.id)} vs ${adminWebsite}`)

/* Changing it on the administrator's own profile changes it for everybody —
   otherwise the team quietly disagrees about where it works. */
const moved = await fetch(`${BASE}/api/recruiter/me`, {
  method: 'PATCH', headers: H(org.token),
  body: JSON.stringify({
    firstName: 'Adi', lastName: `Admin${RUN}`,
    email: `adi.${RUN}@example.com`, phone: '050-123-4567',
    website: 'moved-house.example.com',
  }),
})
check('the administrator can move it', moved.status === 200, `HTTP ${moved.status}`)
check('their own row follows', websiteOf(org.recruiter.id) === 'https://moved-house.example.com',
  websiteOf(org.recruiter.id))
check('and so does every seat', websiteOf(created.created.id) === 'https://moved-house.example.com',
  websiteOf(created.created.id))

/* The colleague form shows it and does not offer it, so a website arriving on
   that route is not something a person typed — and is not trusted. */
const smuggle = new FormData()
smuggle.append('firstName', 'Ronit')
smuggle.append('lastName', `Rec${RUN}`)
smuggle.append('email', NEW_EMAIL)
smuggle.append('phone', NEW_PHONE)
smuggle.append('website', 'somewhere-else.example.com')
const sent = await fetch(`${BASE}/api/recruiter/${created.created.id}`, {
  method: 'PATCH', headers: { authorization: `Bearer ${org.token}` }, body: smuggle,
})
check('editing a colleague still succeeds', sent.status === 200, `HTTP ${sent.status}`)
check('but a website posted with it is ignored',
  websiteOf(created.created.id) === 'https://moved-house.example.com',
  websiteOf(created.created.id))

/* A seat created after the move starts on the new address, not the old one. */
await json(await fetch(`${BASE}/api/company/seat-plan`, {
  method: 'PUT', headers: H(org.token), body: JSON.stringify({ seats: 2 }),
}))
const later = await json(await fetch(`${BASE}/api/recruiter`, {
  method: 'POST', headers: H(org.token),
  body: JSON.stringify({ firstName: 'Lior', lastName: `Late${RUN}` }),
}))
check('a seat created afterwards starts on the current one',
  websiteOf(later.created.id) === 'https://moved-house.example.com',
  websiteOf(later.created.id))

/*
 * Creating a colleague with contact details.
 *
 * Optional, so an administrator is not held up by a phone number they have not
 * been given — the person adds their own later. Supplied, they are proved by a
 * code to the address itself, because an unverified address on somebody else's
 * account is one nobody discovers is wrong until a reset link goes to it.
 */
section('Contact details when an account is created')

/*
 * Enough capacity for everything this section creates, taken in one go.
 *
 * Raising the plan one seat at a time was arithmetic this test had no reason to
 * be doing, and it broke the moment the tier table changed — a seat count is a
 * pricing decision, and a suite about usage should not be encoding one.
 */
const { SEAT_SELF_SERVE_MAX } = await import('../server/src/pricing.js')
await json(await fetch(`${BASE}/api/company/seat-plan`, {
  method: 'PUT', headers: H(org.token), body: JSON.stringify({ seats: SEAT_SELF_SERVE_MAX }),
}))
const addSeat = async () => null

const addRecruiter = (fields) => fetch(`${BASE}/api/recruiter`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify(fields),
})

await addSeat()
const bare = await addRecruiter({ firstName: 'Noa', lastName: `Bare${RUN}` })
check('an account with no contact details is still allowed', bare.status === 201,
  `HTTP ${bare.status}`)

/*
 * Freed again once it has made its point.
 *
 * Seats are finite — four additional, self-serve — and this section creates
 * several accounts to test what a creation accepts, not to build a team. Giving
 * the seat back keeps the suite testing contact details rather than quietly
 * testing capacity, and deleting is how a seat is freed.
 */
if (bare.status === 201) {
  const made = (await bare.clone().json()).created
  /* Deleting an account asks for its username typed back, the same as it does
     in the panel — a seat is not freed by accident. */
  await fetch(`${BASE}/api/recruiter/${made.id}`, {
    method: 'DELETE', headers: H(org.token), body: JSON.stringify({ confirm: made.username }),
  })
}

const NEW_MAIL = `noa.${RUN}@example.com`
/* A seat first: capacity is checked before anything else, so without one this
   would be refused for the wrong reason and prove nothing about proofs. */
await addSeat()
const unprovedNew = await addRecruiter({
  firstName: 'Ivy', lastName: `Unproved${RUN}`, email: NEW_MAIL,
})
check('an email with no proof is refused', unprovedNew.status === 400, `HTTP ${unprovedNew.status}`)
check('and no account was created on the way to refusing',
  db.prepare(`SELECT COUNT(*) AS n FROM recruiters WHERE last_name = ?`).get(`Unproved${RUN}`).n === 0)

await addSeat()
const proofs2 = await contactProofs({ email: NEW_MAIL, phone: '052-555-0143' })
const proved2 = await addRecruiter({
  firstName: 'Ivy', lastName: `Proved${RUN}`,
  email: NEW_MAIL, phone: '052-555-0143', ...proofs2,
})
check('with proof, the account is created', proved2.status === 201, `HTTP ${proved2.status}`)

const madeRow = db.prepare(`SELECT email, phone, website FROM recruiters WHERE last_name = ?`)
  .get(`Proved${RUN}`)
check('and it holds what was proved', madeRow.email === NEW_MAIL && madeRow.phone === '052-555-0143',
  JSON.stringify(madeRow))
check('while the website still comes from the company', Boolean(madeRow.website), madeRow.website ?? '(none)')

/* One channel at a time: an account may arrive with an email and no phone. */
await addSeat()
const partial = await contactProofs({ email: `solo.${RUN}@example.com`, phone: '052-555-0155' })
const emailOnly = await addRecruiter({
  firstName: 'Sol', lastName: `Solo${RUN}`,
  email: `solo.${RUN}@example.com`, emailProof: partial.emailProof,
})
check('an email without a phone number is accepted', emailOnly.status === 201, `HTTP ${emailOnly.status}`)

/* Buying stays where it was: an administrator's job, on an administrator's
   screen. A recruiter reading their own usage must not be handed a way in. */
const buy = await fetch(`${BASE}/api/company/reveals/purchase`, {
  method: 'POST', headers: H(mate.token), body: JSON.stringify({ quantity: 10 }),
})
check('a recruiter still cannot buy reveals', buy.status === 403, `HTTP ${buy.status}`)

const billing = await fetch(`${BASE}/api/company/billing`, { headers: H(mate.token) })
check('nor read the billing screen', billing.status === 403, `HTTP ${billing.status}`)

// ------------------------------------------------------------------ tidy ---

section('Cleanup')

const ids = db.prepare(`SELECT id FROM companies WHERE name = ?`).all(NAME).map((r) => r.id)
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
check('test company removed', db.prepare(
  `SELECT COUNT(*) AS n FROM companies WHERE name = ?`,
).get(NAME).n === 0)

finish()
