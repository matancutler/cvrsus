/**
 * Capacity and allowance — the accounting behind the Usage screen.
 *
 * Every example in the specification, walked in order. This suite talks to the
 * wallet module rather than to HTTP: the arithmetic is the thing being checked,
 * and a route is a slower way of asking the same question with a session in the
 * way.
 *
 * Its fixtures are companies and recruiters it creates itself, named with this
 * run's marker, and it removes exactly those at the end.
 */
import db from '../server/src/db.js'
import {
  applyEqualSplit,
  capacitySince,
  creditReveals,
  creditTriages,
  distributeNewCapacity,
  equalShares,
  revealAllocations,
  seatList,
  setSplitEqually,
  splitsEqually,
  triageAllocations,
} from '../server/src/wallet.js'
import { createReporter } from './helpers.mjs'

const { section, check, finish } = createReporter('Usage — capacity and allowance')
const RUN = Date.now().toString(36)
const MARK = `cking-usage-${RUN}`

/* ------------------------------------------------------------ fixtures --- */

let companySeq = 0
function makeCompany(name) {
  const now = new Date().toISOString()
  companySeq += 1
  /* The key is unique-constrained and short; the run plus a counter is enough
     to keep two fixtures in the same run from colliding. */
  const key = `${MARK}-${companySeq}`.toUpperCase()
  return db.prepare(`
    INSERT INTO companies (name, join_key, created_at, approval_status, seat_plan_since)
    VALUES (?, ?, ?, 'approved', ?)
  `).run(`${MARK}-${name}`, key, now, now).lastInsertRowid
}

let seatSeq = 0
function makeSeat(companyId, first, { admin = false } = {}) {
  seatSeq += 1
  const now = new Date().toISOString()
  return db.prepare(`
    INSERT INTO recruiters (company_id, username, first_name, last_name, is_org_admin,
                            is_active, created_at, password_hash)
    VALUES (?, ?, ?, 'Seat', ?, 1, ?, 'x')
  `).run(companyId, `${MARK}.${first}.${seatSeq}`.toLowerCase(), first, admin ? 1 : 0, now)
    .lastInsertRowid
}

/** Reveal balances, by seat name, as the allowance table would show them. */
const leftBySeat = (rows) => Object.fromEntries(rows.seats.map((s) => [s.name.split(' ')[0], s.remaining]))

/* ------------------------------------------------- §3 the capacity bar --- */

section('The bar measures the capacity you have now, not the capacity you ever had')

const capCo = makeCompany('capacity')
makeSeat(capCo, 'Admin', { admin: true })

creditReveals({ companyId: capCo, quantity: 10, event: 'grant', amount: null, packKey: null, provider: null, providerRef: null, actorId: null })
let cap = capacitySince(capCo, 'reveal')
check('ten reveals in, and the bar is empty',
  cap.baseline === 10 && cap.consumed === 0 && cap.left === 10 && cap.share === 0,
  JSON.stringify(cap))

/* Spending is a ledger row like any other; the suite writes them the way the
   reveal path does rather than reaching for a private helper. */
const spend = (companyId, product, n, column) => {
  db.prepare(`UPDATE companies SET ${column} = ${column} - ? WHERE id = ?`).run(n, companyId)
  db.prepare(`
    INSERT INTO billing_ledger (company_id, product, event, delta, created_at)
    VALUES (?, ?, 'consume', ?, ?)
  `).run(companyId, product, -n, new Date().toISOString())
}

spend(capCo, 'reveal', 2, 'reveal_balance')
cap = capacitySince(capCo, 'reveal')
check('two spent reads as a fifth of ten, with eight left',
  cap.consumed === 2 && cap.left === 8 && Math.round(cap.share * 100) === 20,
  JSON.stringify(cap))

creditReveals({ companyId: capCo, quantity: 25, event: 'purchase', amount: null, packKey: null, provider: null, providerRef: null, actorId: null })
cap = capacitySince(capCo, 'reveal')
check('buying twenty-five keeps the eight and empties the bar',
  cap.left === 33 && cap.baseline === 33 && cap.consumed === 0 && cap.share === 0,
  JSON.stringify(cap))

spend(capCo, 'reveal', 4, 'reveal_balance')
cap = capacitySince(capCo, 'reveal')
check('and four more is twelve per cent of the new baseline, not of the old one',
  cap.left === 29 && Math.round(cap.share * 100) === 12,
  JSON.stringify(cap))

