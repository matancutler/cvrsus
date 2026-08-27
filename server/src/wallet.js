import db from './db.js'
/* Removing a seat can mean removing the person in it — through the same
   path the Team screen uses, so nothing is left half-deleted. */
import { deleteRecruiterCompletely } from './accounts.js'
import { track } from './analytics.js'
import { sendRevealsEmptyEmail, sendTriageEmptyEmail } from './notify.js'
import {
  COMPLIMENTARY_REVEALS,
  COMPLIMENTARY_TRIAGE_CVS,
  CURRENCY,
  INCLUDED_SEATS,
  SEAT_SELF_SERVE_MAX,
  TRIAGE_MAX_FILES,
  findRevealPack,
  formatAmount,
  seatPlanMonthly,
  seatPlanView,
} from './pricing.js'

/**
 * The organization reveal wallet and seat entitlements.
 *
 * Pricing §7: reveals belong to the organization, never to a seat. There is one
 * authoritative balance per company and an auditable ledger of every change to
 * it. Seats are a recurring monthly subscription: the administrator's own is
 * included, and the tier an organization holds is priced as a whole rather than
 * as a series of purchases added together.
 *
 * Both live here because §22 asks for one billing system rather than two: they
 * share this module, the ledger table and the payment seam in billing.js.
 */

