import crypto from 'node:crypto'

import db from './db.js'
import { getConcept } from './matching/taxonomy.js'
import { forgetCandidate } from './analytics.js'
import { matchingBlockedNames } from './companyMatch.js'
import { DOCUMENT_SLOT_KEYS, normalizeCompanyName } from './schema.js'

/**
 * Fields the candidate may correct.
 *
 * `summary_masked`, `current_title_masked` and `employment_history_masked` used
 * to be in here, as the candidate's safety net for a §6.5 masking pass. The
 * extractor never produced them — normalizeExtraction returns eight fixed keys
 * and the JSON schema is closed — so every profile carried three permanently
 * null keys out to the candidate's own client, and the "correct a masking
 * miss" path they existed for could not be reached because there was never a
 * masked value to correct.
 *
 * Masking was replaced by withholding: a recruiter does not see a redacted
 * summary before a Reveal, they see no summary. See extracted_profiles in
 * schema.js.
 */
export const EXTRACTED_FIELDS = [
  'current_title', 'industry', 'seniority',
  'skills', 'languages', 'education', 'employment_history', 'summary',
]

/**
 * The canonical candidate activity clock.
 *
 * One definition, used by the reminder schedule, the Green/Orange badge, the
 * automatic hide and every availability check. The point of putting it here and
 * deriving everything from it is that these cannot disagree: a recruiter seeing
 * "active this month" while the sweep is counting down to hiding that same
 * profile is the failure this replaces.
 *
 * What counts as activity:
 *
 *   creating the account          the clock starts at day 0
 *   signing in to the portal      the strongest signal there is, and the only
 *                                 one most candidates ever produce
 *   answering yes to a reminder   an explicit statement, not just a visit
 *   answering yes to a recruiter  the same statement, differently prompted
 *
 * What does not: an email being delivered, opened or clicked through to a page
 * without answering; a recruiter viewing, revealing or asking about them. Those
 * are somebody else's activity, and counting them would let a candidate look
 * fresh because they are popular rather than because they are still looking.
 *
 * Note what this replaces. Signing in used to be recorded and deliberately NOT
 * allowed to move the freshness state; only the monthly email could. That rule
 * is gone: a candidate who reads their messages every week is plainly still
 * here, and the whole sequence below now starts from silence rather than from
 * an unanswered email.
 */
const FRESH_DAYS = 30
const HIDE_DAYS = 60

/*
 * When the five reminders go out, in days of silence.
 *
 * The list is the schedule. Nothing else hard-codes a date, and the countdown
 * printed in each email is HIDE_DAYS minus the stage — 30, 23, 16, 9, 2 — so a
 * change here moves the emails and the sentences inside them together.
 */
const REMINDER_STAGES = [30, 37, 44, 51, 58]

/*
 * How long a yes/no link stays clickable.
 *
 * Long enough that a reminder is still answerable when the next one arrives a
 * week later, short enough that a link from a previous episode of silence
 * cannot be clicked months afterwards into a state the candidate has moved on
 * from. It is not the reminder cadence and not the hiding threshold, so it has
 * its own name rather than borrowing one of theirs.
 */
const CHECKIN_TOKEN_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The most recent thing the candidate did, whatever it was.
 *
 * COALESCE would be wrong here: a candidate can have confirmed in March and
 * signed in last week, and the clock has to follow the later of the two.
 */
export function lastActivityAt(candidate) {
  const times = [candidate?.created_at, candidate?.last_seen_at, candidate?.last_confirmed_active]
    .filter(Boolean)
    .map((iso) => new Date(iso).getTime())
    .filter((ms) => Number.isFinite(ms))

  return times.length ? new Date(Math.max(...times)).toISOString() : null
}

/** Whole days of silence. Floored, so day 29.9 is still day 29 and still Green. */
export function daysInactive(candidate, now = new Date()) {
  const last = lastActivityAt(candidate)
  if (!last) return 0
  return Math.max(0, Math.floor((now.getTime() - new Date(last).getTime()) / DAY_MS))
}

/**
 * The reminder that silence of this length has earned, or 0 for none yet.
 *
 * The highest stage reached rather than the next one due, which is what lets a
 * server that was down for a fortnight send one email carrying the right
 * countdown instead of four in a row carrying stale ones.
 */
export function reminderStageFor(days) {
  let stage = 0
  for (const day of REMINDER_STAGES) if (days >= day) stage = day
  return stage
}

/** How long until the profile is hidden. Never negative; 0 means today. */
export function daysUntilHidden(days) {
  return Math.max(0, HIDE_DAYS - days)
}

// ------------------------------------------------------------- documents ---

export { DOCUMENT_SLOT_KEYS as DOCUMENT_SLOTS }

export function saveDocument({ candidateId, slot, fileName, storedName, fileSize, mimeType, extractedText }) {
  const previous = getDocument(candidateId, slot)

  db.prepare(`
    INSERT INTO documents (candidate_id, slot, file_name, stored_name, file_size, mime_type, extracted_text, uploaded_at)
    VALUES (@candidateId, @slot, @fileName, @storedName, @fileSize, @mimeType, @extractedText, @uploadedAt)
    ON CONFLICT (candidate_id, slot) DO UPDATE SET
      file_name = excluded.file_name,
      stored_name = excluded.stored_name,
      file_size = excluded.file_size,
      mime_type = excluded.mime_type,
      extracted_text = excluded.extracted_text,
      uploaded_at = excluded.uploaded_at
  `).run({
    candidateId, slot, fileName, storedName,
    fileSize: fileSize ?? null,
    mimeType: mimeType ?? null,
    extractedText: extractedText ?? null,
    uploadedAt: new Date().toISOString(),
  })

  // Returned so the caller can unlink the file the row used to point at.
  return previous?.stored_name ?? null
}