/*
 * The distinction the whole design turns on. Lifetime usage over lifetime
 * purchases would read 6 of 35 here and creep towards full for ever; the bar
 * has to answer "how far through the capacity we hold", which resets.
 */
check('lifetime consumption is not what the bar shows',
  cap.consumed === 4,
  'six reveals have been spent in total; four since the last purchase')

section('A refund is not a purchase')

db.prepare(`
  INSERT INTO billing_ledger (company_id, product, event, delta, created_at)
  VALUES (?, 'reveal', 'refund', 2, ?)
`).run(capCo, new Date().toISOString())
cap = capacitySince(capCo, 'reveal')
check('it gives the credits back without emptying the bar',
  cap.baseline === 33 && cap.consumed === 4,
  'a Triage handing back CVs it could not read must not read as a fresh pack')

/* ------------------------------------------- §8 splitting, and history --- */

section('Split equally divides what is bought, and preserves what was spent')

const splitCo = makeCompany('split')
const admin = makeSeat(splitCo, 'Admin', { admin: true })
const userA = makeSeat(splitCo, 'Ada')

check('it is on before anybody asks', splitsEqually(splitCo, 'reveal'),
  'an organization that has never thought about allowances still has to be able to work')

creditReveals({ companyId: splitCo, quantity: 10, event: 'grant', amount: null, packKey: null, provider: null, providerRef: null, actorId: null })
check('ten across two seats is five each',
  JSON.stringify(leftBySeat(revealAllocations(splitCo))) === JSON.stringify({ Admin: 5, Ada: 5 }),
  JSON.stringify(leftBySeat(revealAllocations(splitCo))))

/* Ada spends two. Consumption is attributed to whoever spent it. */
db.prepare(`UPDATE recruiters SET allocation_used = allocation_used + 2 WHERE id = ?`).run(userA)
spend(splitCo, 'reveal', 2, 'reveal_balance')
check('and after Ada spends two, she has three of her five',
  leftBySeat(revealAllocations(splitCo)).Ada === 3)

creditReveals({ companyId: splitCo, quantity: 50, event: 'purchase', amount: null, packKey: null, provider: null, providerRef: null, actorId: null })
const afterBuy = leftBySeat(revealAllocations(splitCo))
check('fifty more is twenty-five each, added to what each already had',
  afterBuy.Ada === 28 && afterBuy.Admin === 30, JSON.stringify(afterBuy))
check('so buying does not quietly forgive the two Ada spent',
  afterBuy.Ada !== afterBuy.Admin,
  'levelling the remainders on every purchase would erase the record of who spent what')

/* --------------------------------------------- §10 the odd one out ------- */

section('What will not divide goes to the admin')

for (const [amount, seats, expected] of [
  [25, 3, [9, 8, 8]],
  [10, 3, [4, 3, 3]],
  [50, 4, [14, 12, 12, 12]],
  [100, 3, [34, 33, 33]],
]) {
  const co = makeCompany(`share-${amount}-${seats}`)
  makeSeat(co, 'Admin', { admin: true })
  for (let i = 1; i < seats; i += 1) makeSeat(co, `Seat${i}`)

  const shares = equalShares(co, amount).map((seat) => seat.share)
  check(`${amount} across ${seats} seats is ${expected.join(', ')}`,
    JSON.stringify(shares) === JSON.stringify(expected), JSON.stringify(shares))
  check(`  and none of ${amount} goes missing`,
    shares.reduce((a, b) => a + b, 0) === amount)
  check('  in whole credits',
    shares.every((share) => Number.isInteger(share)),
    'there is no such thing as a third of a reveal')
}

section('The admin is a seat in the denominator, not an exception to it')

const denomCo = makeCompany('denominator')
makeSeat(denomCo, 'Admin', { admin: true })
makeSeat(denomCo, 'Bea')
makeSeat(denomCo, 'Cai')
makeSeat(denomCo, 'Dee')
check('four people including the admin divides by four',
  equalShares(denomCo, 40).every((seat) => seat.share === 10),
  JSON.stringify(equalShares(denomCo, 40).map((s) => s.share)))

/* ------------------------------------------------ §9 independence -------- */

section('Reveals and Triage are two separate accounts')

const indCo = makeCompany('independent')
const indAdmin = makeSeat(indCo, 'Admin', { admin: true })
makeSeat(indCo, 'Eve')

setSplitEqually({ companyId: indCo, product: 'triage', enabled: false })
check('one switch can be off while the other is on',
  splitsEqually(indCo, 'reveal') && !splitsEqually(indCo, 'triage'))

