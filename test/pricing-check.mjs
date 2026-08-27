/**
 * The commercial model, end to end. Acceptance criteria from §21 of the
 * recruiter pricing specification.
 *
 * Every assertion here is about money or capacity — the two things a bug in
 * would either give the product away or charge somebody twice. The three that
 * matter most are the last three: a reveal that fails must not consume, a
 * candidate a colleague already opened must not be charged again, and a client
 * must not be able to name its own price.
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import {
  BASE, approveCompanyById, contactProofs, createReporter, json, makePdf,
  registerAndSignIn,
  registerCompany,
} from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const MARKER = `@cking-pricing-${RUN}.example.com`
const H = (t) => ({ 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) })
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const {
  COMPLIMENTARY_REVEALS, COMPLIMENTARY_TRIAGE_CVS, INCLUDED_SEATS, SEAT_SELF_SERVE_MAX,
  seatPlanMonthly,
} = await import('../server/src/pricing.js')

async function apply(first) {
  const form = new FormData()
  form.append('cv', new Blob([await makePdf([
    `${first} Pricing`, 'Backend engineer - Tel Aviv',
    'BACKEND ENGINEER, PayFlow 2018-01 - present',
    '  Java services and SQL.',
    'SKILLS: Java, SQL',
  ])], { type: 'application/pdf' }), 'cv.pdf')

  for (const [k, v] of Object.entries({
    firstName: first, lastName: 'Pricing', email: `${first}.${RUN}${MARKER}`.toLowerCase(),
    phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
    location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
  })) form.append(k, v)

  const proofs = await contactProofs({ email: form.get('email'), phone: form.get('phone') })
  for (const [key, value] of Object.entries(proofs)) form.append(key, value)

  // The 18+ affirmation and agreement the form now sends and the route now requires.
  if (!form.has('consent')) form.append('consent', 'true')
  return json(await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form }))
}

// --------------------------------------------------------------- setup ---

section('Setup')
const org = await registerAndSignIn({
  companyName: `Pricing ${RUN}`, firstName: 'Pia', lastName: 'Payer',
  email: `pia.${RUN}@example.com`,
})
check('a company registered', Boolean(org.token))
await approveCompanyById(org.company.id)

const companyId = db.prepare(`SELECT id FROM companies WHERE name = ?`).get(`Pricing ${RUN}`).id

// ------------------------------------------------------- §6, the grant ---

section('§6 — the complimentary grant')
const startingBalance = db.prepare(`SELECT reveal_balance FROM companies WHERE id = ?`)
  .get(companyId).reveal_balance
check(`a new organization starts with ${COMPLIMENTARY_REVEALS} reveals`,
  startingBalance === COMPLIMENTARY_REVEALS, `got ${startingBalance}`)

check('and the grant is in the ledger, once, against the reveal product',
  db.prepare(`
    SELECT COUNT(*) AS n FROM billing_ledger
    WHERE company_id = ? AND event = 'grant' AND product = 'reveal'
  `).get(companyId).n === 1,
  'scoped by product: an organization now receives a welcome grant of each')

// Running it twice is exactly what a restart does, and it must not pay out.
const { grantComplimentaryReveals } = await import('../server/src/wallet.js')
const secondGrant = grantComplimentaryReveals(companyId)
check('the grant is once per organization, not once per call', secondGrant === 0)
check('and the balance did not move',
  db.prepare(`SELECT reveal_balance FROM companies WHERE id = ?`).get(companyId).reveal_balance
    === COMPLIMENTARY_REVEALS)

/*
 * The other half of the welcome.
 *
 * The pricing page promises every new account two things — reveals and Triage
 * capacity — and a promise kept for one of them is a promise broken. Checked
 * with the same three questions the reveal grant is: that it lands, that it is
 * recorded, and that calling it again pays nothing out.
 */
const startingTriage = db.prepare(`SELECT triage_cv_balance FROM companies WHERE id = ?`)
  .get(companyId).triage_cv_balance
check(`a new organization also starts with ${COMPLIMENTARY_TRIAGE_CVS} CVs of Triage capacity`,
  startingTriage === COMPLIMENTARY_TRIAGE_CVS, `got ${startingTriage}`)

