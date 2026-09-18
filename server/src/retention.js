/**
 * When Triage CVs are let go of.
 *
 * Nothing in this product has ever deleted an applicant's CV. There is one
 * daily timer; it runs the check-in sweep, the seat-expiry sweep and the
 * anonymous demo sweep, and none of them reads triage_applicants. The
 * boot-time orphan sweep explicitly protects Triage files. So a CV, its full
 * extracted text, and the applicant's name, email, phone and city are held
 * until a recruiter presses Delete — which until now meant deleting the whole
 * session, all or nothing.
 *
 * That was defensible while a Triage was a one-off report finished in an
 * afternoon. It is not defensible for a session designed to stay open for
 * weeks, because "as long as the Organization keeps the workspace" then means
 * "forever", about people who never heard of us and never agreed to anything.
 *
 * Two clocks, whichever comes first (Q6):
 *
 *   - 90 days after the session closes.
 *   - 12 months after the CV was uploaded, whatever the session is doing.
 *
 * The second one is the one that actually binds. Without it a session left
 * open indefinitely keeps everything indefinitely, which is the promise we
 * are trying to stop making.
 *
 * ---
 *
 * THIS DOES NOT DELETE ANYTHING unless TRIAGE_RETENTION_DELETES is on, and it
 * is off. Deleting other people's CVs on a schedule is the least reversible
 * thing this product can do; it runs in the open first, writing down exactly
 * what it would have removed, for long enough that somebody has read the logs
 * and agreed with them. There is no undo and no backup to restore from.
 */
import fs from 'node:fs'
import path from 'node:path'

import db, { UPLOAD_DIR } from './db.js'
import { TRIAGE, recount } from './triage.js'

const DAY = 86400000

/**
 * Every CV whose time is up, and which clock says so.
 *
 * Read-only. Returns rows rather than a count because the whole point of the
 * log-only period is that somebody can look at what it names and say "no,
 * not that one".
 */
export function dueForDeletion({ at = Date.now(), limit = 20000, triageId = null } = {}) {
  const closeDays = TRIAGE.retainAfterCloseDays
  const maxDays = TRIAGE.retainMaxDays

  if (closeDays <= 0 && maxDays <= 0) return []

  const nowIso = new Date(at).toISOString()
  const agedBefore = new Date(at - maxDays * DAY).toISOString()

  /*
   * The due-ness test is in the query, not in a loop over the first N rows.
   *
   * It used to scan `ORDER BY a.id LIMIT 5000` and filter in JavaScript. With
   * deletion switched off — the documented steady state, for as long as it
   * takes somebody to read the logs — nothing is ever removed, so that window
   * never slides: the moment the database held more than five thousand
   * applicants, row 5001 onward became invisible to the rule for ever, while
   * the sweep went on printing a number as though it were the whole picture.
   * The log the whole log-only period exists to produce was quietly partial.
   *
   * It also made `--triage 42` answer "nothing is past its date" for any
   * session whose rows sat past that id — a false negative on the exact
   * command an erasure request would be answered with, because the scope
   * filter was applied after the limit rather than inside it.
   *
   * The limit stays as a backstop against one pass trying to hold a million
   * rows in memory, and the caller is told when it bites.
   */
  const closedClock = closeDays > 0
    ? `(
        COALESCE(t.lifecycle,
          CASE WHEN t.status IN ('completed', 'failed') THEN 'closed' ELSE 'open' END
        ) = 'closed'
        AND COALESCE(t.purge_after, DATETIME(COALESCE(t.closed_at, t.completed_at, t.updated_at),
                                             '+' || ? || ' days')) <= ?
      )`
    : '0'

  const agedClock = maxDays > 0 ? `(a.created_at <= ?)` : '0'

  const params = []
  if (closeDays > 0) params.push(closeDays, nowIso)
  if (maxDays > 0) params.push(agedBefore)
  if (triageId !== null) params.push(triageId)
  params.push(limit)

  const rows = db.prepare(`
    SELECT a.id AS id, a.triage_id AS triageId, a.stored_name AS storedName,
           a.display_name AS name, a.created_at AS uploadedAt,
           t.company_id AS companyId, t.status AS status,
           t.lifecycle AS lifecycle, t.closed_at AS closedAt,
           COALESCE(t.purge_after, DATETIME(COALESCE(t.closed_at, t.completed_at, t.updated_at),
                                            '+' || ${closeDays} || ' days')) AS purgeAfter
    FROM triage_applicants a
    JOIN triages t ON t.id = a.triage_id
    WHERE (${closedClock} OR ${agedClock})
      ${triageId === null ? '' : 'AND a.triage_id = ?'}
    ORDER BY a.id
    LIMIT ?
  `).all(...params)

  return rows.map((row) => {
    /*
     * Which clock, decided by which date is EARLIER, not by which test
     * happened to be true.
     *
     * It named the twelve-month clock whenever that one was past, which is
     * the wrong answer for every session closed early in its life: a CV
     * uploaded on day 0 in a session closed on day 30 is due on day 120 by
     * the close clock and day 365 by the age clock, and the log said "twelve
     * months since it was uploaded". The reason string is the thing this
     * whole log-only period exists to produce.
     */
    const agedAt = row.uploadedAt ? Date.parse(row.uploadedAt) + maxDays * DAY : Infinity
    const closedAt = row.purgeAfter ? Date.parse(row.purgeAfter) : Infinity

    const aged = maxDays > 0 && agedAt <= at
    const closed = closeDays > 0 && closedAt <= at

    return {
      ...row,
      because: (aged && (!closed || agedAt <= closedAt))
        ? 'twelve months since it was uploaded'
        : 'ninety days since the session closed',
    }
  })
}