export function getDocument(candidateId, slot) {
  return db.prepare(
    `SELECT * FROM documents WHERE candidate_id = ? AND slot = ?`,
  ).get(candidateId, slot) ?? null
}

export function listDocuments(candidateId) {
  return db.prepare(`
    SELECT id, slot, file_name, file_size, mime_type, uploaded_at
    FROM documents WHERE candidate_id = ? ORDER BY slot
  `).all(candidateId)
}

/**
 * candidate id -> the slots they filled, for badging and filtering results.
 *
 * Narrowed to the ids asked for where the caller knows them. Unfiltered it
 * reads every row of the documents table — five per candidate, every candidate
 * on the platform — to badge the twenty-five on one page of results.
 */
export function documentSlotsByCandidate(ids = null) {
  const wanted = ids ? [...new Set(ids)].filter((id) => Number.isInteger(id)) : null
  if (wanted && !wanted.length) return {}

  const map = {}
  const rows = wanted
    ? db.prepare(
      `SELECT candidate_id, slot FROM documents WHERE candidate_id IN (${wanted.map(() => '?').join(', ')})`,
    ).all(...wanted)
    : db.prepare(`SELECT candidate_id, slot FROM documents`).all()

  for (const row of rows) (map[row.candidate_id] ??= []).push(row.slot)
  return map
}

export function deleteDocument(candidateId, slot) {
  const existing = getDocument(candidateId, slot)
  if (!existing) return null
  db.prepare(`DELETE FROM documents WHERE candidate_id = ? AND slot = ?`).run(candidateId, slot)
  return existing.stored_name
}

/** Slot 1's plain text — what the search layer and embeddings read. */
export function cvText(candidateId) {
  return getDocument(candidateId, 'cv')?.extracted_text ?? ''
}

/**
 * §3.1 — every matching-relevant document, not just the CV.
 *
 * A cover letter or a recommendation often carries what a CV omits: why they
 * moved, what they actually led, a language nobody listed. Each is labelled
 * with its slot so extraction can weigh a claim by where it came from, and so
 * evidence can later say which document supports a conclusion.
 *
 * The CV always comes first and is never truncated away — supporting material
 * enriches the picture, it does not replace the primary source.
 */
export function matchingDocumentText(candidateId, { maxCharsPerDocument = 20000 } = {}) {
  /*
   * Read here rather than through listDocuments, which deliberately returns
   * metadata only — the extracted text of someone's CV is not something to
   * hand out by default, and widening that query would leak it into every
   * caller that just wanted a filename.
   */
  const documents = db.prepare(
    `SELECT slot, extracted_text FROM documents WHERE candidate_id = ?`,
  ).all(candidateId)

  const order = ['cv', ...DOCUMENT_SLOT_KEYS.filter((slot) => slot !== 'cv')]

  return order
    .map((slot) => {
      const doc = documents.find((entry) => entry.slot === slot)
      const text = String(doc?.extracted_text ?? '').trim()
      if (!text) return null
      return `<document slot="${slot}">\n${text.slice(0, maxCharsPerDocument)}\n</document>`
    })
    .filter(Boolean)
    .join('\n\n')
}

// ------------------------------------------------- extraction + overrides ---

export function saveExtraction(candidateId, extraction) {
  const { source, model_version: modelVersion, note, usage, ...fields } = extraction

  db.prepare(`
    INSERT INTO extracted_profiles (candidate_id, fields, source, model_version, extracted_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (candidate_id) DO UPDATE SET
      fields = excluded.fields,
      source = excluded.source,
      model_version = excluded.model_version,
      extracted_at = excluded.extracted_at
  `).run(candidateId, JSON.stringify(fields), source, modelVersion ?? null, new Date().toISOString())
}

export function getExtraction(candidateId) {
  const row = db.prepare(`SELECT * FROM extracted_profiles WHERE candidate_id = ?`).get(candidateId)
  if (!row) return null
  return { ...safeParse(row.fields, {}), source: row.source, model_version: row.model_version, extracted_at: row.extracted_at }
}

/**
 * Records a correction. Storing the override separately is what lets us measure
 * how often candidates fix what Claude extracted — the brief's extraction
 * quality metric.
 */
export function setOverride(candidateId, field, value) {
  if (!EXTRACTED_FIELDS.includes(field)) return false

  db.prepare(`
    INSERT INTO profile_overrides (candidate_id, field, value, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (candidate_id, field) DO UPDATE SET
      value = excluded.value, updated_at = excluded.updated_at
  `).run(candidateId, field, JSON.stringify(value ?? null), new Date().toISOString())

  return true
}