/** Every ledger write goes through here, so no balance changes unrecorded. */
function writeLedger({
  companyId, product, event, delta,
  amount = null, provider = null, providerRef = null,
  actorId = null, candidateId = null, packKey = null, note = null,
}) {
  return db.prepare(`
    INSERT INTO billing_ledger (
      company_id, product, event, delta, amount, currency,
      provider, provider_ref, actor_id, candidate_id, pack_key, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    companyId, product, event, delta, amount, amount === null ? null : CURRENCY,
    provider, providerRef, actorId, candidateId, packKey, note,
    new Date().toISOString(),
  ).lastInsertRowid
}

// ------------------------------------------------------------- reveals ---

/**
 * §6 — the complimentary grant, once per organization and never per seat.
 *
 * Guarded by a timestamp column rather than by counting grants in the ledger:
 * the column makes "has this already happened" a single indexed read, and it
 * is what stops a second call — from a retry, a migration or a new seat — ever
 * granting twice.
 */
export function grantComplimentaryReveals(companyId) {
  const company = db.prepare(
    `SELECT complimentary_granted_at FROM companies WHERE id = ?`,
  ).get(companyId)

  if (!company || company.complimentary_granted_at) return 0
  if (COMPLIMENTARY_REVEALS <= 0) return 0

  return db.transaction(() => {
    db.prepare(`
      UPDATE companies
      SET reveal_balance = reveal_balance + ?, complimentary_granted_at = ?
      WHERE id = ? AND complimentary_granted_at IS NULL
    `).run(COMPLIMENTARY_REVEALS, new Date().toISOString(), companyId)

    writeLedger({
      companyId, product: 'reveal', event: 'grant',
      delta: COMPLIMENTARY_REVEALS,
      note: 'Complimentary reveals for a new organization',
    })

    /* The welcome grant is capacity like any other, so it is shared out like
       any other. It was the one credit that arrived without an allowance,
       which meant a brand-new organization with splitting on — the default —
       had a balance nobody was permitted to spend. */
    distributeNewCapacity(companyId, 'reveal', COMPLIMENTARY_REVEALS)

    return COMPLIMENTARY_REVEALS
  })()
}

/**
 * The complimentary Triage allowance, once per organization.
 *
 * A deliberate twin of grantComplimentaryReveals rather than a branch inside
 * it: the two products have separate balances by design — nothing in this file
 * lets one become the other — and folding them into one function would put the
 * only place they are granted together inside the one file whose whole job is
 * keeping them apart.
 *
 * Guarded by its own timestamp column, so a retry, a migration, a new seat or
 * a boot after this feature shipped can each call it as often as they like and
 * it happens exactly once.
 */
export function grantComplimentaryTriage(companyId) {
  const company = db.prepare(
    `SELECT triage_complimentary_granted_at FROM companies WHERE id = ?`,
  ).get(companyId)

  if (!company || company.triage_complimentary_granted_at) return 0
  if (COMPLIMENTARY_TRIAGE_CVS <= 0) return 0

  return db.transaction(() => {
    const stamped = db.prepare(`
      UPDATE companies
      SET triage_cv_balance = triage_cv_balance + ?, triage_complimentary_granted_at = ?
      WHERE id = ? AND triage_complimentary_granted_at IS NULL
    `).run(COMPLIMENTARY_TRIAGE_CVS, new Date().toISOString(), companyId).changes

    /* Somebody else granted it between the read above and here. The guard is in
       the WHERE clause rather than only in the SELECT for exactly this, and
       throwing rolls back the credit that the UPDATE did not make. */
    if (stamped === 0) throw new Error('already granted')

    writeLedger({
      companyId, product: 'triage', event: 'grant',
      delta: COMPLIMENTARY_TRIAGE_CVS,
      note: `${COMPLIMENTARY_TRIAGE_CVS} complimentary CVs of Triage capacity for a new organization`,
    })

    distributeNewCapacity(companyId, 'triage', COMPLIMENTARY_TRIAGE_CVS)

    return COMPLIMENTARY_TRIAGE_CVS
  })()
}

/**
 * The administrator is told once, on the crossing.
 *
 * "Send only when the balance transitions from above zero to zero" is easy to
 * get wrong in the obvious way — checking `balance === 0` somewhere that runs
 * often, and mailing every time somebody bumps into an empty wallet. This is
 * called only from the two places that actually spend, and only when the spend
 * succeeded: to have spent at all the balance was above zero a moment ago, so
 * reaching zero here IS the transition and nothing else can be.
 *
 * Nothing is awaited and nothing throws. A reveal that has been paid for must
 * not be undone because a mailbox was unreachable.
 */
function warnEmptied(companyId, product) {
  const admin = db.prepare(`
    SELECT first_name, email FROM recruiters
    WHERE company_id = ? AND is_active = 1
    ORDER BY is_org_admin DESC, id LIMIT 1
  `).get(companyId)

  track(`${product}_balance_emptied`, { actorType: 'company', actorId: companyId })
  if (!admin?.email) return

  const send = product === 'reveal' ? sendRevealsEmptyEmail : sendTriageEmptyEmail
  send({ to: admin.email, name: admin.first_name }).catch(() => {})
}

export function revealBalance(companyId) {
  return db.prepare(`SELECT reveal_balance FROM companies WHERE id = ?`)
    .get(companyId)?.reveal_balance ?? 0
}

/** The control period a seat cap is counted against. Calendar month. */
function currentPeriod(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

/** §7.2 — how much of its cap this seat has drawn in the current period. */
export function seatUsage(recruiterId) {
  const row = db.prepare(
    `SELECT used FROM seat_usage_periods WHERE recruiter_id = ? AND period = ?`,
  ).get(recruiterId, currentPeriod())
  return row?.used ?? 0
}

/**
 * Whether this organization has already revealed this candidate.
 *
 * Organization-scoped, not recruiter-scoped: §17.1 says a candidate another
 * colleague revealed costs nothing further, because the organization already
 * paid for them.
 */
export function organizationHasRevealed(companyId, candidateId) {
  return Boolean(db.prepare(
    `SELECT 1 FROM organization_reveals WHERE company_id = ? AND candidate_id = ?`,
  ).get(companyId, candidateId))
}

/**
 * §9 — the charging event, in one transaction.
 *
 * Returns a result object rather than throwing, because "you have no reveals
 * left" and "your seat is at its cap" are ordinary states the UI explains, not
 * exceptions.
 *
 * Order matters and is the whole point:
 *
 *  1. Insert the organization-candidate row FIRST. Its UNIQUE constraint is
 *     what makes concurrency safe — two seats revealing the same candidate at
 *     the same instant race on that index, and the loser is told the reveal was
 *     already held rather than deducting a second time. Checking with a SELECT
 *     and then inserting would leave a window between the two.
 *  2. Deduct with the balance guard in the WHERE clause, so a balance of one
 *     cannot satisfy two concurrent reveals of different candidates.
 *  3. If either step finds nothing to do, the transaction throws and SQLite
 *     rolls the whole thing back — §9.4, a failed reveal never consumes.
 */
export function consumeReveal({ companyId, candidateId, recruiterId, allocation = null }) {
  if (organizationHasRevealed(companyId, candidateId)) {
    return { ok: true, charged: false, reason: 'already_revealed', balance: revealBalance(companyId) }
  }

  const balance = revealBalance(companyId)
  if (balance <= 0) return { ok: false, reason: 'no_balance', balance: 0 }

  /*
   * §17.1 — the organization balance wins.
   *
   * A seat with allowance left cannot draw from an empty wallet, and a seat
   * that has spent its allowance is blocked even when the wallet is full. Both
   * have to be true or the allocation is a suggestion rather than a limit.
   */
  if (allocation !== null && allocationRemaining(recruiterId) <= 0) {
    return { ok: false, reason: 'allocation_spent', balance, allocation }
  }

  try {
    return db.transaction(() => {
      db.prepare(`
        INSERT INTO organization_reveals (company_id, candidate_id, revealed_by, created_at)
        VALUES (?, ?, ?, ?)
      `).run(companyId, candidateId, recruiterId, new Date().toISOString())

      const deducted = db.prepare(`
        UPDATE companies SET reveal_balance = reveal_balance - 1
        WHERE id = ? AND reveal_balance > 0
      `).run(companyId).changes

      // Someone else spent the last one between the read above and here.
      if (deducted === 0) throw new Error('insufficient_balance')

      /*
       * The draw against this seat's allowance, guarded in the WHERE clause for
       * the same reason the balance is: two reveals racing on the last unit of
       * an allowance must not both succeed. Seats with no allowance are
       * untouched by it — the UPDATE matches nothing and the guard below lets
       * them through.
       */
      if (allocation !== null) {
        const drawn = db.prepare(`
          UPDATE recruiters SET allocation_used = allocation_used + 1
          WHERE id = ? AND reveal_allocation IS NOT NULL AND allocation_used < reveal_allocation
        `).run(recruiterId).changes

        if (drawn === 0) throw new Error('allocation_spent')
      }

      // Kept for reporting: which seat spent what, month by month. It no longer
      // gates anything — the allowance above does that.
      db.prepare(`
        INSERT INTO seat_usage_periods (recruiter_id, period, used) VALUES (?, ?, 1)
        ON CONFLICT (recruiter_id, period) DO UPDATE SET used = used + 1
      `).run(recruiterId, currentPeriod())

      writeLedger({
        companyId, product: 'reveal', event: 'consume', delta: -1,
        actorId: recruiterId, candidateId,
        note: 'Candidate revealed',
      })

      const left = revealBalance(companyId)
      /* Spending is what took it to nothing, so this is the crossing. */
      if (left === 0) warnEmptied(companyId, 'reveal')
      return { ok: true, charged: true, balance: left }
    })()
  } catch (error) {
    // The UNIQUE index fired: a colleague revealed the same candidate in the
    // same instant, and they paid for it.
    if (String(error.message).includes('UNIQUE')) {
      return { ok: true, charged: false, reason: 'already_revealed', balance: revealBalance(companyId) }
    }
    if (String(error.message).includes('insufficient_balance')) {
      return { ok: false, reason: 'no_balance', balance: 0 }
    }
    if (String(error.message).includes('allocation_spent')) {
      return { ok: false, reason: 'allocation_spent', balance: revealBalance(companyId), allocation }
    }
    throw error
  }
}

/** Adds purchased reveals. Called by a manual purchase and by replenishment. */
export function creditReveals({
  companyId, quantity, event, amount, packKey, provider, providerRef, actorId,
  /* The billing table shows the note and nothing else, so an automatic top-up
     has to be able to say it was automatic rather than reading as a purchase
     the admin does not remember making. */
  note = null,
}) {
  return db.transaction(() => {
    db.prepare(`UPDATE companies SET reveal_balance = reveal_balance + ? WHERE id = ?`)
      .run(quantity, companyId)

    writeLedger({
      companyId, product: 'reveal', event, delta: quantity,
      amount, packKey, provider, providerRef, actorId,
      note: note ?? `${quantity} reveals purchased`,
    })

    /* Inside the same transaction as the credit: capacity that exists without
       anybody being allowed to spend it is capacity nobody can spend. */
    distributeNewCapacity(companyId, 'reveal', quantity)

    return revealBalance(companyId)
  })()
}

/**
 * §18.6 — bringing organizations that existed before the pricing model onto it.
 *
 * Two things are owed to them. The complimentary balance, which they never had
 * the chance to receive; and the reveals they already hold, which have to be
 * recorded as organization-level facts or a candidate they revealed last week
 * would be charged for again on the next click.
 *
 * Idempotent, so it can run on every boot: the grant is guarded by its
 * timestamp column and the backfill by the UNIQUE index it inserts into. It
 * costs one indexed query per company on a cold start and nothing after that.
 */
export function migrateExistingOrganizations() {
  const companies = db.prepare(`SELECT id FROM companies`).all()
  let granted = 0
  let triaged = 0

  for (const company of companies) {
    if (grantComplimentaryReveals(company.id)) granted += 1
    /* Organizations that registered before the Triage allowance existed are
       owed it too — they were told nothing about it either way, and the
       alternative is a pricing page promising every account something only
       accounts created after today receive. */
    try {
      if (grantComplimentaryTriage(company.id)) triaged += 1
    } catch {
      // Granted concurrently by another boot. Nothing owed, nothing to report.
    }

    /*
     * Reveals already paid for under the old model. INSERT OR IGNORE rather
     * than a existence check per row: the UNIQUE index decides, so a partly
     * completed earlier run finishes cleanly instead of duplicating.
     */
    db.prepare(`
      INSERT OR IGNORE INTO organization_reveals (company_id, candidate_id, revealed_by, created_at)
      SELECT r.company_id, r.candidate_id, r.recruiter_id, r.created_at
      FROM reveals r
      WHERE r.company_id = ?
    `).run(company.id)

    /*
     * Capacity is never taken away. An organization that bought seats under the
     * monthly model keeps every one of them, at no recorded spend — they paid
     * under different terms, and charging a true-up against a tier they never
     * agreed to would be the wrong way round. Most keep nothing here, because
     * the five included seats already cover what they had.
     */
    const legacySeats = db.prepare(`
      SELECT COUNT(*) AS n FROM seat_purchases
      WHERE company_id = ? AND status = 'paid' AND cancelled_at IS NULL
    `).get(company.id).n

    const shortfall = 1 + legacySeats - INCLUDED_SEATS
    if (shortfall > 0) {
      const current = db.prepare(`SELECT purchased_seats FROM companies WHERE id = ?`)
        .get(company.id).purchased_seats ?? 0

      if (current < shortfall) {
        db.transaction(() => {
          db.prepare(`UPDATE companies SET purchased_seats = ? WHERE id = ?`)
            .run(shortfall, company.id)
          writeLedger({
            companyId: company.id, product: 'seat', event: 'adjustment',
            delta: shortfall - current,
            note: 'Seats carried over from the previous monthly plan',
          })
        })()
      }
    }
  }

  return { companies: companies.length, granted, triaged }
}

// --------------------------------------------------------------- seats ---

/**
 * Moving to a seat subscription of `seats` additional seats.
 *
 * The whole tier is quoted, not the step. Under the old owning model a purchase
 * was priced against what had already been bought and credited back — that made
 * sense when seats were kept forever, and makes none for a subscription, where
 * the only question is what next month costs. It also made a reduction
 * inexpressible: you cannot buy negative seats. Here 3 → 1 is simply a cheaper
 * subscription, and the quote says so.
 *
 * A count above the self-serve maximum has no price. Those organizations are
 * sent to sales rather than quoted a number nobody has agreed to.
 */
/**
 * When the paid month runs out, counted from the day the seats were taken on.
 *
 * The anniversary of that day in the following month — not the first of the
 * calendar month. An organization that subscribed on the 17th has paid through
 * to the 17th, and taking a seat back sooner charges for time it never got.
 *
 * Months are uneven, so a 31st anchor lands on the last day of a short month
 * rather than skidding into the next one: setting date 31 on a 30-day month
 * rolls over in JavaScript, and "cancelled on the 31st of January, ends the 3rd
 * of March" is not something anybody would accept on an invoice.
 */
export function seatPeriodEnd(since, from = new Date()) {
  if (!since) return null

  const anchor = new Date(since)
  if (Number.isNaN(anchor.getTime())) return null

  const day = anchor.getUTCDate()
  const end = new Date(Date.UTC(
    from.getUTCFullYear(), from.getUTCMonth(), day,
    anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(),
  ))

  // Clamp into the month it was meant to land in, then step forward until it
  // is genuinely ahead of `from`.
  const clamp = (date, month, year) => {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    return new Date(Date.UTC(
      year, month, Math.min(day, last),
      anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(),
    ))
  }

  let result = clamp(end, from.getUTCMonth(), from.getUTCFullYear())
  while (result <= from) {
    const month = result.getUTCMonth() + 1
    result = clamp(result, month % 12, result.getUTCFullYear() + Math.floor(month / 12))
  }
  return result.toISOString()
}

/**
 * Applies a reduction whose month has run out.
 *
 * Called wherever the entitlement is read, so nothing depends on a scheduler
 * having run: the seat disappears the first time anybody looks after the date,
 * which is indistinguishable from the outside and cannot silently not happen.
 *
 * Clamped to the seats actually in use. Between scheduling and applying,
 * somebody may have taken the seat that was being given up — reducing below
 * them would leave an account nobody can sign into.
 */
function applyDueSeatChange(companyId) {
  const row = db.prepare(`
    SELECT purchased_seats, seat_plan_pending, seat_plan_pending_at
    FROM companies WHERE id = ?
  `).get(companyId)

  if (!row || row.seat_plan_pending === null || row.seat_plan_pending === undefined) return

  /*
   * The date fixed when the reduction was scheduled, not one worked out again
   * now. seatPeriodEnd always answers with the NEXT anniversary, so recomputing
   * it here would place the deadline in the future on every read and the
   * reduction would never come due — the seat would be held for ever.
   */
  const endsAt = row.seat_plan_pending_at
  if (!endsAt || new Date(endsAt) > new Date()) return

  const seats = row.seat_plan_pending
  const monthly = seatPlanMonthly(seats) ?? 0

  /*
   * Whoever is still over the line goes with the seats.
   *
   * The alternative was to keep them and quietly hold the subscription up,
   * which bills an organization for capacity it cancelled a month ago and
   * never resolves itself. Newest first, administrators never — and it was
   * said, by name, on the screen where the reduction was agreed to and again
   * on the Team page every day since.
   */
  const removed = seatsAtRisk(companyId, seats)

  db.transaction(() => {
    for (const person of removed) deleteRecruiterCompletely(person.id)

    db.prepare(`
      UPDATE companies
      SET purchased_seats = ?, seat_spend = ?,
          seat_plan_pending = NULL, seat_plan_pending_at = NULL,
          seat_plan_since = ?
      WHERE id = ?
    `).run(seats, monthly, seats > 0 ? endsAt : null, companyId)

    writeLedger({
      companyId, product: 'seat', event: 'adjustment',
      delta: seats - row.purchased_seats, amount: monthly,
      packKey: `seats_${seats}`,
      note: (seats === 0
        ? 'Seat subscription ended — administrator only'
        : `Seat subscription reduced to ${seats} additional seat${seats === 1 ? '' : 's'}`)
        + (removed.length
          ? ` · removed ${removed.map((person) => person.username).join(', ')}`
          : ''),
    })
  })()
}

/**
 * The accounts a reduction would take with it, newest first.
 *
 * A subscription that shrinks below the number of people using the account has
 * to give something up, and the rule is last in, first out: the administrator
 * is never one of them, and the colleague who has been there longest is the
 * last to go. Returned rather than acted on, so the same list can warn before
 * the date and be used to do the work on it.
 */
export function seatsAtRisk(companyId, seats) {
  const room = INCLUDED_SEATS + seats
  const people = db.prepare(`
    SELECT id, first_name, last_name, username, is_org_admin
    FROM recruiters WHERE company_id = ?
    ORDER BY is_org_admin DESC, created_at, id
  `).all(companyId)

  // The keepers are the admins and then the longest-standing, up to the room
  // available; whatever is left over is what a reduction would remove.
  return people.slice(room).filter((person) => !person.is_org_admin).map((person) => ({
    id: person.id,
    name: [person.first_name, person.last_name].filter(Boolean).join(' ') || person.username,
    username: person.username,
  }))
}

export function quoteSeatPlan({ company, seats }) {
  const current = company.purchased_seats ?? 0
  const currentMonthly = seatPlanMonthly(current) ?? 0
  const monthly = seatPlanMonthly(seats)

  /* A reduction does not start until the paid month is up; an increase is
     paid for now and starts now. The quote says which, and when. */
  const reducing = monthly !== null && seats < current
  const endsAt = reducing ? seatPeriodEnd(company.seat_plan_since) : null

  return {
    current,
    seats,
    currentMonthly,
    monthly,
    reducing,
    effectiveFrom: reducing ? endsAt : null,
    /* Named, not counted: "2 accounts will be removed" is a fact somebody has
       to go and look up, and the whole point of saying it here is that they
       should not have to. */
    atRisk: monthly === null ? [] : seatsAtRisk(company.id, seats),
    /* Signed: negative on a downgrade. What the organization's recurring bill
       changes by, which is the number an administrator is deciding about. */
    change: monthly === null ? null : monthly - currentMonthly,
    contactSales: monthly === null,
    currency: CURRENCY,
    formatted: monthly === null ? null : {
      currentMonthly: formatAmount(currentMonthly),
      monthly: formatAmount(monthly),
      change: formatAmount(Math.abs(monthly - currentMonthly)),
    },
  }
}

/**
 * Puts the organization on that subscription.
 *
 * `purchased_seats` holds the subscribed count and `seat_spend` the amount
 * charged each month — both are set, not added to, because a subscription is a
 * state rather than a running total. The ledger keeps the history that the
 * columns no longer accumulate.
 *
 * Refuses to drop below the seats actually in use. Taking a subscription away
 * from underneath a colleague would leave an account nobody can sign into and
 * no obvious way to see why; removing the person is the deliberate act, and it
 * frees the seat by itself.
 */
export function setSeatPlan({ companyId, seats, provider, providerRef, actorId }) {
  const monthly = seatPlanMonthly(seats)
  if (monthly === null) throw new Error('That many seats is not available self-serve.')

  return db.transaction(() => {
    const occupied = db.prepare(
      `SELECT COUNT(*) AS n FROM recruiters WHERE company_id = ?`,
    ).get(companyId).n

    /*
     * A reduction below the seats in use is allowed, and scheduled like any
     * other.
     *
     * It used to be refused outright, which sounds safe and is not: an
     * organization wanting to stop paying for a seat had to work out for itself
     * which colleague to remove first, and until they did they went on being
     * charged. What happens instead is stated plainly before it is agreed to —
     * the newest accounts go on the day the month ends, unless somebody is
     * removed before then. Nothing happens today.
     */
    const row = db.prepare(
      `SELECT purchased_seats, seat_plan_since FROM companies WHERE id = ?`,
    ).get(companyId)
    const before = row?.purchased_seats ?? 0

    /*
     * Going down is scheduled, not done.
     *
     * The month has been paid for, so the capacity stays until the anniversary
     * of the day it was taken on. Nothing is charged now and nothing is
     * refunded; the columns keep the paid state and `seat_plan_pending` records
     * where it is heading. applyDueSeatChange finishes it when the date comes.
     */
    if (seats < before) {
      const endsAt = seatPeriodEnd(row?.seat_plan_since)
      db.prepare(`
        UPDATE companies SET seat_plan_pending = ?, seat_plan_pending_at = ? WHERE id = ?
      `).run(seats, endsAt, companyId)

      writeLedger({
        companyId, product: 'seat', event: 'adjustment', delta: 0,
        actorId, packKey: `seats_${seats}`,
        note: seats === 0
          ? `Seat subscription cancelled — ends ${endsAt?.slice(0, 10) ?? 'at the end of the month'}`
          : `Seat subscription reduces to ${seats} additional seat${seats === 1 ? '' : 's'} on ${endsAt?.slice(0, 10) ?? 'renewal'}`,
      })

      return seatEntitlement(companyId)
    }

    /* Going up takes effect now, and clears any reduction that was waiting —
       asking for more seats is not a quieter way of asking for fewer. The
       anchor is kept if there is one, so the renewal day does not drift every
       time somebody hires. */
    db.prepare(`
      UPDATE companies
      SET purchased_seats = ?, seat_spend = ?, seat_plan_pending = NULL, seat_plan_since = ?
      WHERE id = ?
    `).run(seats, monthly, row?.seat_plan_since ?? new Date().toISOString(), companyId)

    /*
     * Recorded within the ledger's existing vocabulary rather than adding a
     * 'subscription' event to it.
     *
     * The event column is CHECK-constrained, and SQLite cannot widen a CHECK
     * without rebuilding the table — which on a live database means copying
     * every billing row a customer has ever accrued, for the sake of a label.
     * Going up takes money now and is a purchase; going down or cancelling
     * takes none and is an adjustment. The note carries what the enum cannot,
     * and the amount is the new monthly rate either way.
     */
    writeLedger({
      companyId, product: 'seat',
      event: seats > before ? 'purchase' : 'adjustment',
      delta: seats - before,
      amount: monthly, provider, providerRef, actorId,
      packKey: `seats_${seats}`,
      note: seats === 0
        ? 'Seat subscription cancelled — administrator only'
        : `Seat subscription set to ${seats} additional seat${seats === 1 ? '' : 's'} per month`,
    })

    return seatEntitlement(companyId)
  })()
}

/**
 * §14 — capacity, split by where it came from.
 *
 * Occupancy is counted from the recruiters table rather than tracked
 * separately, so removing a member frees a seat with no bookkeeping and
 * entitlement is untouched by it (§14.4.4).
 */
export function seatEntitlement(companyId) {
  // Anything whose month has run out is applied before the answer is given, so
  // the entitlement is never stale by the length of time since a cron last ran.
  applyDueSeatChange(companyId)

  const company = db.prepare(
    `SELECT purchased_seats, seat_spend, seat_plan_since, seat_plan_pending,
            seat_plan_pending_at
     FROM companies WHERE id = ?`,
  ).get(companyId)

  const purchased = company?.purchased_seats ?? 0
  const total = INCLUDED_SEATS + purchased
  const occupied = db.prepare(
    `SELECT COUNT(*) AS n FROM recruiters WHERE company_id = ?`,
  ).get(companyId).n

  const monthly = company?.seat_spend ?? 0

  return {
    included: INCLUDED_SEATS,
    /* The subscribed count. Named `purchased` still, because a dozen call sites
       read it and renaming a field is not what makes seats a subscription. */
    purchased,
    total,
    occupied,
    available: Math.max(0, total - occupied),
    /* What the organization pays every month for its seats, and the smallest
       subscription it could hold without displacing anyone. */
    monthly,
    formattedMonthly: formatAmount(monthly),
    minimum: Math.max(0, occupied - INCLUDED_SEATS),
    selfServeMax: SEAT_SELF_SERVE_MAX,
    /* A reduction that has been asked for and not yet happened, and the day it
       does. Both null when nothing is scheduled. */
    pending: company?.seat_plan_pending ?? null,
    pendingFrom: company?.seat_plan_pending_at ?? null,
    /* Who the scheduled reduction would take with it, so the Team page can
       name them every day until somebody acts. */
    atRisk: company?.seat_plan_pending === null || company?.seat_plan_pending === undefined
      ? []
      : seatsAtRisk(companyId, company.seat_plan_pending),
    renewsAt: seatPeriodEnd(company?.seat_plan_since),
  }
}

/** How many of this seat's allowance is left. Infinite when none was set. */
export function allocationRemaining(recruiterId) {
  const row = db.prepare(
    `SELECT reveal_allocation, allocation_used FROM recruiters WHERE id = ?`,
  ).get(recruiterId)

  if (!row || row.reveal_allocation === null) return Infinity
  return Math.max(0, row.reveal_allocation - row.allocation_used)
}

/**
 * §7.2 — the whole team's allowances, set in one go.
 *
 * Deliberately not one endpoint per person. Redistribution is the normal case —
 * taking ten from one seat to give them to another — and applied one seat at a
 * time that transiently overspends the balance, so either the valid end state
 * is rejected on the way to itself or the check is too weak to mean anything.
 * Taking the whole map lets the sum be checked once, against the balance, and
 * applied atomically.
 *
 * Setting an allowance resets what has been drawn against it: the admin is
 * saying how many that person gets from here, not amending what they already
 * spent. Without the reset, giving somebody who had spent their 20 a fresh 20
 * would hand them nothing and look broken.
 */
export function setRevealAllocations({ companyId, allocations }) {
  const seats = db.prepare(
    `SELECT id, first_name, last_name FROM recruiters WHERE company_id = ?`,
  ).all(companyId)
  const known = new Set(seats.map((seat) => seat.id))

  for (const id of Object.keys(allocations)) {
    if (!known.has(Number(id))) {
      throw new Error('That account is not in your organization.')
    }
  }

  const total = Object.values(allocations)
    .filter((value) => value !== null)
    .reduce((sum, value) => sum + value, 0)

  const balance = revealBalance(companyId)
  if (total > balance) {
    throw new Error(
      `You have ${balance} reveal${balance === 1 ? '' : 's'} to share out and have allocated `
      + `${total}. Lower an allowance, or buy more reveals.`,
    )
  }

  db.transaction(() => {
    for (const seat of seats) {
      // Absent from the map means unchanged; explicit null means "no allowance,
      // draw from the shared pool" — which is not the same instruction.
      if (!(seat.id in allocations)) continue
      db.prepare(
        `UPDATE recruiters SET reveal_allocation = ?, allocation_used = 0 WHERE id = ?`,
      ).run(allocations[seat.id], seat.id)
    }
  })()

  return revealAllocations(companyId)
}

/**
 * What each seat has been given and drawn, plus what is still unassigned.
 *
 * `unallocated` is the number the admin is actually working with: reveals no
 * seat has a claim on. It can only be spent by seats with no allowance at all,
 * which is worth stating plainly rather than leaving to be discovered.
 */
export function revealAllocations(companyId) {
  const seats = db.prepare(`
    SELECT id, first_name, last_name, username, is_org_admin,
           reveal_allocation, allocation_used
    FROM recruiters WHERE company_id = ?
    ORDER BY is_org_admin DESC, id
  `).all(companyId).map((row) => ({
    id: row.id,
    name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    username: row.username,
    isAdmin: Boolean(row.is_org_admin),
    allocation: row.reveal_allocation,
    /*
     * The same number under the name the Triage table uses.
     *
     * One component draws both allowance tables, and it read `allowance` —
     * which this endpoint had never sent. It went unnoticed for as long as
     * every reveal allowance was null, because a missing field and an unset
     * allowance both render as "Shared". They stopped agreeing the moment the
     * split started filling allowances in.
     *
     * Aliased rather than renamed: `allocation` is read elsewhere, and one of
     * the two products having a different word for the same column is what
     * caused this.
     */
    allowance: row.reveal_allocation,
    used: row.allocation_used,
    remaining: row.reveal_allocation === null
      ? null
      : Math.max(0, row.reveal_allocation - row.allocation_used),
  }))

  const balance = revealBalance(companyId)
  const assigned = seats.reduce((sum, seat) => sum + (seat.remaining ?? 0), 0)

  return {
    balance,
    seats,
    assigned,
    unallocated: Math.max(0, balance - assigned),
    // False on a fresh organization, which is what makes "off unless you turn
    // it on" true rather than merely the effect of every allowance being null.
    dividing: seats.some((seat) => seat.allocation !== null),
  }
}

/** §11.4 — whether another member can be invited at all. */
export function seatsExhausted(companyId) {
  return seatEntitlement(companyId).available < 1
}

// ------------------------------------------------------------- overview ---

export function ledgerEntries(companyId, { limit = 100 } = {}) {
  return db.prepare(`
    SELECT l.*, r.first_name, r.last_name
    FROM billing_ledger l
    LEFT JOIN recruiters r ON r.id = l.actor_id
    WHERE l.company_id = ?
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ?
  `).all(companyId, limit).map((row) => ({
    id: row.id,
    product: row.product,
    event: row.event,
    delta: row.delta,
    amount: row.amount,
    formattedAmount: row.amount === null ? null : formatAmount(row.amount, row.currency ?? CURRENCY),
    note: row.note,
    createdAt: row.created_at,
    actor: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
  }))
}

/**
 * How many reveals a company has spent, for the usage meters' denominator.
 *
 * Counted from organization_reveals rather than summed off the ledger: that
 * table is the record of which candidates the company actually opened, which is
 * what "how much of our allowance have we used" is asking. A ledger sum would
 * count refunds and corrections as usage too.
 */
export function companyRevealsUsed(companyId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM organization_reveals WHERE company_id = ?`,
  ).get(companyId).n
}


