/**
 * §9.4 + §12 — deep analysis, and never paying for it twice.
 *
 * The cache key is the spec's, exactly:
 *
 *   (candidate_id, candidate_profile_version, job_id, job_description_version,
 *    analysis_model_version, scoring_version)
 *
 * Every part earns its place. Drop the profile version and a new CV is ignored;
 * drop the JD version and an edited role reuses stale conclusions; drop the
 * model or scoring version and an improved pipeline serves yesterday's answers
 * forever. Because it is the table's PRIMARY KEY, a stale combination cannot
 * overwrite a fresh one — the database enforces what a convention would not.
 */
import db from '../db.js'
import { MODEL, analyseMatches, isConfigured as aiConfigured } from '../ai.js'
import { effectiveProfile } from '../profiles.js'
import { scoreCandidate } from '../match.js'
import { VERSIONS } from './config.js'
import { profileVersion } from './intelligence.js'

/** The model identifier that participates in the cache key. */
export function analysisModel() {
  return aiConfigured() ? MODEL : 'deterministic'
}

export function readCached({ candidateId, jobId, jdVersion }) {
  const row = db.prepare(`
    SELECT * FROM candidate_job_analyses
    WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
      AND analysis_model = ? AND scoring_version = ?
  `).get(
    candidateId, profileVersion(candidateId), jobId, jdVersion,
    analysisModel(), VERSIONS.scoring,
  )

  if (!row) return null

  return {
    candidateId,
    absoluteFit: row.absolute_fit,
    criteria: JSON.parse(row.criteria_results),
    explanation: row.explanation,
    source: row.source,
    cached: true,
  }
}

export function writeCached({ candidateId, jobId, jdVersion, absoluteFit, criteria, explanation, source }) {
  db.prepare(`
    INSERT INTO candidate_job_analyses (
      candidate_id, profile_version, job_id, jd_version, analysis_model,
      scoring_version, absolute_fit, criteria_results, explanation, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      absolute_fit = excluded.absolute_fit,
      criteria_results = excluded.criteria_results,
      explanation = excluded.explanation,
      source = excluded.source,
      created_at = excluded.created_at
  `).run(
    candidateId, profileVersion(candidateId), jobId, jdVersion, analysisModel(),
    VERSIONS.scoring, absoluteFit, JSON.stringify(criteria ?? {}),
    explanation ?? null, source ?? 'deterministic', new Date().toISOString(),
  )
}

/**
 * §10.1 — criterion-level fit against the JD, with must-haves and preferences
 * kept apart. The recruiter-facing number comes later; what is stored here is
 * the assessment it was derived from, so §17's "do not store only the score"
 * holds.
 */
function deterministicFit({ candidate, matchProfile, cvText }) {
  const requiredSkills = (matchProfile.mustHaves ?? []).map((item) => item.requirement)
  const preferredSkills = (matchProfile.preferred ?? []).map((item) => item.requirement)

  const result = scoreCandidate(
    { ...candidate, cv_text: cvText },
    {
      requiredSkills,
      preferredSkills,
      title: matchProfile.title ?? '',
      jobDescription: matchProfile.interpretation ?? '',
      keywords: matchProfile.contextual ?? [],
    },
  )

  const criteria = [
    ...(result.matchedRequired ?? []).map((r) => ({ requirement: r, class: 'must-have', assessment: 'meets' })),
    ...(result.missingRequired ?? []).map((r) => ({ requirement: r, class: 'must-have', assessment: 'no evidence' })),
    ...(result.matchedPreferred ?? []).map((r) => ({ requirement: r, class: 'preferred', assessment: 'meets' })),
    ...(result.missingPreferred ?? []).map((r) => ({ requirement: r, class: 'preferred', assessment: 'no evidence' })),
  ]

  return {
    absoluteFit: result.score,
    criteria: { items: criteria, breakdown: result.breakdown ?? null },
    explanation: null,
    source: 'deterministic',
    passthrough: result,
  }
}

/**
 * Analyses a batch, reading the cache first.
 *
 * Only genuine misses reach the model. A recruiter who closes and reopens an
 * unchanged search pays nothing, which is the behaviour §12 asks for and the
 * reason the funnel above is worth having at all.
 */
export async function analyseBatch({ job, matchProfile, rows, signal }) {
  const results = new Map()
  const misses = []

  for (const row of rows) {
    const cached = readCached({
      candidateId: row.candidate.id, jobId: job.id, jdVersion: job.jd_version,
    })
    if (cached) {
      results.set(row.candidate.id, cached)
      continue
    }
    misses.push(row)
  }

  if (misses.length === 0) return { results, analysed: 0, reused: results.size }

  // Deterministic fit is computed for every miss regardless: it is free, and it
  // is what the row falls back to if the model declines or errors on it.
  const fallbacks = new Map()
  for (const row of misses) {
    fallbacks.set(row.candidate.id, deterministicFit({
      candidate: row.candidate, matchProfile, cvText: row.cvText,
    }))
  }

  let aiResults = new Map()
  if (aiConfigured()) {
    aiResults = await analyseMatches({
      jobDescription: job.raw_jd,
      criteria: {
        title: matchProfile.title ?? job.title ?? '',
        jobDescription: job.raw_jd,
        instruction: job.instruction ?? '',
        requiredSkills: (matchProfile.mustHaves ?? []).map((item) => item.requirement),
        preferredSkills: (matchProfile.preferred ?? []).map((item) => item.requirement),
      },
      candidates: misses.map((row) => ({
        candidate: { ...row.candidate, cv_text: row.cvText },
        profile: effectiveProfile(row.candidate.id),
      })),
      signal,
    })
  }

  for (const row of misses) {
    const id = row.candidate.id
    const ai = aiResults.get(id)
    const fallback = fallbacks.get(id)

    const record = ai
      ? {
        candidateId: id,
        absoluteFit: ai.score,
        criteria: {
          fit: ai.fit,
          confidence: ai.confidence,
          strengths: ai.strengths,
          gaps: ai.gaps,
          transferable: ai.transferable,
          evidence: ai.evidence,
          probes: ai.probes,
          items: fallback.criteria.items,
        },
        explanation: ai.reasoning,
        source: 'claude',
        cached: false,
      }
      : {
        candidateId: id,
        absoluteFit: fallback.absoluteFit,
        criteria: fallback.criteria,
        explanation: fallback.explanation,
        source: 'deterministic',
        cached: false,
      }

    writeCached({
      candidateId: id, jobId: job.id, jdVersion: job.jd_version,
      absoluteFit: record.absoluteFit, criteria: record.criteria,
      explanation: record.explanation, source: record.source,
    })

    results.set(id, record)
  }

  return { results, analysed: misses.length, reused: results.size - misses.length }
}

/** Every analysis stored for this job version — the universe §10.2 normalises over. */
export function analysedUniverse({ jobId, jdVersion }) {
  return db.prepare(`
    SELECT candidate_id AS candidateId, absolute_fit AS absoluteFit,
           criteria_results AS criteria, explanation, source
    FROM candidate_job_analyses
    WHERE job_id = ? AND jd_version = ? AND analysis_model = ? AND scoring_version = ?
  `).all(jobId, jdVersion, analysisModel(), VERSIONS.scoring)
    .map((row) => ({ ...row, criteria: JSON.parse(row.criteria) }))
}