export function getOverrides(candidateId) {
  const rows = db.prepare(`SELECT field, value FROM profile_overrides WHERE candidate_id = ?`).all(candidateId)
  return Object.fromEntries(rows.map((row) => [row.field, safeParse(row.value, null)]))
}

/**
 * The profile the rest of the system reads: the candidate's correction where one
 * exists, otherwise what was extracted. `corrected` names which fields the
 * candidate changed, so the UI can show provenance.
 */
export function effectiveProfile(candidateId) {
  const extracted = getExtraction(candidateId)
  const overrides = getOverrides(candidateId)

  const fields = {}
  for (const field of EXTRACTED_FIELDS) {
    fields[field] = field in overrides ? overrides[field] : (extracted?.[field] ?? null)
  }

  return {
    ...fields,
    corrected: Object.keys(overrides),
    extractionSource: extracted?.source ?? null,
    extractedAt: extracted?.extracted_at ?? null,
  }
}

// ------------------------------------------------------ blocked companies ---

export function setBlockedCompanies(candidateId, names) {
  db.prepare(`DELETE FROM blocked_companies WHERE candidate_id = ?`).run(candidateId)

  const insert = db.prepare(`
    INSERT OR IGNORE INTO blocked_companies (candidate_id, raw_name, normalized, created_at)
    VALUES (?, ?, ?, ?)
  `)
  const now = new Date().toISOString()

  for (const raw of names) {
    const trimmed = String(raw ?? '').trim()
    const normalized = normalizeCompanyName(trimmed)
    if (trimmed && normalized) insert.run(candidateId, trimmed, normalized, now)
  }
}

export function getBlockedCompanies(candidateId) {
  return db.prepare(
    `SELECT raw_name FROM blocked_companies WHERE candidate_id = ? ORDER BY raw_name`,
  ).all(candidateId).map((row) => row.raw_name)
}

/**
 * Candidate ids that have blocked this organisation. Applied at query time so a
 * candidate who adds a blocker is hidden from that employer immediately.
 */
/**
 * The same question asked the way every search path has it: by recruiter.
 *
 * The blocklist is stored against a normalised company name, and a search knows
 * a recruiter id — so every caller would otherwise have to join recruiters to
 * companies itself and remember to normalise. One of them would forget, and a
 * candidate who asked not to be seen by their employer would be seen by them.
 */
export function candidatesBlockingRecruiter(recruiterId) {
  const org = db.prepare(`
    SELECT c.normalized_name AS normalized, c.name AS name
    FROM recruiters r JOIN companies c ON c.id = r.company_id
    WHERE r.id = ?
  `).get(recruiterId)

  /*
   * The registered name is the fallback, and it matters.
   *
   * normalized_name is a derived column that was filled only by a backfill at
   * boot, so rows written between two restarts hold null in it. Reading the
   * name a company actually registered under means a missing derivation cannot
   * quietly turn every block off; candidatesBlocking normalises what it is
   * given either way.
   */
  return candidatesBlocking(org?.normalized || org?.name || null)
}

/**
 * Everyone who blocked a company that this organisation's name corresponds to.
 *
 * Exact equality was the whole test until now, which meant a candidate who
 * wrote "KPMG" was still visible to "KPMG Israel" — the two normalise to
 * different strings, and the candidate had no way to know they had to guess the
 * registered spelling. Matching is layered in companyMatch.js instead.
 *
 * The walk is over DISTINCT normalised names rather than over rows, so its cost
 * follows the number of different companies anybody has blocked rather than the
 * number of people who blocked them.
 */
export function candidatesBlocking(orgName) {
  const normalizedOrg = normalizeCompanyName(orgName)
  if (!normalizedOrg) return new Set()

  const names = db.prepare(`SELECT DISTINCT normalized FROM blocked_companies`)
    .all().map((row) => row.normalized)

  const matched = matchingBlockedNames(names, normalizedOrg)
  if (matched.length === 0) return new Set()

  const rows = db.prepare(
    `SELECT candidate_id FROM blocked_companies WHERE normalized IN (${matched.map(() => '?').join(', ')})`,
  ).all(...matched)

  return new Set(rows.map((row) => row.candidate_id))
}

/**
 * The people this viewer must not be shown, whoever the viewer is.
 *
 * One function so that no caller has to remember the public demonstration is a
 * different case. Recruiter ids are AUTOINCREMENT from 1, so anything else is
 * the anonymous demonstration, which has no organisation to compare a blocklist
 * against and therefore withholds everyone who blocked anybody.
 */
export function candidatesHiddenFrom(recruiterId) {
  return recruiterId > 0
    ? candidatesBlockingRecruiter(recruiterId)
    : candidatesBlockingAnyone()
}

/**
 * Everyone who has blocked anybody at all.
 *
 * For the public demonstration, which has no organisation to match a blocklist
 * against: an anonymous visitor could be from any company, including the one a
 * candidate hid from. Withholding the whole set is the only honest reading of
 * "hide me from these companies" on a surface where the viewer is unknown.
 */
export function candidatesBlockingAnyone() {
  return new Set(
    db.prepare(`SELECT DISTINCT candidate_id FROM blocked_companies`).all()
      .map((row) => row.candidate_id),
  )
}

// ----------------------------------------------------------- view events ---

/**
 * Append only. org_name and recruiter_name are denormalised so the record
 * survives the recruiter or company being deleted — the brief needs this
 * history intact years later.
 */