// -------------------------------------------------------------- triage ---

/**
 * Triage capacity, denominated in CVs.
 *
 * The metered unit is the CV, not the Triage. A workspace is free and
 * unlimited; capacity is spent only when CVs are accepted for processing, and
 * an organization spends one pool across as many job descriptions as it likes.
 *
 * Deliberately a separate balance from reveals rather than a shared "credits"
 * pool. The two buy different things, and an organization that bought reveals
 * to open candidates must never discover that a colleague spent them sorting an
 * applicant pile. Nothing in this file lets one become the other.
 */
export function triageBalance(companyId) {
  return db.prepare(`SELECT triage_cv_balance FROM companies WHERE id = ?`)
    .get(companyId)?.triage_cv_balance ?? 0
}

/** Adds purchased CV capacity. Mirrors creditReveals, on its own product. */
export function creditTriages({ companyId, quantity, event = 'purchase', amount = null, packKey = null, provider = null, providerRef = null, actorId = null }) {
  return db.transaction(() => {
    db.prepare(`UPDATE companies SET triage_cv_balance = triage_cv_balance + ? WHERE id = ?`)
      .run(quantity, companyId)

    writeLedger({
      companyId, product: 'triage', event, delta: quantity,
      amount, packKey, provider, providerRef, actorId,
      note: `${quantity} CV${quantity === 1 ? '' : 's'} of Triage capacity purchased`,
    })

    /* Its own split, independent of reveals: buying CVs must never move a
       reveal allowance, and the two flags are read separately. */
    distributeNewCapacity(companyId, 'triage', quantity)

    return triageBalance(companyId)
  })()
}

