import db from './db.js'
import {
  candidatesDueReminder,
  hideStaleProfiles,
  issueCheckinToken,
  recordReminderSent,
} from './profiles.js'
import { expireAvailabilityChecks } from './availability.js'
import {
  sendAutoHiddenEmail,
  sendFreshnessReminder,
  sendSeatExpiryEmail,
} from './notify.js'
import { notifySlack, stamp } from './slack.js'
import { track } from './analytics.js'
import { seatPeriodEnd } from './wallet.js'

/**
 * One pass of the freshness lifecycle: hide whoever has run out of days, then
 * send the reminder each remaining candidate's silence has earned.
 *
 * Hiding runs first so that a candidate crossing day 60 on this pass is not
 * also sent a "you have 2 days left" reminder in the same minute, in an order
 * nobody controls.
 *
 * Every step is idempotent, and that is not incidental — this is called on
 * every server boot as well as on a daily timer, so three restarts in an
 * afternoon must produce zero extra email. Hiding only fires on the crossing;
 * reminders only fire when the stage the clock has reached exceeds the stage
 * already recorded as sent.
 */
export async function runCheckinSweep({ quiet = false } = {}) {
  const { hidden } = hideStaleProfiles()

  for (const candidate of hidden) {
    track('candidate_auto_hidden', { actorType: 'candidate', actorId: candidate.id })

    if (candidate.email) {
      try {
        await sendAutoHiddenEmail({
          to: candidate.email,
          name: candidate.first_name ?? candidate.name,
          token: issueCheckinToken(candidate.id),
        })
      } catch (error) {
        console.warn(`  auto-hidden email failed for candidate ${candidate.id}: ${error.message}`)
      }
    }

    /*
     * Churn, so it goes to Slack — but only this kind. A candidate who chooses
     * to hide has exercised a control the product offers them, and reporting
     * that internally would be surveillance rather than a signal.
     */
    notifySlack('Candidate automatically hidden — 60 days inactive', [
      `${candidate.name ?? candidate.first_name} · ${candidate.email ?? '(no email)'}`,
      `Last activity: ${candidate.last_seen_at ?? candidate.last_confirmed_active ?? candidate.created_at ?? 'never'}`,
      stamp(),
    ])
  }

  const due = candidatesDueReminder()

  let sent = 0
  for (const candidate of due) {
    /*
     * Nothing to send to, and the stage is recorded anyway.
     *
     * Otherwise a candidate with no address is re-selected by every sweep for
     * the rest of the sequence, and the log reports work that never happened.
     * They are still hidden on day 60 by the pass above, which is the part that
     * does not depend on an inbox.
     */
    if (!candidate.email) {
      recordReminderSent(candidate.id, candidate.stage)
      continue
    }

    try {
      await sendFreshnessReminder({
        to: candidate.email,
        name: candidate.first_name ?? candidate.name,
        token: issueCheckinToken(candidate.id),
        stage: candidate.stage,
        daysRemaining: candidate.daysRemaining,
      })
      /* After the send, so a throw leaves the stage unrecorded and the next
         sweep tries again rather than skipping the candidate silently. */
      recordReminderSent(candidate.id, candidate.stage)
      sent += 1
    } catch (error) {
      console.warn(`  reminder failed for candidate ${candidate.id}: ${error.message}`)
    }
  }

  /* Recruiter-side housekeeping on the same pass: a question nobody answered
     stops being pending after a fortnight. */
  const expiredChecks = expireAvailabilityChecks()

  if (!quiet && (sent > 0 || hidden.length > 0 || expiredChecks > 0)) {
    console.log(`  freshness: ${sent} reminder(s), ${hidden.length} hidden, `
      + `${expiredChecks} availability check(s) expired`)
  }

  return { sent, hidden: hidden.length, due: due.length, expiredChecks }
}

/**
 * A month's notice before a seat subscription renews.
 *
 * Sent once per period, which is what the analytics row is doing here: the
 * sweep runs daily, the window it is looking at is a fortnight wide, and
 * without a record of having written we would send the same warning fourteen
 * times. Keyed on the renewal date, so the next period warns again.
 */
export async function runSeatExpirySweep({ quiet = false } = {}) {
  const companies = db.prepare(`
    SELECT id, name, seat_plan_since, purchased_seats FROM companies
    WHERE purchased_seats > 0 AND seat_plan_since IS NOT NULL
  `).all()

  const soon = Date.now() + 30 * 24 * 60 * 60 * 1000
  let sent = 0

  for (const company of companies) {
    const renewsAt = seatPeriodEnd(company.seat_plan_since)
    if (!renewsAt) continue

    const due = new Date(renewsAt).getTime()
    /* A month out, give or take a day either side of the sweep's cadence. */
    if (due > soon || due < Date.now()) continue

    const already = db.prepare(`
      SELECT 1 FROM analytics_events
      WHERE name = 'seat_expiry_warned' AND actor_id = ? AND props LIKE ?
      LIMIT 1
    `).get(company.id, `%${renewsAt}%`)
    if (already) continue

    const admin = db.prepare(`
      SELECT first_name, email FROM recruiters
      WHERE company_id = ? AND is_active = 1
      ORDER BY is_org_admin DESC, id LIMIT 1
    `).get(company.id)

    track('seat_expiry_warned', { actorType: 'company', actorId: company.id, renewsAt })
    if (!admin?.email) continue

    try {
      await sendSeatExpiryEmail({
        to: admin.email,
        name: admin.first_name,
        expiryDate: new Date(renewsAt).toISOString().slice(0, 10),
      })
      sent += 1
    } catch (error) {
      console.warn(`  seat expiry email failed for company ${company.id}: ${error.message}`)
    }
  }

  if (!quiet && sent > 0) console.log(`  seat expiry: ${sent} warned`)
  return { sent }
}