export function recordViewEvent({ candidateId, recruiter, eventType }) {
  db.prepare(`
    INSERT INTO view_events (candidate_id, recruiter_id, company_id, org_name, recruiter_name, event_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    recruiter?.id ?? null,
    recruiter?.company_id ?? null,
    recruiter?.company_name ?? 'unknown',
    [recruiter?.first_name, recruiter?.last_name].filter(Boolean).join(' ') || null,
    eventType,
    new Date().toISOString(),
  )
}

/**
 * What the candidate sees for free: counts only. Identities are gated behind the
 * future paid tier, so this deliberately returns no recruiter names.
 */
export function viewSummary(candidateId) {
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT recruiter_id) AS recruiters,
      COUNT(DISTINCT company_id)   AS companies,
      COUNT(*)                     AS events,
      MAX(created_at)              AS last_at
    FROM view_events
    WHERE candidate_id = ? AND event_type = 'card_expand'
  `).get(candidateId)

  const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const recent = db.prepare(`
    SELECT COUNT(DISTINCT recruiter_id) AS recruiters
    FROM view_events
    WHERE candidate_id = ? AND event_type = 'card_expand' AND created_at >= ?
  `).get(candidateId, week)

  /*
   * Reveals, which is what the candidate is actually shown.
   *
   * A card opening in a results list is a recruiter reading, and reading is not
   * an event worth telling somebody about — it moved a number they cannot act
   * on every time anyone scrolled past them. A reveal is different: it is a
   * deliberate step that hands over their surname, email and phone, and it is
   * the moment a company genuinely has their details.
   *
   * Counted by company rather than by recruiter, because that is the unit the
   * access is granted in — see hasRevealed, which is company-scoped. One
   * recruiter at Acme revealing means Acme has them, not that one person does.
   */
  const reveals = db.prepare(`
    SELECT
      COUNT(*)                   AS recruiters,
      COUNT(DISTINCT company_id) AS companies,
      MAX(created_at)            AS last_at
    FROM reveals WHERE candidate_id = ?
  `).get(candidateId)

  return {
    recruiters: row.recruiters,
    companies: row.companies,
    events: row.events,
    // `views` is the same number as `events` under the name the portal and the
    // API tests have always used.
    views: row.events,
    lastViewedAt: row.last_at,
    recruitersThisWeek: recent.recruiters,
    contactReveals: reveals.recruiters,
    revealedCompanies: reveals.companies,
    lastRevealedAt: reveals.last_at,
  }
}

// -------------------------------------------------------- contact reveals ---

/**
 * Has anyone at this company revealed them?
 *
 * Company-scoped rather than recruiter-scoped: see revealedCandidateIds. The
 * argument is a company id — passing a recruiter id here would silently answer
 * a different question, which is why the parameter is named for what it is.
 */
export function hasRevealed(companyId, candidateId) {
  return Boolean(db.prepare(
    `SELECT 1 FROM reveals WHERE company_id = ? AND candidate_id = ?`,
  ).get(companyId, candidateId))
}

/** Idempotent: re-revealing the same candidate never charges twice. */
export function recordReveal({ recruiterId, candidateId, companyId }) {
  const info = db.prepare(`
    INSERT OR IGNORE INTO reveals (recruiter_id, candidate_id, company_id, created_at)
    VALUES (?, ?, ?, ?)
  `).run(recruiterId, candidateId, companyId, new Date().toISOString())

  return info.changes > 0
}

/**
 * Reveals belong to the company, not to the person who spent one.
 *
 * A colleague opening the same profile is not a second piece of information
 * changing hands — the company already holds it — so charging again would be
 * charging twice for one disclosure. The row still records which recruiter
 * revealed, so the audit trail and the billing history stay answerable.
 */
export function revealedCandidateIds(companyId) {
  return new Set(db.prepare(
    `SELECT candidate_id FROM reveals WHERE company_id = ?`,
  ).all(companyId).map((row) => row.candidate_id))
}

/** Who at this company revealed them, and when. Null if nobody has. */
/**
 * The industries this person has worked in.
 *
 * Canonical concept labels, never the raw_label beside them: that is free text
 * the extractor wrote out of the CV and has been seen to carry things like
 * "Backend engineer - Tel Aviv". A fixed vocabulary is the difference between a
 * field that cannot leak an identity and one that merely has not yet — which
 * matters here because this is shown before the reveal.
 */
export function industriesFor(candidateId) {
  /* DISTINCT because the labels are keyed by profile version as well as by
     concept: a candidate whose CV has been re-read carries the same industry
     once per version, and the list would say "Finance" twice. */
  const rows = db.prepare(`
    SELECT concept_id, MAX(confidence) AS confidence
    FROM candidate_taxonomy_labels
    WHERE candidate_id = ? AND dimension = 'industry'
    GROUP BY concept_id
    ORDER BY confidence DESC
    LIMIT 6
  `).all(candidateId)

  return rows.map((row) => getConcept(row.concept_id)?.label).filter(Boolean)
}