/**
 * Runs the rule.
 *
 * `deletes` defaults to the setting, which is off. With it off this is a
 * report: it returns exactly what it would have removed and touches nothing.
 * With it on it removes the rows and their files, and nothing else — the
 * session, its counters and its ledger line all stay, because the billing
 * record is not personal data and destroying it would make the organization's
 * accounts stop reconciling.
 */
export function runRetention({
  at = Date.now(), deletes = TRIAGE.retentionDeletes, limit = 20000, triageId = null,
} = {}) {
  /* Scoped in the query, not filtered afterwards — a filter applied to a
     limited scan answers "nothing" for any session past the limit. */
  const due = dueForDeletion({ at, limit, triageId })

  const summary = {
    considered: due.length,
    deleted: 0,
    filesRemoved: 0,
    sessions: [...new Set(due.map((row) => row.triageId))],
    wouldDelete: due,
    deletedAnything: false,
  }

  if (!deletes || due.length === 0) return summary

  const ids = due.map((row) => row.id)

  db.transaction(() => {
    const remove = db.prepare(`DELETE FROM triage_applicants WHERE id = ?`)
    for (const id of ids) remove.run(id)
  })()

  summary.deleted = ids.length
  summary.deletedAnything = true

  /*
   * The counters, immediately.
   *
   * The manual script did this by hand and the daily sweep did not, so
   * turning the flag on would have left every affected session reporting CVs
   * that no longer exist — "11 of 10 applicants fully analysed", the exact
   * shape of bug recount exists to prevent. Done here so both callers get it.
   */
  for (const sessionId of summary.sessions) recount(sessionId)

  for (const row of due) {
    if (!row.storedName) continue
    try {
      fs.unlinkSync(path.join(UPLOAD_DIR, row.storedName))
      summary.filesRemoved += 1
    } catch {
      /* Already gone, or never written. Not worth failing a sweep over, and
         the row it belonged to is the thing that mattered. */
    }
  }

  return summary
}

/**
 * The daily pass, which reports and stops.
 *
 * Deliberately noisy: a sweep that would delete two hundred CVs and says so
 * in one line nobody reads is the same as a sweep that says nothing. It names
 * the sessions and the reason, so the log is something a person can act on.
 */
export function retentionSweep({ at = Date.now(), limit = 20000 } = {}) {
  const result = runRetention({ at, limit })

  if (result.considered === 0) return result

  /* Said out loud rather than left to be inferred. A report that stopped at
     its own backstop and did not mention it is worse than no report. */
  if (result.considered >= limit) {
    console.warn(`  retention: the scan stopped at its ${limit}-row limit — `
      + 'there may be more past their date than this reports')
  }

  const byReason = result.wouldDelete.reduce((acc, row) => {
    acc[row.because] = (acc[row.because] ?? 0) + 1
    return acc
  }, {})

  if (result.deletedAnything) {
    console.log(`  retention: deleted ${result.deleted} Triage CV(s) across ${result.sessions.length} session(s)`)
  } else {
    console.log(`  retention (log only): ${result.considered} Triage CV(s) are past their date `
      + `across ${result.sessions.length} session(s) — nothing was deleted`)
    console.log(`    set TRIAGE_RETENTION_DELETES=1 to let this act`)
  }

  for (const [reason, n] of Object.entries(byReason)) {
    console.log(`    ${n} · ${reason}`)
  }
  console.log(`    sessions: ${result.sessions.slice(0, 20).join(', ')}`
    + (result.sessions.length > 20 ? ` and ${result.sessions.length - 20} more` : ''))

  return result
}