/**
 * §10/§11 — how much this seat may still spend.
 *
 * NULL allowance means the seat draws freely from the organization's pool,
 * which is the default. An allowance is not a sub-wallet: it caps what one
 * person may draw, and the pool is checked independently, so the two together
 * can never let aggregate consumption exceed what was actually bought.
 */
export function triageAllowanceRemaining(recruiterId) {
  const row = db.prepare(
    `SELECT triage_allowance, triage_used FROM recruiters WHERE id = ?`,
  ).get(recruiterId)

  if (!row || row.triage_allowance === null) return Infinity
  return Math.max(0, row.triage_allowance - row.triage_used)
}

/**
 * §11 — may this recruiter launch this many CVs, and if not, why not.
 *
 * Two limits, reported separately and never conflated. Telling somebody to buy
 * more capacity when their organization has 600 CVs sitting unused and their
 * administrator has capped them at 100 sends them to a purchase screen that
 * will not fix anything — so the two answers are distinct, and the seat one
 * points at a person rather than at a checkout.
 */
export function triageCapacityCheck({ companyId, recruiterId, cvs }) {
  const balance = triageBalance(companyId)
  const allowance = triageAllowanceRemaining(recruiterId)
  const capped = allowance !== Infinity

  return {
    cvs,
    balance,
    allowance: capped ? allowance : null,
    remainingAfter: Math.max(0, balance - cvs),
    /* Both are reported even when only one blocks, so the confirmation step can
       show the whole picture rather than the first failure. */
    organizationShort: Math.max(0, cvs - balance),
    seatShort: capped ? Math.max(0, cvs - allowance) : 0,
    ok: cvs <= balance && cvs <= allowance,
  }
}