export function revealedBy(companyId, candidateId) {
  const row = db.prepare(`
    SELECT r.created_at, rec.first_name, rec.last_name, rec.id AS recruiter_id
    FROM reveals r
    LEFT JOIN recruiters rec ON rec.id = r.recruiter_id
    WHERE r.company_id = ? AND r.candidate_id = ?
    ORDER BY r.created_at LIMIT 1
  `).get(companyId, candidateId)

  if (!row) return null

  return {
    recruiterId: row.recruiter_id,
    // The account may since have been deleted; the reveal still happened.
    name: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'a former colleague',
    at: row.created_at,
  }
}

/** Every revealed candidate at this company, with who revealed them. */
export function revealIndex(companyId) {
  const rows = db.prepare(`
    SELECT r.candidate_id, r.created_at, r.recruiter_id, rec.first_name, rec.last_name
    FROM reveals r
    LEFT JOIN recruiters rec ON rec.id = r.recruiter_id
    WHERE r.company_id = ?
  `).all(companyId)

  const index = new Map()
  for (const row of rows) {
    if (index.has(row.candidate_id)) continue
    index.set(row.candidate_id, {
      /* Carried so the list can say "me" rather than the reader's own name
         back at them — the same id revealedBy() has always returned. */
      recruiterId: row.recruiter_id,
      name: [row.first_name, row.last_name].filter(Boolean).join(' ') || 'a former colleague',
      at: row.created_at,
    })
  }
  return index
}

export function revealCountSince(recruiterId, sinceIso) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM reveals WHERE recruiter_id = ? AND created_at >= ?`,
  ).get(recruiterId, sinceIso).n
}

// ---------------------------------------------------------- scoring audit ---

/** Immutable. Written on every score the platform produces. */
export function recordScores(entries) {
  const insert = db.prepare(`
    INSERT INTO scoring_audit (candidate_id, recruiter_id, criteria, score, breakdown, scorer, model_version, created_at)
    VALUES (@candidateId, @recruiterId, @criteria, @score, @breakdown, @scorer, @modelVersion, @createdAt)
  `)
  const now = new Date().toISOString()

  db.transaction((rows) => {
    for (const row of rows) {
      insert.run({
        candidateId: row.candidateId,
        recruiterId: row.recruiterId ?? null,
        criteria: JSON.stringify(row.criteria ?? {}),
        score: row.score,
        breakdown: JSON.stringify(row.breakdown ?? null),
        scorer: row.scorer,
        modelVersion: row.modelVersion ?? null,
        createdAt: now,
      })
    }
  })(entries)
}

// --------------------------------------------------------------- freshness ---

export function issueCheckinToken(candidateId) {
  const token = crypto.randomBytes(24).toString('base64url')
  const now = new Date()
  const expires = new Date(now.getTime() + CHECKIN_TOKEN_DAYS * DAY_MS)

  db.prepare(`
    INSERT INTO freshness_checkins (candidate_id, token_hash, sent_at, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(candidateId, hashToken(token), now.toISOString(), expires.toISOString())

  return token
}

/** One click, no login — so the token is the credential and is single use. */
export function redeemCheckinToken(token, answer) {
  const row = db.prepare(
    `SELECT * FROM freshness_checkins WHERE token_hash = ?`,
  ).get(hashToken(token))

  if (!row) return { ok: false, reason: 'unknown' }
  if (row.answered_at) return { ok: false, reason: 'used' }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' }

  const now = new Date().toISOString()
  db.prepare(`UPDATE freshness_checkins SET answered_at = ?, answer = ? WHERE id = ?`)
    .run(now, answer, row.id)

  if (answer === 'yes') confirmActive(row.candidate_id)
  else deactivate(row.candidate_id)

  return { ok: true, candidateId: row.candidate_id, answer }
}

/**
 * An explicit "no". Hides the profile, stops the monthly emails, and cancels any
 * outstanding check-in so a stale link cannot later be clicked into a state the
 * candidate has moved on from.
 *
 * Deliberately separate from the passive unconfirmed path: this is a decision,
 * and only another decision reverses it.
 */
export function deactivate(candidateId) {
  const now = new Date().toISOString()

  db.transaction(() => {
    db.prepare(`
      UPDATE candidates SET hidden_from_search = 1, deactivated_at = ? WHERE id = ?
    `).run(now, candidateId)

    db.prepare(`
      UPDATE freshness_checkins SET answered_at = ?, answer = 'no'
      WHERE candidate_id = ? AND answered_at IS NULL
    `).run(now, candidateId)
  })()
}

/**
 * The explicit click that brings a deactivated profile back. Signing in must
 * never call this — the whole point is that the candidate chose to be hidden and
 * has to choose to be visible again.
 */
export function reactivate(candidateId) {
  db.prepare(`
    UPDATE candidates
    SET hidden_from_search = 0, deactivated_at = NULL, auto_hidden_at = NULL,
        missed_checkins = 0, freshness_stage_sent = 0, last_confirmed_active = ?
    WHERE id = ?
  `).run(new Date().toISOString(), candidateId)
}

/**
 * "Yes, still looking." Resets the inactivity counter and clears any
 * deactivation, since answering yes is itself the explicit action that undoes
 * a no.
 */
export function confirmActive(candidateId) {
  db.prepare(`
    UPDATE candidates
    SET last_confirmed_active = ?, missed_checkins = 0, freshness_stage_sent = 0,
        hidden_from_search = 0, deactivated_at = NULL, auto_hidden_at = NULL
    WHERE id = ?
  `).run(new Date().toISOString(), candidateId)
}