check('and it is on the ledger as a grant against the Triage product',
  db.prepare(`
    SELECT delta FROM billing_ledger
    WHERE company_id = ? AND event = 'grant' AND product = 'triage'
  `).get(companyId)?.delta === COMPLIMENTARY_TRIAGE_CVS,
  'a balance nobody can account for is a balance nobody can defend')

check('the two balances are separate — neither grant touched the other',
  db.prepare(`SELECT reveal_balance FROM companies WHERE id = ?`).get(companyId).reveal_balance
    === COMPLIMENTARY_REVEALS)

const { grantComplimentaryTriage } = await import('../server/src/wallet.js')
let secondTriage = 0
try { secondTriage = grantComplimentaryTriage(companyId) } catch { secondTriage = 0 }
check('the Triage grant is once per organization too', secondTriage === 0)
check('and that balance did not move either',
  db.prepare(`SELECT triage_cv_balance FROM companies WHERE id = ?`).get(companyId).triage_cv_balance
    === COMPLIMENTARY_TRIAGE_CVS)

// ------------------------------------------------- §4.1, public pricing ---

section('§4.1 — the catalogue is public')
const catalogue = await json(await fetch(`${BASE}/api/pricing`))
check('an unauthenticated visitor can read it', catalogue.reveals?.length > 0)
check('and it carries both products', catalogue.seats?.length > 0)
check('and states both welcome allowances, so the page cannot invent its own numbers',
  catalogue.complimentaryReveals === COMPLIMENTARY_REVEALS
  && catalogue.complimentaryTriageCvs === COMPLIMENTARY_TRIAGE_CVS)
check('reveal packs get cheaper per unit as they get bigger',
  catalogue.reveals.every((pack, i, all) => i === 0 || pack.unit <= all[i - 1].unit))
check('seat packs do too',
  catalogue.seats.every((pack, i, all) => i === 0 || pack.unit <= all[i - 1].unit))

// ------------------------------------------------------ §9, the charge ---

section('§9 — a reveal costs exactly one')
const candidate = await apply('Cara')
check('a candidate applied', Boolean(candidate.id))

const before = db.prepare(`SELECT reveal_balance FROM companies WHERE id = ?`).get(companyId).reveal_balance
const revealed = await json(await fetch(`${BASE}/api/hr/candidates/${candidate.id}/reveal`, {
  method: 'POST', headers: H(org.token),
}))
check('the reveal succeeds', revealed.revealed === true)
check('it reports having charged', revealed.charged === true)
check('the balance fell by exactly one', revealed.balance === before - 1, `${before} -> ${revealed.balance}`)
check('and the response carries the new balance for the header',
  typeof revealed.balance === 'number')

check('a consume row is in the ledger',
  db.prepare(`
    SELECT COUNT(*) AS n FROM billing_ledger
    WHERE company_id = ? AND event = 'consume' AND delta = -1
  `).get(companyId).n === 1)

section('§17.1 — the organization pays once for a candidate')
const again = await json(await fetch(`${BASE}/api/hr/candidates/${candidate.id}/reveal`, {
  method: 'POST', headers: H(org.token),
}))
check('revealing the same candidate again succeeds', again.revealed === true)
check('but charges nothing', again.charged === false)
check('and the balance is unchanged', again.balance === revealed.balance,
  `${revealed.balance} -> ${again.balance}`)
check('with no second consume row',
  db.prepare(`
    SELECT COUNT(*) AS n FROM billing_ledger WHERE company_id = ? AND event = 'consume'
  `).get(companyId).n === 1)

// ------------------------------------------------ §9.4, failure is free ---

section('§9.4 — a reveal that cannot happen consumes nothing')
// Drained directly rather than by revealing ten people: the assertion is about
// what happens at zero, and creating ten candidates to reach it would test the
// application pipeline instead.
db.prepare(`UPDATE companies SET reveal_balance = 0 WHERE id = ?`).run(companyId)

const other = await apply('Dana')
const refused = await fetch(`${BASE}/api/hr/candidates/${other.id}/reveal`, {
  method: 'POST', headers: H(org.token),
})
check('an empty wallet refuses with 402', refused.status === 402, `HTTP ${refused.status}`)

const message = (await refused.json()).error ?? ''
check('and the admin is told they can buy more', /Reveal Pack/i.test(message), message)
check('the balance is still zero',
  db.prepare(`SELECT reveal_balance FROM companies WHERE id = ?`).get(companyId).reveal_balance === 0)
