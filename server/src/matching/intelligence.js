/**
 * Stage B — reusable professional intelligence (§3.2, §3.3, §6).
 *
 * The point of this module is that it runs ONCE per candidate per version, not
 * once per recruiter search. Everything a search needs to know about a person
 * that does not depend on the job is computed here and stored, which is what
 * lets §18's first acceptance criterion hold: 10,000 candidates must not mean
 * 10,000 fresh CV reads.
 *
 * Two rules shape the output:
 *
 *   Nobody is forced down one branch. A career that spans fintech and security,
 *   or shifted from law to product, keeps every label it earned. Overwriting
 *   older expertise because it is older is how a marketplace loses the people
 *   who are hardest to find.
 *
 *   Confidence is not a match score. It says how sure we are the label belongs
 *   to this person, and nothing about how well they fit any job (§3.2).
 */
import db from '../db.js'
import { effectiveProfile, cvText, matchingDocumentText } from '../profiles.js'
import { MATCHING, VERSIONS, MATCHING_RELEVANT_FIELDS } from './config.js'
import {
  DIMENSIONS, conceptsInText, getConcept, resolveConcept, TAXONOMY_VERSION,
} from './taxonomy.js'

// -------------------------------------------------------- candidate edits ---

/** The dimensions a candidate may edit. Specializations are the matcher's own
    working-out and are not offered. */
export const EDITABLE_DIMENSIONS = ['industry', 'function']

/** Ceilings, enforced here as well as in the interface — a limit that lives
    only in the browser is not a limit. */
export const MAX_LABELS_PER_DIMENSION = 5
export const MAX_LABEL_WORDS = 5

/**
 * Write the candidate's edits onto one profile version.
 *
 * Adds insert a label; removes delete one. Both are idempotent, so this can be
 * replayed onto every new version without accumulating anything.
 */
export function applyLabelOverrides(candidateId, version = profileVersion(candidateId)) {
  const overrides = db.prepare(
    `SELECT dimension, concept_id, action FROM candidate_label_overrides WHERE candidate_id = ?`,
  ).all(candidateId)

  for (const item of overrides) {
    if (item.action === 'remove') {
      db.prepare(`
        DELETE FROM candidate_taxonomy_labels
        WHERE candidate_id = ? AND profile_version = ? AND dimension = ? AND concept_id = ?
      `).run(candidateId, version, item.dimension, item.concept_id)
      continue
    }

    const concept = getConcept(item.concept_id)
    db.prepare(`
      INSERT INTO candidate_taxonomy_labels
        (candidate_id, profile_version, dimension, concept_id, raw_label, confidence, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (candidate_id, profile_version, dimension, concept_id) DO NOTHING
    `).run(
      candidateId, version, item.dimension, item.concept_id,
      concept?.label ?? item.concept_id,
      /* Full confidence: the person whose CV it is said so, which is a better
         source than anything the extractor infers. */
      1, 'Added by the candidate',
    )
  }
}

/**
 * Record an edit and apply it immediately.
 *
 * Returns `{ ok: false, reason }` rather than throwing, so the route can turn
 * each refusal into its own sentence.
 */
