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
import { TRIAGE, lifecycleOf } from './triage.js'

const DAY = 86400000

/**
 * Every CV whose time is up, and which clock says so.
 *
 * Read-only. Returns rows rather than a count because the whole point of the
 * log-only period is that somebody can look at what it names and say "no,
 * not that one".
 */
export function dueForDeletion({ at = Date.now(), limit = 5000 } = {}) {
  const closeDays = TRIAGE.retainAfterCloseDays
  const maxDays = TRIAGE.retainMaxDays

  const rows = db.prepare(`
    SELECT a.id AS id, a.triage_id AS triageId, a.stored_name AS storedName,
           a.display_name AS name, a.created_at AS uploadedAt,
           t.company_id AS companyId, t.status AS status,
           t.lifecycle AS lifecycle, t.closed_at AS closedAt, t.purge_after AS purgeAfter
    FROM triage_applicants a
    JOIN triages t ON t.id = a.triage_id
    ORDER BY a.id
    LIMIT ?
  `).all(limit)

  const due = []

  for (const row of rows) {
    /*
     * The stored date, not a recomputed one.
     *
     * purge_after is written when the session closes, so changing the
     * retention setting afterwards cannot move the date on sessions already
     * closed under the old rule — in either direction. A CV whose deletion
     * date has been promised for the 3rd should not quietly become the 90th
     * because somebody widened a number.
     */
    const closed = lifecycleOf(row) === 'closed'
      && closeDays > 0
      && row.purgeAfter
      && Date.parse(row.purgeAfter) <= at

    const aged = maxDays > 0
      && row.uploadedAt
      && Date.parse(row.uploadedAt) + maxDays * DAY <= at

    if (!closed && !aged) continue

    due.push({
      ...row,
      /* Both can be true. Naming the earlier one is what makes the log
         readable: "aged out" and "session closed in March" are different
         conversations with whoever asks why a CV is gone. */
      because: aged ? 'twelve months since it was uploaded' : 'ninety days since the session closed',
    })
  }

  return due
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
  at = Date.now(), deletes = TRIAGE.retentionDeletes, limit = 5000, triageId = null,
} = {}) {
  const all = dueForDeletion({ at, limit })
  const due = triageId === null ? all : all.filter((row) => row.triageId === triageId)

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
export function retentionSweep({ at = Date.now() } = {}) {
  const result = runRetention({ at })

  if (result.considered === 0) return result

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