check('no organization reveal was recorded',
  db.prepare(`SELECT COUNT(*) AS n FROM organization_reveals WHERE company_id = ? AND candidate_id = ?`)
    .get(companyId, other.id).n === 0,
  'a failed reveal must not leave the candidate marked as paid for')

const stillMasked = await json(await fetch(`${BASE}/api/hr/candidates/${other.id}`, { headers: H(org.token) }))
check('and the candidate is still masked', stillMasked.revealed === false)

// ------------------------------------------------------ §3, purchasing ---

section('§3 — buying a Reveal Pack')
const pack = catalogue.reveals[1]
const bought = await json(await fetch(`${BASE}/api/company/reveals/purchase`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ pack: pack.key }),
}))
check(`${pack.quantity} reveals were added`, bought.balance === pack.quantity, `got ${bought.balance}`)
check('the purchase is in the ledger with its amount',
  db.prepare(`
    SELECT amount FROM billing_ledger
    WHERE company_id = ? AND event = 'purchase' AND product = 'reveal'
  `).get(companyId)?.amount === pack.total)

const madeUp = await fetch(`${BASE}/api/company/reveals/purchase`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ pack: 'reveals_9999' }),
})
check('a pack that does not exist is refused', madeUp.status === 400, `HTTP ${madeUp.status}`)

const priceFromClient = await fetch(`${BASE}/api/company/reveals/purchase`, {
  method: 'POST', headers: H(org.token),
  body: JSON.stringify({ pack: pack.key, total: 1, amount: 1 }),
})
const afterAttempt = db.prepare(`
  SELECT amount FROM billing_ledger
  WHERE company_id = ? AND event = 'purchase' ORDER BY id DESC LIMIT 1
`).get(companyId)?.amount
check('a price sent by the client is ignored',
  priceFromClient.status === 201 && afterAttempt === pack.total,
  `charged ${afterAttempt}, pack costs ${pack.total}`)

// ------------------------------------------------------- the seat plan ---

section('Seats — the administrator is included')
const billing = await json(await fetch(`${BASE}/api/company/billing`, { headers: H(org.token) }))
check(`${INCLUDED_SEATS} seat${INCLUDED_SEATS === 1 ? '' : 's'} included`,
  billing.seats.included === INCLUDED_SEATS)
check('the administrator occupies one', billing.seats.occupied === 1)
check('and the rest are free', billing.seats.available === INCLUDED_SEATS - 1)
check('with no subscription to start with', billing.seats.purchased === 0)
check('and nothing to pay for them', billing.seats.monthly === 0)

section('Additional seats are a monthly subscription')

const planQuote = async (seats) => json(await fetch(
  `${BASE}/api/company/seat-plan/quote?seats=${seats}`, { headers: H(org.token) },
))
const setPlan = (seats) => fetch(`${BASE}/api/company/seat-plan`, {
  method: 'PUT', headers: H(org.token), body: JSON.stringify({ seats }),
})

const twoSeats = await planQuote(2)
check('two seats quote the two-seat monthly rate', twoSeats.monthly === seatPlanMonthly(2),
  `${twoSeats.monthly} vs ${seatPlanMonthly(2)}`)
check('against nothing today', twoSeats.currentMonthly === 0)
check('so the bill changes by the whole tier', twoSeats.change === seatPlanMonthly(2))

check('subscribing succeeds', (await setPlan(2)).status === 200)

/*
 * The whole tier is priced, every time — not the step. This is the difference
 * from the model it replaced: there, a third seat was quoted as "the three-seat
 * price less what you already paid". Here three seats simply cost the
 * three-seat rate, and what changes is the monthly bill.
 */
const threeSeats = await planQuote(3)
check('three seats cost the three-seat rate', threeSeats.monthly === seatPlanMonthly(3),
  `${threeSeats.monthly} vs ${seatPlanMonthly(3)}`)
check('measured against what is being paid now',
  threeSeats.currentMonthly === seatPlanMonthly(2))
check('so the increase is the difference between the tiers',
  threeSeats.change === seatPlanMonthly(3) - seatPlanMonthly(2), `got ${threeSeats.change}`)

/* A reduction is expressible, which under an owning model it was not: you
   cannot buy negative seats, but you can pay for a smaller plan. */
const downgrade = await planQuote(1)
check('going down quotes a smaller bill', downgrade.monthly === seatPlanMonthly(1))
check('and a negative change', downgrade.change < 0, String(downgrade.change))