/**
 * Spends CV capacity on one Triage, once, ever.
 *
 * The idempotency is not a convenience — it is the requirement. A recruiter who
 * double-clicks Launch, or whose browser retries, must be charged once.
 *
 * The guard is the triages row itself rather than a flag held here: the UPDATE
 * that claims it only matches while ledger_id IS NULL, so two concurrent
 * launches race on one row and exactly one of them changes it. The loser is
 * told 'already_launched' and charged nothing. A flag checked before the write
 * would leave a window between the check and the charge; this has none.
 *
 * Both counters move inside the same transaction as the ledger row, so the
 * organization pool and the seat's usage can never disagree with the history.
 */
export function consumeTriageCvs({ companyId, triageId, recruiterId, cvs }) {
  if (!Number.isInteger(cvs) || cvs <= 0) {
    return { ok: false, reason: 'nothing_to_charge', balance: triageBalance(companyId) }
  }

  try {
    return db.transaction(() => {
      const triage = db.prepare(
        `SELECT id, company_id, ledger_id, charged_cvs FROM triages WHERE id = ?`,
      ).get(triageId)

      if (!triage || triage.company_id !== companyId) throw new Error('triage_not_found')

      /* Already paid for. Returning the existing row rather than an error is
         what makes a retried launch land exactly where the first one did. */
      if (triage.ledger_id) {
        return {
          ok: true, charged: false, reason: 'already_launched',
          cvs: triage.charged_cvs, balance: triageBalance(companyId),
          ledgerId: triage.ledger_id,
        }
      }

      /* The pool. The WHERE clause is the check — reading the balance first and
         deciding in JavaScript would let two launches both see 300 and both
         spend 200 of it. */
      const spent = db.prepare(`
        UPDATE companies SET triage_cv_balance = triage_cv_balance - ?
        WHERE id = ? AND triage_cv_balance >= ?
      `).run(cvs, companyId, cvs)
      if (spent.changes === 0) throw new Error('no_triage_capacity')

      /* The seat's share, on the same terms. A NULL allowance is unlimited, so
         the row still records what was drawn but no ceiling is enforced. */
      const drew = db.prepare(`
        UPDATE recruiters SET triage_used = triage_used + ?
        WHERE id = ?
          AND (triage_allowance IS NULL OR triage_used + ? <= triage_allowance)
      `).run(cvs, recruiterId, cvs)
      if (drew.changes === 0) throw new Error('over_seat_allowance')

      const ledgerId = writeLedger({
        companyId, product: 'triage', event: 'consume', delta: -cvs,
        actorId: recruiterId,
        note: `${cvs} CV${cvs === 1 ? '' : 's'} submitted for Triage processing`,
      })

      const claimed = db.prepare(
        `UPDATE triages SET ledger_id = ?, charged_cvs = ? WHERE id = ? AND ledger_id IS NULL`,
      ).run(ledgerId, cvs, triageId)

      // Lost the race against a concurrent launch. Rolling the whole
      // transaction back returns the capacity and unwrites the ledger row.
      if (claimed.changes === 0) throw new Error('already_launched_concurrently')

      const capacityLeft = triageBalance(companyId)
      if (capacityLeft === 0) warnEmptied(companyId, 'triage')
      return { ok: true, charged: true, cvs, balance: capacityLeft, ledgerId }
    })()
  } catch (error) {
    const message = String(error.message)
    if (message.includes('no_triage_capacity')) {
      return {
        ok: false, reason: 'no_capacity',
        balance: triageBalance(companyId),
        short: Math.max(0, cvs - triageBalance(companyId)),
      }
    }
    if (message.includes('over_seat_allowance')) {
      return {
        ok: false, reason: 'over_allowance',
        balance: triageBalance(companyId),
        allowance: triageAllowanceRemaining(recruiterId),
      }
    }
    if (message.includes('already_launched_concurrently')) {
      const row = db.prepare(`SELECT ledger_id, charged_cvs FROM triages WHERE id = ?`).get(triageId)
      return {
        ok: true, charged: false, reason: 'already_launched',
        cvs: row?.charged_cvs ?? 0, balance: triageBalance(companyId),
        ledgerId: row?.ledger_id ?? null,
      }
    }
    if (message.includes('triage_not_found')) {
      return { ok: false, reason: 'not_found', balance: triageBalance(companyId) }
    }
    throw error
  }
}