export function editCandidateLabel({ candidateId, dimension, text, action }) {
  if (!EDITABLE_DIMENSIONS.includes(dimension)) return { ok: false, reason: 'dimension' }

  const wanted = String(text ?? '').trim()
  if (!wanted) return { ok: false, reason: 'empty' }
  if (wanted.split(/\s+/).length > MAX_LABEL_WORDS) return { ok: false, reason: 'too-long' }

  /*
   * Resolved against the fixed vocabulary rather than stored as typed.
   *
   * Retrieval ranks on concept ids, so a free-text tag would show on the page
   * and change nothing about who finds this person — which is the one thing the
   * candidate is trying to do by editing it. Refusing is more honest than
   * accepting a label that quietly does nothing.
   */
  const concept = resolveConcept(wanted)
  if (!concept) return { ok: false, reason: 'unknown' }
  if (action === 'add' && concept.dimension !== dimension) return { ok: false, reason: 'dimension' }

  const version = profileVersion(candidateId)

  if (action === 'add') {
    const existing = db.prepare(`
      SELECT COUNT(*) AS n FROM candidate_taxonomy_labels
      WHERE candidate_id = ? AND profile_version = ? AND dimension = ?
    `).get(candidateId, version, dimension).n
    const already = db.prepare(`
      SELECT 1 FROM candidate_taxonomy_labels
      WHERE candidate_id = ? AND profile_version = ? AND dimension = ? AND concept_id = ?
    `).get(candidateId, version, dimension, concept.id)

    if (already) return { ok: true, unchanged: true }
    if (existing >= MAX_LABELS_PER_DIMENSION) return { ok: false, reason: 'full' }
  }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO candidate_label_overrides (candidate_id, dimension, concept_id, action, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (candidate_id, dimension, concept_id) DO UPDATE SET
        action = excluded.action, created_at = excluded.created_at
    `).run(candidateId, dimension, concept.id, action, new Date().toISOString())

    applyLabelOverrides(candidateId, version)
  })()

  return { ok: true }
}

// ------------------------------------------------------------ versioning ---

export function profileVersion(candidateId) {
  return db.prepare(`SELECT profile_version FROM candidates WHERE id = ?`)
    .get(candidateId)?.profile_version ?? 1
}

/**
 * §6.1 — did this edit change anything matching depends on?
 *
 * Compares only the listed fields. A photo, a password or a corrected phone
 * number returns false and costs nothing; a new city, a new CV or a changed
 * preference returns true and pays for a rebuild.
 */
export function isMatchingRelevantChange(before = {}, after = {}) {
  return MATCHING_RELEVANT_FIELDS.some((field) => {
    if (!(field in after)) return false
    const a = before[field]
    const b = after[field]
    if (a === b) return false
    // Arrays and objects arrive from different layers in different shapes.
    return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)
  })
}

/**
 * Moves the candidate to a new version.
 *
 * Nothing is deleted: intelligence rows are keyed by version, so the previous
 * interpretation stays readable while the new one is built. That is what makes
 * a failed rebuild safe (§17) — a half-written version never replaces a good
 * one, because the good one was never touched.
 */
export function bumpProfileVersion(candidateId) {
  db.prepare(`UPDATE candidates SET profile_version = profile_version + 1 WHERE id = ?`)
    .run(candidateId)
  return profileVersion(candidateId)
}

/** §6.3 — is the stored interpretation older than the freshness cycle? */
export function needsRevalidation(candidateId, now = new Date()) {
  const row = db.prepare(`SELECT intelligence_at FROM candidates WHERE id = ?`).get(candidateId)
  if (!row?.intelligence_at) return true

  const due = new Date(row.intelligence_at)
  due.setMonth(due.getMonth() + MATCHING.freshnessMonths)
  return now >= due
}

// --------------------------------------------------------- fact recording ---

function recordFacts(candidateId, version, facts) {
  const insert = db.prepare(`
    INSERT INTO extracted_facts (
      candidate_id, profile_version, fact_type, normalized_value, raw_value,
      source_slot, evidence, confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const now = new Date().toISOString()
  for (const fact of facts) {
    insert.run(
      candidateId, version, fact.type, fact.value, fact.raw ?? null,
      fact.slot ?? 'cv', fact.evidence ?? null, fact.confidence ?? null, now,
    )
  }
}

// ------------------------------------------------------------- experience ---

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/** "2019-03", "2019", "March 2019", "present" -> a Date, or null. */
function parseWhen(value, { end = false } = {}) {
  const text = String(value ?? '').trim().toLowerCase()
  if (!text) return null
  if (/^(present|current|now|today)$/.test(text)) return new Date()

  const iso = text.match(/^(\d{4})-(\d{1,2})/)
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, 1)

  const named = text.match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/)
  if (named && named[1] in MONTHS) return new Date(Number(named[2]), MONTHS[named[1]], 1)

  const year = text.match(/(\d{4})/)
  if (year) return new Date(Number(year[1]), end ? 11 : 0, 1)

  return null
}