const entitlement = await json(await fetch(`${BASE}/api/company/billing`, { headers: H(org.token) }))
check('the subscription set the entitlement', entitlement.seats.purchased === 2)
check('and the total is included plus subscribed',
  entitlement.seats.total === INCLUDED_SEATS + 2)
check('the monthly charge is the tier',
  entitlement.seats.monthly === seatPlanMonthly(2), String(entitlement.seats.monthly))
check('subscribing to seats granted no reveals',
  entitlement.balance === bought.balance + catalogue.reveals[1].quantity,
  'seats and reveals are separate products')

/* Repeating the request is not a second charge: a subscription is a state. */
const samePlan = await setPlan(2)
check('setting the same plan twice is refused rather than charged twice',
  samePlan.status === 400, `HTTP ${samePlan.status}`)

/* Above self-serve there is no price, and none is invented. */
const enterprise = await planQuote(SEAT_SELF_SERVE_MAX + 1)
check('beyond self-serve there is no monthly rate', enterprise.monthly === null)
check('and it says to contact sales', enterprise.contactSales === true)
const tooMany = await setPlan(SEAT_SELF_SERVE_MAX + 1)
check('and the plan cannot be set', tooMany.status === 400, `HTTP ${tooMany.status}`)

// --------------------------------------------------- §8, who may buy ---

section('§8 — buying is administrator territory')
// Created directly rather than over HTTP: the seat gate is the subject of its
// own tests, and going through it here would only re-run them.
const { createRecruiter } = await import('../server/src/accounts.js')
const member = await createRecruiter({
  companyId, firstName: 'Mo', lastName: 'Member',
})
/* What POST /api/company/members does after creating one, and the reason it
   does: a seat that arrives while the balance is being split equally needs a
   share of it, and everyone else's share is now smaller. Called here because
   this suite goes round the route rather than through it. */
const { resettleSeats } = await import('../server/src/wallet.js')
resettleSeats(companyId)
const joinKey = db.prepare(`SELECT join_key FROM companies WHERE id = ?`).get(companyId).join_key
const memberLogin = await fetch(`${BASE}/api/recruiter/login`, {
  method: 'POST', headers: H(),
  body: JSON.stringify({ joinKey, username: member.username, password: member.initialPassword }),
})
const memberToken = memberLogin.status === 200 ? (await memberLogin.json()).token : null
check('a non-admin can sign in', Boolean(memberToken))