/**
 * Hands capacity back for CVs that turned out not to be readable.
 *
 * A file is charged when it is accepted into the processing set, which is the
 * only moment the count is knowable — text extraction happens on the queue,
 * minutes later. So a scanned photograph of a CV is charged first and found
 * unreadable afterwards, and "one VALID CV consumes capacity once" is only true
 * if the difference is returned.
 *
 * `totalCvs` is the number that SHOULD have been refunded for this Triage in
 * total — not a delta to add. That distinction is the whole correctness of this
 * function. The caller is a queue sweep that can run more than once (a retried
 * batch, a reclaimed one after a crash), and it reports the same "1 unreadable"
 * every time; an additive refund paid it out on every sweep, so two runs
 * returned two CVs for one bad file. Refunding the difference between what is
 * owed and what has already been paid is idempotent under any number of
 * repeats.
 */
export function refundTriageCvs({ companyId, triageId, totalCvs, note = 'CVs that could not be read' }) {
  if (!Number.isInteger(totalCvs) || totalCvs <= 0) {
    return { refunded: 0, balance: triageBalance(companyId) }
  }

  return db.transaction(() => {
    const triage = db.prepare(
      `SELECT id, company_id, recruiter_id, ledger_id, charged_cvs, refunded_cvs
       FROM triages WHERE id = ?`,
    ).get(triageId)

    if (!triage || triage.company_id !== companyId || !triage.ledger_id) {
      return { refunded: 0, balance: triageBalance(companyId) }
    }

    /* Owed in total, minus what has already gone back, clamped to what was
       actually charged. Two independent guards, because either alone would let
       a bad caller mint capacity. */
    const owed = Math.max(0, Math.min(
      totalCvs - triage.refunded_cvs,
      triage.charged_cvs - triage.refunded_cvs,
    ))
    if (owed === 0) return { refunded: 0, balance: triageBalance(companyId) }

    db.prepare(`UPDATE companies SET triage_cv_balance = triage_cv_balance + ? WHERE id = ?`)
      .run(owed, companyId)

    /*
     * The seat that actually paid, which is not necessarily the one that
     * created the draft: a colleague may launch a Triage somebody else set up,
     * and the charge went to whoever pressed the button. It is recorded on the
     * ledger row this Triage claimed, so that is where the refund reads it from
     * rather than trusting triages.recruiter_id.
     */
    const payer = db.prepare(`SELECT actor_id FROM billing_ledger WHERE id = ?`)
      .get(triage.ledger_id)?.actor_id ?? triage.recruiter_id

    if (payer) {
      db.prepare(`UPDATE recruiters SET triage_used = MAX(0, triage_used - ?) WHERE id = ?`)
        .run(owed, payer)
    }

    db.prepare(`UPDATE triages SET refunded_cvs = refunded_cvs + ? WHERE id = ?`)
      .run(owed, triageId)

    writeLedger({
      companyId, product: 'triage', event: 'refund', delta: owed,
      actorId: payer, note: `${owed} ${note}`,
    })

    return { refunded: owed, balance: triageBalance(companyId) }
  })()
}

/** How many CVs this organization has ever put through Triage. */
export function triageCvsUsed(companyId) {
  return db.prepare(
    `SELECT COALESCE(SUM(charged_cvs - refunded_cvs), 0) AS n
     FROM triages WHERE company_id = ? AND ledger_id IS NOT NULL`,
  ).get(companyId).n
}