/**
 * Total months covered by a set of roles, merging overlaps.
 *
 * Concurrent roles must not be double counted — someone who consulted while
 * employed has not thereby worked twice as long — so the ranges are unioned
 * rather than summed.
 */
function coveredMonths(ranges) {
  const spans = ranges
    .map(({ from, to }) => ({ from, to: to ?? new Date() }))
    .filter((span) => span.from && span.to && span.to >= span.from)
    .sort((a, b) => a.from - b.from)

  if (spans.length === 0) return 0

  let total = 0
  let { from: start, to: end } = spans[0]

  for (const span of spans.slice(1)) {
    if (span.from <= end) {
      if (span.to > end) end = span.to
      continue
    }
    total += (end - start)
    start = span.from
    end = span.to
  }
  total += (end - start)

  return total / (1000 * 60 * 60 * 24 * 30.44)
}

const LEADERSHIP = /\b(head|lead|leader|leading|manager|managing|director|vp|chief|principal|supervis|team lead|managed a team|mentor)/i

const DATE = String.raw`\d{4}-\d{1,2}|[a-z]{3,9}\.?\s+\d{4}|\d{4}`
const RANGE = new RegExp(
  String.raw`(${DATE})\s*(?:[-–—]|\bto\b|\buntil\b)\s*(present|current|now|${DATE})`, 'i',
)

/**
 * Employment history read straight from CV text.
 *
 * Needed because the deterministic extractor produces no history, and without
 * one §3.3 has nothing to measure — every candidate would report no experience
 * at all whenever no model is configured. This finds lines carrying a date
 * range and treats the indented lines beneath them as that role's detail, which
 * is how CVs are actually laid out.
 *
 * Used only as a fallback: a model-extracted history is always better, and is
 * preferred whenever one exists.
 */
export function historyFromText(text) {
  const lines = String(text ?? '').split('\n')
  const roles = []

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(RANGE)
    if (!match) continue

    const detail = []
    for (let j = i + 1; j < lines.length && detail.length < 6; j += 1) {
      const next = lines[j]
      if (!next.trim()) continue
      /*
       * A second dated line starts the next role, and a heading ends the
       * history section. Indentation is deliberately NOT used as the boundary:
       * PDF text extraction discards leading whitespace, so a parser that
       * relied on it would find every role's detail empty on real uploads
       * while passing happily against plain text.
       */
      if (RANGE.test(next) || /^[A-Z][A-Z &/]{2,}\s*:/.test(next.trim())) break
      detail.push(next.trim())
    }

    roles.push({
      title: lines[i].replace(match[0], '').replace(/[,;|]\s*$/, '').trim(),
      company: null,
      start: match[1],
      end: match[2],
      summary: detail.join(' '),
    })
  }

  return roles
}

/**
 * When did this person start leading?
 *
 * A role whose description mentions leadership is not a role that was led from
 * day one. "Team lead for the credit desk from 2021-06" inside a role starting
 * 2012 means five years of leadership, not fourteen — and reporting fourteen is
 * exactly the misleading seniority number §3.3 exists to prevent.
 */
function leadershipSpan(role) {
  const sentences = String(role.summary ?? '').split(/(?<=[.;])\s+/).concat(role.title ?? '')

  for (const sentence of sentences) {
    if (!LEADERSHIP.test(sentence)) continue
    const dated = sentence.match(new RegExp(String.raw`(?:from|since)\s+(${DATE})`, 'i'))
    if (dated) {
      const from = parseWhen(dated[1])
      if (from && from >= role.from) return { from, to: role.to }
    }
  }

  // Mentioned with no date of its own: the role's own span is the best evidence.
  return LEADERSHIP.test([role.title, role.summary].filter(Boolean).join(' '))
    ? { from: role.from, to: role.to }
    : null
}