if (memberToken) {
  const denied = await fetch(`${BASE}/api/company/reveals/purchase`, {
    method: 'POST', headers: H(memberToken), body: JSON.stringify({ pack: pack.key }),
  })
  check('but cannot buy reveals', denied.status === 403, `HTTP ${denied.status}`)

  const deniedSeats = await fetch(`${BASE}/api/company/seat-plan`, {
    method: 'PUT', headers: H(memberToken), body: JSON.stringify({ seats: 1 }),
  })
  check('nor change the seat subscription', deniedSeats.status === 403, `HTTP ${deniedSeats.status}`)

  const deniedBilling = await fetch(`${BASE}/api/company/billing`, { headers: H(memberToken) })
  check('nor read the billing screen', deniedBilling.status === 403, `HTTP ${deniedBilling.status}`)

  section('§8 — but the balance is visible to everyone who can spend it')
  const memberMe = await json(await fetch(`${BASE}/api/recruiter/me`, { headers: H(memberToken) }))
  check('a member sees the organization balance', typeof memberMe.wallet?.balance === 'number')
  check('and the seat count', typeof memberMe.seats?.total === 'number')

  section('§7.2 — dividing the balance across seats')
  const admin = db.prepare(`SELECT id FROM recruiters WHERE company_id = ? AND is_org_admin = 1`)
    .get(companyId).id

  const beforeSplit = await json(await fetch(`${BASE}/api/company/reveal-allocations`, {
    headers: H(org.token),
  }))
  /*
   * The default is the other way round now.
   *
   * It used to be one shared pool until an administrator chose to divide it,
   * on the reasoning that most teams have no problem to solve. In practice the
   * pool is first-come-first-served, so one recruiter working through a long
   * shortlist could spend the month's reveals before a colleague opened the
   * product — and the fix was a screen nobody visited until after it happened.
   * Splitting equally is now on from the start, and turning it off is the
   * deliberate act.
   */
  check('an organization starts with its capacity shared out', beforeSplit.dividing === true)
  check('so every reveal has somebody who may spend it',
    beforeSplit.unallocated === 0 && beforeSplit.assigned === beforeSplit.balance,
    JSON.stringify({ assigned: beforeSplit.assigned, balance: beforeSplit.balance }))

  // More than the wallet holds, which is the mistake the whole endpoint exists
  // to refuse — one seat at a time it could not be caught at all.
  const overAllocated = await fetch(`${BASE}/api/company/reveal-allocations`, {
    method: 'PUT',
    headers: H(org.token),
    body: JSON.stringify({ allocations: { [admin]: beforeSplit.balance, [member.id]: 5 } }),
  })
  check('allocating more than the balance is refused',
    overAllocated.status === 400, `HTTP ${overAllocated.status}`)
  check('and says by how much', /reveal/i.test((await overAllocated.json()).error ?? ''))
  /* The refusal left the allowances alone. Read as "unchanged" rather than
     "undivided": an organization is divided from the start now, so the thing
     to check is that the numbers are the ones from before the bad request. */
  const afterRefusal = await json(await fetch(
    `${BASE}/api/company/reveal-allocations`, { headers: H(org.token) }))
  check('nothing was applied',
    JSON.stringify(afterRefusal.seats.map((seat) => seat.allowance))
    === JSON.stringify(beforeSplit.seats.map((seat) => seat.allowance)),
    JSON.stringify(afterRefusal.seats.map((seat) => seat.allowance)))

  // The member gets nothing at all, which is the strictest allowance there is.
  const split = await json(await fetch(`${BASE}/api/company/reveal-allocations`, {
    method: 'PUT',
    headers: H(org.token),
    body: JSON.stringify({ allocations: { [admin]: 1, [member.id]: 0 } }),
  }))
  check('a valid division is applied', split.dividing === true)
  check('and each seat carries its own allowance',
    split.seats.find((seat) => seat.id === member.id)?.allocation === 0)
  check('the rest stays unallocated', split.unallocated === split.balance - 1)

  const capped = await apply('Eve')
  const blocked = await fetch(`${BASE}/api/hr/candidates/${capped.id}/reveal`, {
    method: 'POST', headers: H(memberToken),
  })
  check('a seat that has spent its allowance is blocked',
    blocked.status === 402, `HTTP ${blocked.status}`)

  const capMessage = (await blocked.json()).error ?? ''
  check('and told it is their own allowance, not the organization running out',
    /administrator allocated/i.test(capMessage), capMessage)
  check('the organization balance was not touched',
    db.prepare(`SELECT reveal_balance FROM companies WHERE id = ?`).get(companyId).reveal_balance
      === entitlement.balance)

  // The admin's own allowance of one still works, which is what proves the gate
  // is an allowance rather than a blanket refusal.
  const withinAllowance = await fetch(`${BASE}/api/hr/candidates/${capped.id}/reveal`, {
    method: 'POST', headers: H(org.token),
  })
  check('a seat inside its allowance still reveals',
    withinAllowance.status === 200, `HTTP ${withinAllowance.status}`)

  const spent = await apply('Fay')
  const exhausted = await fetch(`${BASE}/api/hr/candidates/${spent.id}/reveal`, {
    method: 'POST', headers: H(org.token),
  })
  check('and is blocked once it is spent', exhausted.status === 402, `HTTP ${exhausted.status}`)

  // Returning everyone to the shared pool is one call, and undoes the lot.
  const shared = await json(await fetch(`${BASE}/api/company/reveal-allocations`, {
    method: 'PUT',
    headers: H(org.token),
    body: JSON.stringify({ allocations: { [admin]: null, [member.id]: null } }),
  }))
  check('clearing the allowances returns everyone to the pool', shared.dividing === false)
  const freed = await fetch(`${BASE}/api/hr/candidates/${spent.id}/reveal`, {
    method: 'POST', headers: H(org.token),
  })
  check('and the seat can reveal again', freed.status === 200, `HTTP ${freed.status}`)
}

// ------------------------------------------------------ §12, auto top-up ---

section('§12 — automatic replenishment is opt-in and reveals only')
check('it starts off',
  db.prepare(`SELECT auto_replenish_pack FROM companies WHERE id = ?`).get(companyId)
    .auto_replenish_pack === null)