/** How many Triage workspaces have been launched. Reported, never limited. */
export function triagesLaunched(companyId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM triages WHERE company_id = ? AND ledger_id IS NOT NULL`,
  ).get(companyId).n
}

/**
 * How many Triage workspaces this organization has, drafts included.
 *
 * Not the same question as triagesLaunched above, and the difference is the
 * point: that one counts the Triages that have been paid for, which is a
 * billing fact. This counts the rows a recruiter would see in the list, which
 * is a navigation fact — a draft is a workspace they made, can reopen and can
 * delete, so it is one of the things the word "Triage" in the rail refers to.
 */
export function triageWorkspaces(companyId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM triages WHERE company_id = ?`)
    .get(companyId).n
}

/**
 * §9 — every seat's Triage allowance and what it has drawn, for the admin
 * screen. Shaped exactly like revealAllocations, because it is the same idea
 * about a different currency.
 */
export function triageAllocations(companyId) {
  const rows = db.prepare(`
    SELECT id, first_name, last_name, is_org_admin, triage_allowance, triage_used
    FROM recruiters WHERE company_id = ? AND is_active = 1
    ORDER BY is_org_admin DESC, id
  `).all(companyId)

  return {
    balance: triageBalance(companyId),
    seats: rows.map((row) => ({
      id: row.id,
      name: [row.first_name, row.last_name].filter(Boolean).join(' '),
      isAdmin: Boolean(row.is_org_admin),
      allowance: row.triage_allowance,
      used: row.triage_used,
      remaining: row.triage_allowance === null
        ? null
        : Math.max(0, row.triage_allowance - row.triage_used),
    })),
    /* What the admin has promised out. Allowed to exceed the balance — an
       allowance is a ceiling on a person, not a reservation of stock — but
       worth stating, because it is the number that explains why two people
       cannot both spend their full share. */
    allocated: rows.reduce((sum, row) => sum + (row.triage_allowance ?? 0), 0),
  }
}

/**
 * §9 — sets seat allowances. NULL for a seat means "draw from the shared pool".
 *
 * Usage is deliberately NOT reset when an allowance changes: raising somebody's
 * cap from 100 to 300 should give them 200 more, not 300 more, and zeroing the
 * counter would hand back capacity that has already been spent.
 */
export function setTriageAllocations({ companyId, allocations }) {
  const seats = db.prepare(
    `SELECT id FROM recruiters WHERE company_id = ? AND is_active = 1`,
  ).all(companyId).map((row) => row.id)
  const known = new Set(seats)

  return db.transaction(() => {
    for (const [rawId, rawValue] of Object.entries(allocations ?? {})) {
      const id = Number(rawId)
      if (!known.has(id)) continue

      const value = rawValue === null || rawValue === '' ? null : Number(rawValue)
      if (value !== null && (!Number.isFinite(value) || value < 0)) {
        throw new Error('An allowance has to be a whole number of CVs, or blank for no limit.')
      }

      db.prepare(`UPDATE recruiters SET triage_allowance = ? WHERE id = ?`)
        .run(value === null ? null : Math.round(value), id)
    }

    return triageAllocations(companyId)
  })()
}

/** What the admin billing screen renders, and the shape a receipt is built on. */
/**
 * How much of the CURRENT capacity has been spent, and what is left.
 *
 * The bar answers "how far through are we since we last bought", which is a
 * different question from "how much have we ever used" — and the only one with
 * an honest denominator. Credits never expire, so lifetime usage over lifetime
 * purchases draws a bar that creeps towards full for ever and tells an
 * organization on its tenth pack that it is nearly out of something it has
 * plenty of.
 *
 * So the baseline is the balance immediately after the most recent credit, and
 * consumption is counted from there. Buying resets the bar and keeps the
 * credits; it is a new denominator, not a new balance.
 *
 * Derived from the ledger rather than stored. A stored baseline is a second
 * source of truth for a number the ledger already contains, and the two would
 * disagree the first time anything wrote to one and not the other.
 *
 * Refunds and adjustments deliberately do NOT reset it: a Triage handing back
 * the CVs it could not read is not a purchase, and treating it as one would
 * empty the bar as a reward for failure.
 */
export function capacitySince(companyId, product) {
  const rows = db.prepare(`
    SELECT event, delta FROM billing_ledger
    WHERE company_id = ? AND product = ?
    ORDER BY id
  `).all(companyId, product)

  let balance = 0
  let baseline = 0
  let consumed = 0

  for (const row of rows) {
    balance += row.delta
    if (row.event === 'purchase' || row.event === 'grant') {
      baseline = balance
      consumed = 0
    } else if (row.delta < 0) {
      consumed += -row.delta
    }
  }

  return {
    /* What the bar is a fraction of: the balance at the last purchase. */
    baseline,
    consumed,
    left: balance,
    /* Clamped, because a refund can leave `consumed` above nothing without the
       baseline moving, and a bar past its own end says nothing useful. */
    share: baseline > 0 ? Math.min(1, consumed / baseline) : 0,
  }
}

/* Everyone with a seat, admin first — the denominator for an equal split and
   the list the Seats table is drawn from. */
function seatRows(companyId) {
  return db.prepare(`
    SELECT id, first_name, last_name, username, is_org_admin, created_at
    FROM recruiters WHERE company_id = ? AND is_active = 1
    ORDER BY is_org_admin DESC, id
  `).all(companyId)
}

/**
 * An equal share each, and the remainder to the admin.
 *
 * Whole credits only. There is no such thing as a third of a reveal, so the
 * arithmetic is floor-and-remainder rather than a division that would have to
 * be rounded somewhere less visible. The admin takes what will not divide
 * because somebody has to, and they are the one who can give it away again.
 *
 * The admin is a seat like any other in the denominator — administrative
 * authority is not a reason to be excluded from the count.
 */
export function equalShares(companyId, amount) {
  const seats = seatRows(companyId)
  if (seats.length === 0) return []

  const base = Math.floor(amount / seats.length)
  const remainder = amount - base * seats.length
  /* If nobody is flagged as admin the remainder still has to land somewhere,
     and the first seat is the oldest account. */
  const takesRemainder = seats.find((seat) => seat.is_org_admin) ?? seats[0]

  return seats.map((seat) => ({
    id: seat.id,
    isAdmin: Boolean(seat.is_org_admin),
    share: base + (seat.id === takesRemainder.id ? remainder : 0),
  }))
}

const SPLIT_COLUMN = { reveal: 'reveal_split_equally', triage: 'triage_split_equally' }
const ALLOWANCE_COLUMN = { reveal: 'reveal_allocation', triage: 'triage_allowance' }
const USED_COLUMN = { reveal: 'allocation_used', triage: 'triage_used' }

/** Whether this product's capacity is shared out automatically. */
export function splitsEqually(companyId, product) {
  const row = db.prepare(
    `SELECT ${SPLIT_COLUMN[product]} AS on_ FROM companies WHERE id = ?`,
  ).get(companyId)
  return Boolean(row?.on_)
}

/**
 * Recalculate every allowance from the balance as it stands.
 *
 * For turning the switch on, and for a seat arriving or leaving — both are
 * moments when "an equal share each" means something different from what is
 * written down. NOT for a purchase: that adds, and adding is what keeps one
 * recruiter's heavier usage visible in their own balance.
 *
 * Consumption is never touched. The allowance is set to what they have already
 * spent plus their share, so the share is what remains rather than what they
 * are given back.
 */