/**
 * §3.3 — several durations, not one.
 *
 * Produces an overall figure plus a per-domain figure for each concept the
 * candidate's roles touch, and a separate leadership total. The spec's example
 * is exactly this: 12 years of credit work and 3 years leading people are two
 * facts about one person, and "12 years managerial experience" is false.
 */
export function experienceMetrics(history = [], { cvText = '' } = {}) {
  // The model's history when there is one, the CV's own layout when there is not.
  const source = (Array.isArray(history) && history.length > 0)
    ? history
    : historyFromText(cvText)

  const roles = source
    .filter((role) => role && typeof role === 'object')
    .map((role) => ({
      ...role,
      from: parseWhen(role.start),
      to: parseWhen(role.end, { end: true }),
      text: [role.title, role.company, role.summary].filter(Boolean).join(' '),
    }))
    .filter((role) => role.from)

  const metrics = []

  const overall = coveredMonths(roles)
  if (overall > 0) {
    metrics.push({
      domain: 'overall',
      years: Math.round((overall / 12) * 10) / 10,
      leadershipYears: null,
      confidence: 0.8,
      evidence: `${roles.length} role(s) with dated ranges`,
    })
  }

  const leadSpans = roles.map(leadershipSpan).filter(Boolean)
  if (leadSpans.length > 0) {
    metrics.push({
      domain: 'leadership',
      years: null,
      leadershipYears: Math.round((coveredMonths(leadSpans) / 12) * 10) / 10,
      confidence: 0.6,
      evidence: roles.filter((role) => LEADERSHIP.test(role.text))
        .map((role) => role.title).filter(Boolean).slice(0, 3).join('; '),
    })
  }

  // Per-domain: group roles by the concepts their text resolves to.
  const byConcept = new Map()
  for (const role of roles) {
    for (const concept of conceptsInText(role.text, { limit: 4 })) {
      if (!byConcept.has(concept.id)) byConcept.set(concept.id, { concept, roles: [] })
      byConcept.get(concept.id).roles.push(role)
    }
  }

  for (const { concept, roles: matched } of byConcept.values()) {
    const years = Math.round((coveredMonths(matched) / 12) * 10) / 10
    if (years <= 0) continue
    metrics.push({
      domain: concept.id,
      years,
      leadershipYears: null,
      confidence: 0.55,
      evidence: matched.map((role) => role.title).filter(Boolean).slice(0, 3).join('; '),
    })
  }

  return metrics
}

// ------------------------------------------------------------- label build ---

/**
 * Every concept this candidate legitimately belongs to, with where it came from.
 *
 * Sources are weighted by how directly they evidence the label: a stated
 * industry outranks a mention buried in CV prose. Duplicates keep the highest
 * confidence rather than the last one seen.
 */
function buildLabels({ profile, cv }) {
  const labels = new Map()

  const add = (concept, confidence, evidence, raw) => {
    if (!concept) return
    const existing = labels.get(concept.id)
    if (existing && existing.confidence >= confidence) return
    labels.set(concept.id, {
      dimension: concept.dimension,
      conceptId: concept.id,
      rawLabel: raw ?? concept.label,
      confidence,
      evidence,
    })
  }

  add(resolveConcept(profile.industry), 0.9, 'stated industry on the profile', profile.industry)
  add(resolveConcept(profile.current_title), 0.85, `current title: ${profile.current_title ?? ''}`.trim(), profile.current_title)

  for (const skill of profile.skills ?? []) {
    add(resolveConcept(skill), 0.6, `skill: ${skill}`, skill)
  }

  for (const role of profile.employment_history ?? []) {
    const text = [role?.title, role?.company, role?.summary].filter(Boolean).join(' ')
    if (!text) continue
    for (const concept of conceptsInText(text, { limit: 6 })) {
      add(concept, 0.7, `role: ${(role?.title ?? text).slice(0, 80)}`)
    }
  }

  // Weakest source, and last, so it never overrides anything explicit.
  for (const concept of conceptsInText(cv, { limit: 16 })) {
    add(concept, 0.4, 'mentioned in the CV')
  }

  return [...labels.values()].filter((label) => DIMENSIONS.includes(label.dimension))
}

