/**
 * Check Availability — a recruiter asking whether an Orange candidate is still
 * looking, before deciding whether to spend a Reveal on them.
 *
 * The commercial point is that Reveals are scarce and freshness is uncertain
 * exactly where this button appears. Asking is free, tells the recruiter
 * nothing they did not already know about the candidate, and puts one question
 * to the candidate: are you currently open to opportunities.
 *
 * Two scopes, and keeping them apart is most of this file:
 *
 *   the question is GLOBAL      one candidate, one answer, one email. Five
 *                               recruiters asking in the same week must not
 *                               produce five near-identical emails, and the
 *                               answer is a fact about the candidate rather
 *                               than a reply to any one of them.
 *   the request is PER-RECRUITER each asker gets their own row, their own
 *                               pending entry and their own notification, and
 *                               one answer resolves all of them at once.
 *
 * Nothing here touches the wallet. A check consumes no Reveal, grants no
 * entitlement, and exposes no contact detail — see the route, which returns
 * only whether the request was registered.
 */
import crypto from 'node:crypto'

import db from './db.js'
import { activityStatus, issueCheckinToken, pendingCheckin } from './profiles.js'

/** How long a recruiter's question stays outstanding before it lapses. */
export const CHECK_LIFETIME_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whether this candidate can be asked at all.
 *
 * Orange only, which is the whole design: a Green candidate was here this month
 * and needs no reconfirming, and a hidden one is not in discovery to be asked
 * about. Returning the reason rather than a boolean so the route can say which
 * of the two it is.
 */
export function checkableState(candidate) {
  const activity = activityStatus(candidate)
  if (!activity) return { ok: false, reason: 'unknown' }
  if (activity.state === 'orange') return { ok: true, activity }
  return { ok: false, reason: activity.state, activity }
}

/** This recruiter's outstanding question about this candidate, if any. */
export function pendingCheck(recruiterId, candidateId) {
  return db.prepare(`
    SELECT * FROM availability_checks
    WHERE recruiter_id = ? AND candidate_id = ? AND resolved_at IS NULL
  `).get(recruiterId, candidateId) ?? null
}

/**
 * Whether the candidate already has an unanswered question in front of them.
 *
 * Any unanswered one counts, from any recruiter, and so does an outstanding
 * freshness reminder: all of them ask the same thing and all of them are
 * answered by the same link. This is the suppression the specification asks
 * for, and it is deliberately generous — the failure it prevents is a candidate
 * receiving four "are you still looking?" emails in a morning because four
 * recruiters happened to open the same search.
 */
export function alreadyAsked(candidateId, now = new Date()) {
  const outstanding = db.prepare(`
    SELECT 1 FROM availability_checks
    WHERE candidate_id = ? AND resolved_at IS NULL AND expires_at > ?
    LIMIT 1
  `).get(candidateId, now.toISOString())

  return Boolean(outstanding) || Boolean(pendingCheckin(candidateId, now))
}

/**
 * Register a recruiter's interest, and say whether the candidate needs asking.
 *
 * The caller sends the email; this decides whether there is one to send. Split
 * that way because sending is asynchronous and this runs inside a transaction
 * that must not be held open across it.
 *
 * The unique index on (recruiter_id, candidate_id) where resolved_at IS NULL is
 * what makes a double-click cost one row rather than two — checked here for a
 * civil answer, and enforced there for a correct one.
 */
export function requestAvailabilityCheck({ recruiterId, companyId, candidateId, now = new Date() }) {
  const existing = pendingCheck(recruiterId, candidateId)
  if (existing) return { ok: true, created: false, ask: false, check: existing }

  /* Read before the insert: this recruiter's own brand-new row would otherwise
     be the outstanding question that suppresses its own email. */
  const ask = !alreadyAsked(candidateId, now)

  const expiresAt = new Date(now.getTime() + CHECK_LIFETIME_DAYS * DAY_MS).toISOString()
  let check
  try {
    const info = db.prepare(`
      INSERT INTO availability_checks
        (candidate_id, recruiter_id, company_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(candidateId, recruiterId, companyId, now.toISOString(), expiresAt)
    check = db.prepare(`SELECT * FROM availability_checks WHERE id = ?`).get(info.lastInsertRowid)
  } catch (error) {
    /* The index caught a concurrent second click. Not an error to the caller:
       they asked for a pending check and there is one. */
    if (String(error.message).includes('UNIQUE')) {
      return { ok: true, created: false, ask: false, check: pendingCheck(recruiterId, candidateId) }
    }
    throw error
  }

  return { ok: true, created: true, ask, check }
}

/**
 * The candidate has answered. Resolve every question outstanding about them.
 *
 * Returns the rows so the caller can write to each recruiter. A single answer
 * settles all of them because the candidate answered the question, not the
 * recruiter: whoever was waiting is entitled to the same fact.
 *
 * Expired rows are left alone. A recruiter who asked seven weeks ago has
 * already been told the question lapsed, and reviving it now would put a
 * candidate into an Available Candidates list the recruiter has stopped
 * looking at.
 */
export function resolveAvailabilityChecks(candidateId, answer, now = new Date()) {
  const iso = now.toISOString()

  const waiting = db.prepare(`
    SELECT * FROM availability_checks
    WHERE candidate_id = ? AND resolved_at IS NULL AND expires_at > ?
  `).all(candidateId, iso)

  if (waiting.length === 0) return []

  db.prepare(`
    UPDATE availability_checks SET resolved_at = ?, outcome = ?
    WHERE candidate_id = ? AND resolved_at IS NULL AND expires_at > ?
  `).run(iso, answer, candidateId, iso)

  return waiting
}

/**
 * A fortnight with no answer, and the question lapses.
 *
 * Marked rather than deleted, so the recruiter's own record of having asked
 * survives it going unanswered. Nothing about the candidate changes: silence
 * here is not a "no", and their ordinary sixty-day lifecycle carries on
 * underneath entirely independently of this.
 */
export function expireAvailabilityChecks(now = new Date()) {
  return db.prepare(`
    UPDATE availability_checks SET resolved_at = ?, outcome = 'expired'
    WHERE resolved_at IS NULL AND expires_at <= ?
  `).run(now.toISOString(), now.toISOString()).changes
}

/**
 * The two system states, as candidate id lists for one recruiter.
 *
 * Recruiter-scoped rather than company-scoped, unlike ordinary folders. A
 * colleague did not ask this question and is not waiting on this answer, and
 * showing them somebody else's pending checks would misreport who is owed a
 * reply. The candidates themselves remain company-visible as they always were.
 */
export function availabilityStates(recruiterId, now = new Date()) {
  const iso = now.toISOString()

  const pending = db.prepare(`
    SELECT candidate_id, created_at, expires_at FROM availability_checks
    WHERE recruiter_id = ? AND resolved_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC
  `).all(recruiterId, iso)

  const available = db.prepare(`
    SELECT candidate_id, resolved_at FROM availability_checks
    WHERE recruiter_id = ? AND outcome = 'yes'
    ORDER BY resolved_at DESC
  `).all(recruiterId)

  return { pending, available }
}

/** A token for the availability email — the same yes/no the reminders use. */
export function availabilityToken(candidateId) {
  return issueCheckinToken(candidateId)
}

/** Unused elsewhere; kept so the module owns its own id generation if needed. */
export function reference() {
  return crypto.randomBytes(8).toString('hex')
}