/**
 * "They were here." Recorded when a candidate signs in.
 *
 * This is now the primary freshness signal, and the reminder stage is cleared
 * with it. Without that clear, a candidate who signed in on day 45 would have
 * their clock reset while the sequence still believed it had reached day 44 —
 * and the next time they went quiet, no stage would ever exceed it, so they
 * would run silently to day 60 and be hidden without a single email.
 *
 * It still does not touch hidden_from_search or deactivated_at. Signing in says
 * the person is still here; it does not withdraw an explicit "no", and only
 * another explicit act should make somebody visible again.
 */
export function markCandidateSeen(candidateId) {
  db.prepare(`UPDATE candidates SET last_seen_at = ?, freshness_stage_sent = 0 WHERE id = ?`)
    .run(new Date().toISOString(), candidateId)
}

/**
 * Candidates whose silence has earned a reminder they have not been sent.
 *
 * The gate is `stage > freshness_stage_sent`, not a date, and that is
 * deliberate: the sweep runs on every server boot as well as once a day, so
 * three restarts in an afternoon would otherwise be three emails. Comparing
 * against what has already gone out makes the sweep idempotent however often it
 * is called, which is the only property that makes a daily timer safe here.
 *
 * Deactivated and already-hidden profiles are excluded — there is nothing left
 * to warn them about, and a candidate who said no is not asked again.
 */
export function candidatesDueReminder(now = new Date()) {
  const rows = db.prepare(`
    SELECT id, name, first_name, email, created_at, last_seen_at, last_confirmed_active,
           freshness_stage_sent
    FROM candidates
    WHERE hidden_from_search = 0 AND deactivated_at IS NULL
  `).all()

  const due = []
  for (const candidate of rows) {
    const days = daysInactive(candidate, now)
    const stage = reminderStageFor(days)
    if (stage === 0 || stage <= candidate.freshness_stage_sent) continue
    due.push({ ...candidate, days, stage, daysRemaining: daysUntilHidden(days) })
  }

  return due
}

/** Remembers that a reminder went out, so the next sweep does not repeat it. */
export function recordReminderSent(candidateId, stage) {
  db.prepare(`UPDATE candidates SET freshness_stage_sent = ? WHERE id = ?`)
    .run(stage, candidateId)
}

/**
 * Sixty days of silence takes the profile out of search.
 *
 * Driven by the clock rather than by counting unanswered emails. The old rule
 * hid somebody after two missed check-ins, which meant a candidate whose emails
 * bounced could be hidden while a candidate who never received one stayed
 * visible forever — the same silence producing opposite outcomes depending on
 * what our mail server managed.
 *
 * Only ever the crossing, and never somebody already hidden: the caller emails
 * whoever appears in the returned list, and a profile hidden last week must not
 * generate that email again every day thereafter.
 */
export function hideStaleProfiles(now = new Date()) {
  const rows = db.prepare(`
    SELECT id, name, first_name, email, created_at, last_seen_at, last_confirmed_active
    FROM candidates
    WHERE hidden_from_search = 0 AND deactivated_at IS NULL
  `).all()

  const hidden = []
  for (const candidate of rows) {
    if (daysInactive(candidate, now) < HIDE_DAYS) continue

    db.prepare(`
      UPDATE candidates SET hidden_from_search = 1, auto_hidden_at = ? WHERE id = ?
    `).run(now.toISOString(), candidate.id)
    hidden.push(candidate)
  }

  return { hidden }
}

/**
 * What a candidate's activity means, in one place so the recruiter badge, the
 * search filter and the candidate's own portal can never disagree.
 *
 *   green         activity inside the last 30 days. Current, and shown as such.
 *   orange        30 to 59 days of silence. Still visible and still searchable:
 *                 the recruiter is told freshness is uncertain and can ask, for
 *                 free, before spending a Reveal on them.
 *   hidden        60 days of silence. Out of recruiter discovery, not deleted,
 *                 and one sign-in away from coming back.
 *   deactivated   said no, explicitly. A decision, not a lapse, and only
 *                 another decision reverses it.
 *
 * Green is recency and nothing more. It does not mean the candidate is
 * available, will reply, or is still looking — only that they were here
 * recently — and no label this returns is allowed to suggest otherwise.
 */
export function activityStatus(candidate) {
  if (!candidate) return null

  const days = daysInactive(candidate)
  const lastConfirmedAt = candidate.last_confirmed_active ?? null
  const lastSeenAt = candidate.last_seen_at ?? null
  const since = lastActivityAt(candidate)
  const shared = {
    days,
    since,
    lastActivityAt: since,
    lastConfirmedAt,
    lastSeenAt,
    daysUntilHidden: daysUntilHidden(days),
    nextReminderStage: reminderStageFor(days),
  }

  /* An explicit no outranks the clock. Somebody who said no yesterday is
     deactivated, not "active this month". */
  if (candidate.deactivated_at) {
    return {
      ...shared,
      state: 'deactivated',
      label: 'Not open to opportunities',
      deactivatedAt: candidate.deactivated_at,
      visibleToRecruiters: false,
    }
  }

  /* Hidden for going quiet is not the same as hidden by choice, and the two
     must not share a label: saying "asked not to be approached" over somebody
     who simply stopped signing in puts a decision in their mouth. */
  if (candidate.hidden_from_search) {
    return {
      ...shared,
      state: 'hidden',
      label: 'Hidden — no activity in 60 days',
      autoHiddenAt: candidate.auto_hidden_at ?? null,
      deactivatedAt: null,
      visibleToRecruiters: false,
    }
  }

  if (days >= FRESH_DAYS) {
    return {
      ...shared,
      state: 'orange',
      label: `No activity for ${days} days`,
      deactivatedAt: null,
      visibleToRecruiters: true,
    }
  }

  return {
    ...shared,
    state: 'green',
    label: 'Active in the last 30 days',
    deactivatedAt: null,
    visibleToRecruiters: true,
  }
}