export function applyEqualSplit(companyId, product) {
  const balance = product === 'reveal' ? revealBalance(companyId) : triageBalance(companyId)
  const allowance = ALLOWANCE_COLUMN[product]
  const used = USED_COLUMN[product]

  db.transaction(() => {
    for (const seat of equalShares(companyId, balance)) {
      db.prepare(
        `UPDATE recruiters SET ${allowance} = ${used} + ? WHERE id = ?`,
      ).run(seat.share, seat.id)
    }
  })()
}

/**
 * Share newly bought capacity out, without disturbing what came before.
 *
 * The distinction §14 turns on: a purchase adds to each allowance, it does not
 * level them. A recruiter who has spent more than a colleague still has less
 * left afterwards, which is the whole point of an allowance.
 */
export function distributeNewCapacity(companyId, product, quantity) {
  if (!(quantity > 0) || !splitsEqually(companyId, product)) return

  const allowance = ALLOWANCE_COLUMN[product]
  db.transaction(() => {
    for (const seat of equalShares(companyId, quantity)) {
      db.prepare(
        `UPDATE recruiters SET ${allowance} = COALESCE(${allowance}, 0) + ? WHERE id = ?`,
      ).run(seat.share, seat.id)
    }
  })()
}

/**
 * The seats have changed, so the shares have to be worked out again.
 *
 * Called when somebody joins or leaves, for whichever products are dividing
 * themselves. Two seats each holding half of a balance is the wrong answer the
 * moment there are three people, and there is nobody to notice but this.
 *
 * It is also what makes a brand-new organization work at all: the complimentary
 * grant lands before the administrator's own row exists, so at that moment
 * there is no seat to give it to. The grant is distributed to nobody, and this
 * puts it right as soon as there is somebody to give it to.
 *
 * A no-op for a product whose switch is off — an admin who has set allowances
 * by hand has not asked for them to be rewritten behind their back.
 */
export function resettleSeats(companyId) {
  for (const product of ['reveal', 'triage']) {
    if (splitsEqually(companyId, product)) applyEqualSplit(companyId, product)
  }
}

/** The switch itself. Turning it on levels the shares; turning it off leaves
    every allowance exactly where the split last put it, as a starting point
    for the admin rather than a blank sheet. */
export function setSplitEqually({ companyId, product, enabled }) {
  db.prepare(`UPDATE companies SET ${SPLIT_COLUMN[product]} = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, companyId)
  if (enabled) applyEqualSplit(companyId, product)
  return splitsEqually(companyId, product)
}

/**
 * The seats an organization is paying for, one row each.
 *
 * Not a meter. A seat is a subscription, not a consumable — "60% of your seats
 * used" answers nothing an admin asked, and the questions they do have are
 * about dates and money: when did this start, when does it renew, what will be
 * charged. The included seat is named as such so the bill is legible.
 */
export function seatList(companyId) {
  const company = db.prepare(
    `SELECT seat_plan_since, seat_plan_pending, seat_plan_pending_at FROM companies WHERE id = ?`,
  ).get(companyId)

  const renewsAt = seatPeriodEnd(company?.seat_plan_since)
  const seats = seatRows(companyId)
  const atRisk = new Set(
    (company?.seat_plan_pending === null || company?.seat_plan_pending === undefined
      ? []
      : seatsAtRisk(companyId, company.seat_plan_pending)).map((seat) => seat.id),
  )

  return seats.map((seat, index) => {
    /* The first INCLUDED_SEATS accounts are the ones the plan comes with; the
       rest are subscribed. Ordered admin-first, so the included seat is the
       administrator unless somebody has more than one. */
    const included = index < INCLUDED_SEATS

    return {
      id: seat.id,
      name: [seat.first_name, seat.last_name].filter(Boolean).join(' ') || seat.username,
      username: seat.username,
      isAdmin: Boolean(seat.is_org_admin),
      included,
      /* Their own start, not the organization's: a colleague who joined in
         March did not have a seat in January. */
      since: seat.created_at ?? null,
      /*
       * One date. It was sent twice — once as the renewal and once as the next
       * charge — from the same value, so the two columns could never disagree
       * and the second only ever repeated the first.
       *
       * They would differ for a seat with a reduction scheduled: that date is
       * when it ends, and there is no charge coming at all. Saying so belongs
       * in `status`, which already carries it, rather than in a money column
       * that would have to print a date and mean the opposite.
       */
      renewsAt: included ? null : renewsAt,
      status: atRisk.has(seat.id) ? 'ending' : 'active',
    }
  })
}

export function walletOverview(company) {
  const balance = revealBalance(company.id)

  const used = companyRevealsUsed(company.id)

  return {
    balance,
    used,
    /* Everything the company has ever had available. Zero only before the
       complimentary grant lands, and the meter reads empty rather than
       dividing by it. */
    everHeld: used + balance,
    /* `lowBalance` and `thresholds` were here, for warnings that started on the
       way down. Only `exhausted` survives, because only zero is warned about. */
    exhausted: balance === 0,
    complimentary: COMPLIMENTARY_REVEALS,
    seats: seatEntitlement(company.id),
    /* One row per seat, for a table rather than a bar. */
    seatList: seatList(company.id),
    /* What the capacity bars are drawn from — see capacitySince. */
    capacity: {
      reveal: capacitySince(company.id, 'reveal'),
      triage: capacitySince(company.id, 'triage'),
    },
    splitEqually: {
      reveal: splitsEqually(company.id, 'reveal'),
      triage: splitsEqually(company.id, 'triage'),
    },
    autoReplenish: {
      // §12 — off unless an admin turned it on, and it names its pack.
      enabled: Boolean(company.auto_replenish_pack),
      pack: company.auto_replenish_pack ?? null,
    },
    /* What one more seat would cost per month, from wherever they are now —
       the question the "add a colleague" path actually raises. */
    nextSeat: seatPlanView((company?.purchased_seats ?? 0) + 1),
    /* The third product's balance, reported alongside the other two rather than
       from a route of its own — every screen that shows what an organization
       holds needs all three, and one of them arriving late is how a Triage
       count ends up disagreeing with itself between two panels. */
    triage: {
      balance: triageBalance(company.id),
      used: triageCvsUsed(company.id),
      launched: triagesLaunched(company.id),
      /* What the rail counts. Sent with the rest of the wallet rather than
         fetched separately, for the reason stated above this object: a count
         that arrives on its own is a count that disagrees with itself. */
      workspaces: triageWorkspaces(company.id),
      maxFiles: TRIAGE_MAX_FILES,
      /* No `complimentary` figure here. The welcome grant is already visible
         where it belongs — as a row in the ledger below, which the billing
         table renders by its note — and a field nobody reads is a field that
         will be wrong before anybody notices. */
    },
    ledger: ledgerEntries(company.id),
  }
}

/**
 * §12 — automatic replenishment, for reveals only.
 *
 * Never buys seats: adding a person is a deliberate administrative act, and
 * auto-buying capacity on somebody's behalf would be a surprise charge. The
 * function refuses a seat pack rather than trusting callers not to ask.
 */
export function setAutoReplenish({ companyId, packKey }) {
  if (packKey && !findRevealPack(packKey)) {
    throw new Error('Automatic replenishment can only be set to a Reveal Pack.')
  }

  db.prepare(`UPDATE companies SET auto_replenish_pack = ?, auto_replenish_at = ? WHERE id = ?`)
    .run(packKey ?? null, packKey ? new Date().toISOString() : null, companyId)

  return { enabled: Boolean(packKey), pack: packKey ?? null }
}