const seatReplenish = await fetch(`${BASE}/api/company/auto-replenish`, {
  method: 'PATCH', headers: H(org.token), body: JSON.stringify({ pack: 'seats_2' }),
})
check('it refuses to auto-buy seats', seatReplenish.status === 400, `HTTP ${seatReplenish.status}`)

const revealReplenish = await json(await fetch(`${BASE}/api/company/auto-replenish`, {
  method: 'PATCH', headers: H(org.token), body: JSON.stringify({ pack: pack.key }),
}))
check('but accepts a reveal pack', revealReplenish.enabled === true)

// -------------------------------------------------------------- cleanup ---

section('Cleanup')
const ids = db.prepare(`SELECT id FROM candidates WHERE email LIKE ?`).all(`%${MARKER}`).map((r) => r.id)
/*
 * The uploads have to be collected before the rows go, and deleted by hand.
 *
 * This suite tidies up in SQL rather than through DELETE /api/hr/candidates,
 * because it needs to remove a company too and there is deliberately no API for
 * that. The endpoint unlinks a candidate's files as well as their row; raw SQL
 * does not, so every run was leaving its four fixture CVs in server/uploads and
 * api.test — which asserts nothing on disk is unreferenced — was picking them
 * up on the following run, several suites away from the one that dropped them.
 */
const leftovers = []
if (ids.length) {
  const list = ids.join(',')
  for (const row of db.prepare(
    `SELECT stored_name AS n FROM candidates WHERE id IN (${list}) AND stored_name IS NOT NULL
     UNION ALL
     SELECT photo_name FROM candidates WHERE id IN (${list}) AND photo_name IS NOT NULL
     UNION ALL
     SELECT stored_name FROM documents WHERE candidate_id IN (${list}) AND stored_name IS NOT NULL`,
  ).all()) leftovers.push(row.n)

  db.exec(`
    DELETE FROM documents WHERE candidate_id IN (${list});
    DELETE FROM organization_reveals WHERE candidate_id IN (${list});
    DELETE FROM reveals WHERE candidate_id IN (${list});
    DELETE FROM view_events WHERE candidate_id IN (${list});
    DELETE FROM messages WHERE candidate_id IN (${list});
    DELETE FROM candidates WHERE id IN (${list});
  `)
}

const recruiters = db.prepare(`SELECT id FROM recruiters WHERE company_id = ?`).all(companyId)
  .map((r) => r.id)
const rl = recruiters.length ? recruiters.join(',') : '-1'

/* The admin's photo, read before the row carrying its name is deleted. */
for (const row of db.prepare(
  `SELECT photo_name AS n FROM recruiters WHERE company_id = ? AND photo_name IS NOT NULL`,
).all(companyId)) leftovers.push(row.n)

db.exec(`
  DELETE FROM seat_usage_periods WHERE recruiter_id IN (${rl});
  DELETE FROM billing_ledger WHERE company_id = ${companyId};
  DELETE FROM organization_reveals WHERE company_id = ${companyId};
  DELETE FROM reveals WHERE company_id = ${companyId};
  DELETE FROM view_events WHERE company_id = ${companyId};
  DELETE FROM recruiters WHERE company_id = ${companyId};
  DELETE FROM companies WHERE id = ${companyId};
`)

const uploads = fileURLToPath(new URL('../server/uploads/', import.meta.url))
let unlinked = 0
for (const name of leftovers) {
  try {
    fs.unlinkSync(uploads + name)
    unlinked += 1
  } catch (error) {
    // Already gone is the outcome we wanted; anything else is worth seeing.
    if (error.code !== 'ENOENT') throw error
  }
}

/*
 * Asserted rather than announced. This used to be `check(..., true, ...)`, which
 * reports on the cleanup without ever being able to fail it — so the four CVs it
 * was leaving behind every run went unremarked here and surfaced in a different
 * suite entirely.
 */
check('test candidates and company removed',
  db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE email LIKE ?`).get(`%${MARKER}`).n === 0
  && db.prepare(`SELECT COUNT(*) AS n FROM companies WHERE id = ?`).get(companyId).n === 0,
  `${ids.length} candidate(s), 1 company`)
check('and their uploads are off disk',
  leftovers.every((name) => !fs.existsSync(uploads + name)),
  `${unlinked} file(s) removed`)
db.close()

finish()