/** When the profile is hidden if nothing changes, for the candidate's portal. */
export function hiddenDueAt(candidate) {
  const last = lastActivityAt(candidate)
  if (!last) return null
  return new Date(new Date(last).getTime() + HIDE_DAYS * DAY_MS).toISOString()
}

/** The outstanding question for a candidate, if one is waiting to be answered. */
export function pendingCheckin(candidateId, now = new Date()) {
  return db.prepare(`
    SELECT id, sent_at, expires_at FROM freshness_checkins
    WHERE candidate_id = ? AND answered_at IS NULL AND expires_at > ?
    ORDER BY sent_at DESC LIMIT 1
  `).get(candidateId, now.toISOString()) ?? null
}

// ------------------------------------------------------- account deletion ---

/**
 * Spec §4.9 / §5.6 — hard delete. Profile, all documents and files, embeddings,
 * extracted fields and overrides, consent, blocked companies, view history,
 * reveal history, message threads and messages: nothing retained. One cascade
 * serves both self-deletion and an external right-to-erasure request.
 *
 * Returns the stored filenames so the caller can unlink them; the rows go
 * first, so a failure to delete a file can never leave a live row pointing at
 * data the candidate asked us to destroy.
 *
 * Two deliberate calls worth knowing about:
 *
 *  - The reveal log is destroyed with everything else, as the spec requires.
 *    That is billing history, so a recruiter's past download of this candidate
 *    stops being auditable. Erasure wins over the meter.
 *  - Recruiter folder entries go too. §4.4 once asked for a deleted candidate
 *    to render as "profile no longer available" rather than vanishing, and this
 *    note described that; nothing in the product has ever drawn such a row, and
 *    the code here has always deleted them. folder_items also declares
 *    ON DELETE CASCADE on candidate_id, which — now that foreign keys are
 *    actually enforced — would take the row regardless. The three agree.
 */
