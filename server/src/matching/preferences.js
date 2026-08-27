/**
 * §5 — candidate opportunity preferences.
 *
 * This is the one part of matching that exists to say *no* on the candidate's
 * behalf, so it is deliberately strict. The product promise is that a recruiter
 * contacting someone is contacting a person who opted into that kind of work;
 * every softening of this file breaks that promise quietly, and the candidate
 * never finds out.
 *
 * Two rules do the work:
 *
 *   A tag is a preference, not a credential. 'VC' means willing to hear about
 *   VC roles. It is never evidence of VC experience (§2), and nothing here
 *   feeds the skills or intelligence layers.
 *
 *   Breadth flows one way. A broad tag admits its subdomains; a narrow one does
 *   not admit its parent (§14). See taxonomy.js for why that asymmetry matters.
 */
import db from '../db.js'
import { MATCHING } from './config.js'
import { interestPermits, resolveConcept } from './taxonomy.js'

export class PreferenceError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

/**
 * §5 — validates the pair, because neither half means anything alone.
 *
 * A candidate who switches the toggle off and supplies no tags is NOT quietly
 * treated as open to everything. That would be the system inventing consent it
 * was just denied, so it is an error the caller has to surface.
 */
export function validatePreferences({ openToAll, tags }) {
  const open = openToAll === undefined ? true : Boolean(openToAll)
  const cleaned = normalizeTags(tags)

  if (!open && cleaned.length === 0) {
    throw new PreferenceError(
      'Choose at least one kind of opportunity you are open to, or tick "open to all opportunities".',
    )
  }

  if (cleaned.length > MATCHING.preferenceTagCap) {
    throw new PreferenceError(
      `Please list at most ${MATCHING.preferenceTagCap} areas of interest.`,
    )
  }

  return { openToAll: open, tags: cleaned }
}

/** Trimmed, de-duplicated case-insensitively, original wording preserved. */
export function normalizeTags(tags) {
  const list = Array.isArray(tags)
    ? tags
    : String(tags ?? '').split(',')

  const seen = new Set()
  const out = []

  for (const entry of list) {
    const raw = String(entry ?? '').trim().slice(0, 60)
    if (!raw) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(raw)
  }

  return out
}

export function setPreferences(candidateId, { openToAll, tags }) {
  const valid = validatePreferences({ openToAll, tags })
  const now = new Date().toISOString()

  db.transaction(() => {
    db.prepare(`UPDATE candidates SET open_to_all_opportunities = ? WHERE id = ?`)
      .run(valid.openToAll ? 1 : 0, candidateId)

    db.prepare(`DELETE FROM candidate_preference_tags WHERE candidate_id = ?`).run(candidateId)

    const insert = db.prepare(`
      INSERT INTO candidate_preference_tags (candidate_id, raw_tag, concept_id, created_at)
      VALUES (?, ?, ?, ?)
    `)
    for (const raw of valid.tags) {
      // Original wording is stored either way. An unrecognised tag is kept as
      // written rather than dropped: the taxonomy not knowing a word is our
      // gap, not the candidate's mistake.
      insert.run(candidateId, raw, resolveConcept(raw)?.id ?? null, now)
    }
  })()

  return valid
}

export function getPreferences(candidateId) {
  const row = db.prepare(`SELECT open_to_all_opportunities FROM candidates WHERE id = ?`)
    .get(candidateId)

  return {
    openToAll: row ? Boolean(row.open_to_all_opportunities) : true,
    tags: db.prepare(`
      SELECT raw_tag AS raw, concept_id AS conceptId
      FROM candidate_preference_tags WHERE candidate_id = ? ORDER BY id
    `).all(candidateId),
  }
}

/** Every candidate's preferences in one query, for the hard-filter stage. */
export function preferenceIndex() {
  const index = new Map()

  for (const row of db.prepare(`SELECT id, open_to_all_opportunities FROM candidates`).all()) {
    index.set(row.id, { openToAll: Boolean(row.open_to_all_opportunities), tags: [] })
  }

  for (const row of db.prepare(`
    SELECT candidate_id, raw_tag, concept_id FROM candidate_preference_tags
  `).all()) {
    index.get(row.candidate_id)?.tags.push({ raw: row.raw_tag, conceptId: row.concept_id })
  }

  return index
}

/**
 * May this job be shown to this candidate? (§5, §9.1)
 *
 * Returns a reason when the answer is no, because §17 wants hard-filter
 * exclusions logged and debuggable — a candidate silently missing from a search
 * is the hardest bug in a system like this to even notice.
 *
 * The uncertain cases resolve to *allowed*. An unrecognised tag, or a job whose
 * concepts we failed to read, means our understanding is incomplete — and §9.1
 * is explicit that missing evidence is not evidence of a mismatch. Better a
 * recruiter sees someone marginal than a candidate is silently excluded by our
 * own blind spot.
 */
export function preferencePermitsJob(preferences, jobConceptIds) {
  if (!preferences || preferences.openToAll) return { allowed: true }
  if (preferences.tags.length === 0) {
    // Should be unreachable — setPreferences refuses to create this state — but
    // a legacy row must not become a silent exclusion.
    return { allowed: true, reason: 'no tags recorded; treated as unrestricted' }
  }
  if (jobConceptIds.length === 0) {
    return { allowed: true, reason: 'job concepts unresolved; preference not applied' }
  }

  const recognised = preferences.tags.filter((tag) => tag.conceptId)
  if (recognised.length === 0) {
    return { allowed: true, reason: 'no tag resolved to a known concept' }
  }

  const permitted = recognised.some((tag) => interestPermits(tag.conceptId, jobConceptIds))
  if (permitted) return { allowed: true }

  return {
    allowed: false,
    reason: `opted into ${recognised.map((tag) => tag.raw).join(', ')} only`,
  }
}