// ------------------------------------------------------------------ build ---

/**
 * Builds (or rebuilds) the interpretation for a candidate's current version.
 *
 * Transactional, per §17: the labels, metrics, facts and the intelligence row
 * land together or not at all. A crash halfway through leaves the previous
 * version intact and this one simply absent, which the caller can retry
 * without creating duplicates.
 */
export function buildIntelligence(candidateId, { now = new Date() } = {}) {
  const version = profileVersion(candidateId)
  const profile = effectiveProfile(candidateId)

  /*
   * §3.1 — labels are drawn from every uploaded document, so a cover letter
   * naming an industry the CV never mentions still counts. Durations stay on
   * the CV alone: a recommendation letter's prose about "years of experience"
   * is not a dated employment record, and treating it as one would invent
   * precision that nothing supports.
   */
  const cv = cvText(candidateId) ?? ''
  const allDocuments = matchingDocumentText(candidateId) || cv

  const labels = buildLabels({ profile, cv: allDocuments })
  const metrics = experienceMetrics(profile.employment_history ?? [], { cvText: cv })

  const facts = [
    ...(profile.languages ?? []).map((language) => ({
      type: 'language', value: String(language), raw: String(language),
      evidence: 'languages section of the CV', confidence: 0.7,
    })),
    ...(profile.education ?? []).map((entry) => ({
      type: 'education',
      value: [entry?.degree, entry?.field, entry?.institution].filter(Boolean).join(', ') || 'education',
      raw: JSON.stringify(entry), evidence: 'education section of the CV', confidence: 0.7,
    })),
    ...(profile.skills ?? []).map((skill) => ({
      type: 'skill', value: String(skill), raw: String(skill),
      evidence: 'skills detected in the CV', confidence: 0.6,
    })),
  ]

  const write = db.transaction(() => {
    db.prepare(`DELETE FROM candidate_taxonomy_labels WHERE candidate_id = ? AND profile_version = ?`)
      .run(candidateId, version)
    db.prepare(`DELETE FROM candidate_experience_metrics WHERE candidate_id = ? AND profile_version = ?`)
      .run(candidateId, version)
    db.prepare(`DELETE FROM extracted_facts WHERE candidate_id = ? AND profile_version = ?`)
      .run(candidateId, version)

    const label = db.prepare(`
      INSERT INTO candidate_taxonomy_labels
        (candidate_id, profile_version, dimension, concept_id, raw_label, confidence, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const item of labels) {
      label.run(candidateId, version, item.dimension, item.conceptId, item.rawLabel, item.confidence, item.evidence)
    }

    const metric = db.prepare(`
      INSERT INTO candidate_experience_metrics
        (candidate_id, profile_version, domain, years, leadership_years, confidence, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const item of metrics) {
      metric.run(candidateId, version, item.domain, item.years, item.leadershipYears, item.confidence, item.evidence)
    }

    recordFacts(candidateId, version, facts)

    /*
     * The candidate's own edits, replayed.
     *
     * Analysis rewrites every label under this version, so an edit made last
     * week would be silently undone by today's re-read of the CV. Applying the
     * overrides inside the same transaction means there is no moment at which
     * the stored profile disagrees with what the candidate was last shown.
     */
    applyLabelOverrides(candidateId, version)

    db.prepare(`
      INSERT INTO candidate_profile_intelligence (
        candidate_id, profile_version, taxonomy_version, intelligence_version,
        extraction_version, summary, seniority, source, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (candidate_id, profile_version) DO UPDATE SET
        taxonomy_version = excluded.taxonomy_version,
        intelligence_version = excluded.intelligence_version,
        extraction_version = excluded.extraction_version,
        summary = excluded.summary,
        seniority = excluded.seniority,
        source = excluded.source,
        generated_at = excluded.generated_at
    `).run(
      candidateId, version, TAXONOMY_VERSION, VERSIONS.intelligence, VERSIONS.extraction,
      profile.summary ?? null, profile.seniority ?? null,
      profile.extractionSource ?? 'deterministic', now.toISOString(),
    )

    // §6.3 — a successful build resets the freshness clock.
    db.prepare(`UPDATE candidates SET intelligence_at = ? WHERE id = ?`)
      .run(now.toISOString(), candidateId)
  })

  write()

  return { version, labels, metrics, facts: facts.length }
}

// ------------------------------------------------------------------- read ---

export function getIntelligence(candidateId) {
  const version = profileVersion(candidateId)
  const row = db.prepare(`
    SELECT * FROM candidate_profile_intelligence WHERE candidate_id = ? AND profile_version = ?
  `).get(candidateId, version)

  if (!row) return null

  return {
    candidateId,
    profileVersion: version,
    summary: row.summary,
    seniority: row.seniority,
    source: row.source,
    generatedAt: row.generated_at,
    taxonomyVersion: row.taxonomy_version,
    labels: db.prepare(`
      SELECT dimension, concept_id AS conceptId, raw_label AS rawLabel, confidence, evidence
      FROM candidate_taxonomy_labels WHERE candidate_id = ? AND profile_version = ?
      ORDER BY confidence DESC
    `).all(candidateId, version),
    metrics: db.prepare(`
      SELECT domain, years, leadership_years AS leadershipYears, confidence, evidence
      FROM candidate_experience_metrics WHERE candidate_id = ? AND profile_version = ?
    `).all(candidateId, version),
  }
}

/** Concept ids only — the shape retrieval actually ranks on. */
export function conceptIdsFor(candidateId) {
  const version = profileVersion(candidateId)
  return db.prepare(`
    SELECT concept_id FROM candidate_taxonomy_labels
    WHERE candidate_id = ? AND profile_version = ?
  `).all(candidateId, version).map((row) => row.concept_id)
}

/** Every candidate's concepts in one query — retrieval must not loop over rows. */
export function conceptIndex() {
  const rows = db.prepare(`
    SELECT l.candidate_id AS id, l.concept_id AS concept
    FROM candidate_taxonomy_labels l
    JOIN candidates c ON c.id = l.candidate_id AND c.profile_version = l.profile_version
  `).all()

  const index = new Map()
  for (const row of rows) {
    if (!index.has(row.id)) index.set(row.id, [])
    index.get(row.id).push(row.concept)
  }
  return index
}

/**
 * Builds intelligence for every candidate that has none at their current
 * version. Idempotent and model-free — it reads facts already extracted, so a
 * restart repeats nothing and costs nothing.
 */
export function backfillIntelligence({ limit = 1000 } = {}) {
  const missing = db.prepare(`
    SELECT c.id FROM candidates c
    LEFT JOIN candidate_profile_intelligence i
      ON i.candidate_id = c.id AND i.profile_version = c.profile_version
    WHERE i.candidate_id IS NULL
    LIMIT ?
  `).all(limit)

  let built = 0
  for (const row of missing) {
    try {
      buildIntelligence(row.id)
      built += 1
    } catch (error) {
      console.warn(`  intelligence backfill skipped candidate ${row.id}: ${error.message}`)
    }
  }

  return built
}

/** Same, for experience. Keyed by candidate then domain. */
export function experienceIndex() {
  const rows = db.prepare(`
    SELECT m.candidate_id AS id, m.domain, m.years, m.leadership_years AS leadershipYears
    FROM candidate_experience_metrics m
    JOIN candidates c ON c.id = m.candidate_id AND c.profile_version = m.profile_version
  `).all()

  const index = new Map()
  for (const row of rows) {
    if (!index.has(row.id)) index.set(row.id, {})
    index.get(row.id)[row.domain] = { years: row.years, leadershipYears: row.leadershipYears }
  }
  return index
}