export function deleteCandidateCompletely(candidateId) {
  const files = []

  const documents = db.prepare(
    `SELECT stored_name FROM documents WHERE candidate_id = ?`,
  ).all(candidateId)
  for (const doc of documents) files.push(doc.stored_name)

  const candidate = db.prepare(
    `SELECT photo_name, stored_name FROM candidates WHERE id = ?`,
  ).get(candidateId)
  if (candidate?.photo_name) files.push(candidate.photo_name)
  // The pre-slots build kept the CV filename on the candidate row.
  if (candidate?.stored_name) files.push(candidate.stored_name)

  db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM message_threads WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM documents WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM extracted_profiles WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM profile_overrides WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM blocked_companies WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM embeddings WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM view_events WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM reveals WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM scoring_audit WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM freshness_checkins WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM login_codes WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM outreach_drafts WHERE candidate_id = ?`).run(candidateId)

    /*
     * The analytics record of them, which nothing else in here could reach.
     *
     * analytics_events holds the candidate id in a generic `actor_id` column
     * rather than a `candidate_id` one, so it was invisible to both cleanup
     * mechanisms at once: this cascade names its tables, and the orphan sweep
     * in db.js matches on a column name this table does not have. The result
     * was thousands of rows describing people who had asked to be erased,
     * surviving every deletion path the product has.
     *
     * See forgetCandidate for what is kept and why.
     */
    forgetCandidate(candidateId)

    // Their place in every recruiter's folders. Missing this left a shortlist
    // entry pointing at a person who no longer exists.
    db.prepare(`DELETE FROM folder_items WHERE candidate_id = ?`).run(candidateId)

    /* Per-party conversation state. Both tables are keyed by the pair rather
       than by a message, so deleting the messages above does not take them with
       it — they outlive the conversation they describe and point at a candidate
       who is gone. */
    db.prepare(`DELETE FROM conversation_hidden WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM conversation_unread WHERE candidate_id = ?`).run(candidateId)

    /* Their corrections to how they were categorised. Keyed by candidate rather
       than by profile version — that is what lets an edit survive a re-read of
       the CV — so nothing above reaches it. */
    db.prepare(`DELETE FROM candidate_label_overrides WHERE candidate_id = ?`).run(candidateId)

    /*
     * Everything the matching architecture derived about them: their stated
     * preferences, the facts read from their documents, the interpretation
     * built on top, and every cached judgement of them against a job.
     *
     * This is the half that matters most for an erasure request. A profile
     * deleted from `candidates` while its taxonomy labels and job analyses
     * survive has not been erased — it has been made anonymous-looking, which
     * is a different and much weaker thing.
     */
    db.prepare(`DELETE FROM candidate_preference_tags WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM extracted_facts WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM candidate_taxonomy_labels WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM candidate_experience_metrics WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM candidate_profile_intelligence WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM candidate_job_analyses WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM displayed_match_state WHERE candidate_id = ?`).run(candidateId)

    /*
     * Their id inside other people's search state.
     *
     * Two tables carry it in a column no cascade above could name: the public
     * demonstration search that was interrupted trying to reveal them, and the
     * per-search paging state listing who a recruiter's search retrieved.
     * Neither record is *about* the candidate — one is a visitor's session and
     * the other a recruiter's cursor — but both point at somebody who has asked
     * to be erased, and they were the two places "everything we hold" was not
     * true. The Privacy Policy now says the survivor list is the whole of it,
     * which it only is with these gone.
     *
     * The cursor is an index into retrieved_ids, so dropping an entry ahead of
     * it would silently skip whoever came next. It moves back with the entry.
     */
    db.prepare(
      `UPDATE public_searches SET intent_candidate_id = NULL WHERE intent_candidate_id = ?`,
    ).run(candidateId)

    /* LIKE is the coarse filter — '%12%' also matches 123 — so the id is
       confirmed against the parsed array before anything is rewritten. */
    const sessions = db.prepare(`
      SELECT id, retrieved_ids, excluded, cursor FROM retrieval_sessions
      WHERE retrieved_ids LIKE ? OR excluded LIKE ?
    `).all(`%${candidateId}%`, `%${candidateId}%`)

    for (const session of sessions) {
      const retrieved = safeParse(session.retrieved_ids, [])
      const excluded = safeParse(session.excluded, [])
      const at = retrieved.indexOf(candidateId)
      if (at < 0 && !excluded.includes(candidateId)) continue

      db.prepare(`
        UPDATE retrieval_sessions SET retrieved_ids = ?, excluded = ?, cursor = ?
        WHERE id = ?
      `).run(
        JSON.stringify(retrieved.filter((id) => id !== candidateId)),
        JSON.stringify(excluded.filter((id) => id !== candidateId)),
        at >= 0 && at < session.cursor ? Math.max(0, session.cursor - 1) : session.cursor,
        session.id,
      )
    }

    /*
     * What a recruiting team wrote ABOUT them, and what it holds on them.
     *
     * Comments and tags are a company's own words — "phone screened, wants
     * hybrid, hold for Q4" — and they are keyed by candidate. Left behind by an
     * erasure they are the most descriptive thing about the person still in the
     * database, which is the exact failure the rest of this function exists to
     * prevent. Dismissals and the organization's reveal record go for the same
     * reason: both name a candidate who no longer exists.
     *
     * billing_ledger is deliberately NOT here. Money moved, and the ledger is
     * the organization's record of its own spending rather than a description
     * of a person; erasing it would make the accounts unanswerable.
     */
    db.prepare(`DELETE FROM candidate_comments WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM candidate_tags WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM search_dismissals WHERE candidate_id = ?`).run(candidateId)
    db.prepare(`DELETE FROM organization_reveals WHERE candidate_id = ?`).run(candidateId)

    // Legacy tables from before the spec migration.
    for (const table of ['contact_reveals', 'profile_views']) {
      const exists = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(table)
      if (exists) db.prepare(`DELETE FROM "${table}" WHERE candidate_id = ?`).run(candidateId)
    }

    db.prepare(`DELETE FROM candidates WHERE id = ?`).run(candidateId)
  })()

  return files.filter(Boolean)
}

/** What the confirmation screen tells the candidate they are about to destroy. */
export function deletionPreview(candidateId) {
  const count = (sql) => db.prepare(sql).get(candidateId).n

  return {
    documents: count(`SELECT COUNT(*) AS n FROM documents WHERE candidate_id = ?`),
    messages: count(`SELECT COUNT(*) AS n FROM messages WHERE candidate_id = ?`),
    threads: count(`SELECT COUNT(*) AS n FROM message_threads WHERE candidate_id = ?`),
    recruiterViews: count(
      `SELECT COUNT(DISTINCT recruiter_id) AS n FROM view_events WHERE candidate_id = ? AND event_type = 'card_expand'`,
    ),
    downloads: count(`SELECT COUNT(*) AS n FROM reveals WHERE candidate_id = ?`),
  }
}

// ----------------------------------------------------------------- helpers ---

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

function safeParse(value, fallback) {
  try {
    return value === null || value === undefined ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}

/** Rough completeness score, for the funnel metric the brief wants tracked. */
export function profileCompletion(candidate, profile, documents) {
  const checks = [
    Boolean(candidate.first_name && candidate.last_name),
    Boolean(candidate.email),
    Boolean(candidate.phone),
    Boolean(candidate.location),
    Boolean(candidate.availability),
    Boolean(candidate.notes),
    Boolean(candidate.consent_at),
    documents.some((doc) => doc.slot === 'cv'),
    Boolean(profile.current_title),
    (profile.skills ?? []).length > 0,
    (profile.employment_history ?? []).length > 0,
  ]

  return Math.round((checks.filter(Boolean).length / checks.length) * 100) / 100
}