creditTriages({ companyId: indCo, quantity: 100 })
check('so a Triage purchase with splitting off allocates nothing',
  triageAllocations(indCo).seats.every((seat) => seat.allowance === null || seat.allowance === 0),
  JSON.stringify(triageAllocations(indCo).seats.map((s) => s.allowance)))

creditReveals({ companyId: indCo, quantity: 10, event: 'purchase', amount: null, packKey: null, provider: null, providerRef: null, actorId: null })
check('while the reveal purchase beside it is split',
  JSON.stringify(leftBySeat(revealAllocations(indCo))) === JSON.stringify({ Admin: 5, Eve: 5 }),
  JSON.stringify(leftBySeat(revealAllocations(indCo))))
check('and buying reveals moved no Triage capacity',
  triageAllocations(indCo).balance === 100)

setSplitEqually({ companyId: indCo, product: 'triage', enabled: true })
const triageNow = Object.fromEntries(
  triageAllocations(indCo).seats.map((s) => [s.name.split(' ')[0], s.remaining]))
check('turning Triage splitting on levels Triage and leaves reveals alone',
  triageNow.Admin === 50 && triageNow.Eve === 50
  && JSON.stringify(leftBySeat(revealAllocations(indCo))) === JSON.stringify({ Admin: 5, Eve: 5 }),
  JSON.stringify(triageNow))

section('Turning it on keeps consumption, it does not refund it')

db.prepare(`UPDATE recruiters SET triage_used = triage_used + 20 WHERE id = ?`).run(indAdmin)
spend(indCo, 'triage', 20, 'triage_cv_balance')
applyEqualSplit(indCo, 'triage')
const afterSplit = Object.fromEntries(
  triageAllocations(indCo).seats.map((s) => [s.name.split(' ')[0], { left: s.remaining, used: s.used }]))
check('the twenty already processed are still recorded against the admin',
  afterSplit.Admin.used === 20, JSON.stringify(afterSplit))
check('and the eighty that are left are shared forty each',
  afterSplit.Admin.left === 40 && afterSplit.Eve.left === 40, JSON.stringify(afterSplit))
check('so allowances never promise more than the organization holds',
  afterSplit.Admin.left + afterSplit.Eve.left === triageAllocations(indCo).balance,
  'an allowance is permission to spend capacity, and cannot conjure any')

/* ------------------------------------------------------ §5 the seats ---- */

section('Seats are a subscription, listed rather than metered')

const rows = seatList(indCo)
check('one row per seat', rows.length === 2, `${rows.length}`)
check('the admin is named as such', rows[0].isAdmin === true)
check('and the seat the plan includes is marked, not billed',
  rows[0].included === true && rows[0].renewsAt === null,
  JSON.stringify(rows[0]))
check('while a subscribed seat carries the date it renews on',
  rows[1].included === false && Boolean(rows[1].renewsAt),
  JSON.stringify(rows[1]))
check('and that date is sent once, not twice under two names',
  rows.every((seat) => !('nextCharge' in seat)),
  'a second column fed from the same value can only ever repeat the first')
check('each seat says when it started',
  rows.every((seat) => Boolean(seat.since)))
check('and none of them reports a percentage',
  rows.every((seat) => !('share' in seat) && !('percent' in seat)),
  'a seat is not consumed, so there is no fraction of one to be used up')

/* --------------------------------------------------------- §12 sanity --- */

section('Capacity is the source of truth; allowance only says who may spend it')

const capCheck = capacitySince(indCo, 'triage')
check('the organization holds what the ledger says it holds',
  capCheck.left === triageAllocations(indCo).balance, `${capCheck.left}`)
check('and the shares add up to exactly that, never past it',
  triageAllocations(indCo).seats.reduce((sum, s) => sum + (s.remaining ?? 0), 0) === capCheck.left)

/* ------------------------------------------------------------ cleanup --- */

section('Cleanup')

const mine = db.prepare(`SELECT id, name FROM companies WHERE name LIKE ?`).all(`${MARK}-%`)
for (const row of mine) {
  if (!row.name.startsWith(MARK)) throw new Error(`refusing to remove ${row.id}: not this run's`)
  db.prepare(`DELETE FROM billing_ledger WHERE company_id = ?`).run(row.id)
  db.prepare(`DELETE FROM recruiters WHERE company_id = ?`).run(row.id)
  db.prepare(`DELETE FROM companies WHERE id = ?`).run(row.id)
}
check('fixtures removed', true, `${mine.length} companies`)

finish()
