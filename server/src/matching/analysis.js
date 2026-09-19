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
import { MATCH_MODEL, analyseMatches, isConfigured as aiConfigured } from '../ai.js'
import { itemsInWindow, recordCost, sumUsage } from '../costs.js'
import { effectiveProfile } from '../profiles.js'
import { scoreCandidate } from '../match.js'
import { MATCHING, VERSIONS } from './config.js'
import { deriveHighlights, needsReview, scoreAgainst } from './score.js'
import { profileVersion } from './intelligence.js'

/**
 * The model identifier that participates in the cache key.
 *
 * MATCH_MODEL rather than MODEL, because the judging call is the one the cache
 * is about and it is the one that can be switched by an environment variable.
 * Keyed on the constant instead, a switch to Sonnet would quietly serve every
 * recruiter Opus's stored answers under Sonnet's name.
 *
 * Takes the model as an argument because the public demo judges with a cheaper
 * one, and its answers must not be read back as though a recruiter's search
 * had produced them.
 */
export function analysisModel(model = MATCH_MODEL) {
  return aiConfigured() ? model : 'deterministic'
}

export function readCached({ candidateId, jobId, jdVersion, model = MATCH_MODEL }) {
  const row = db.prepare(`
    SELECT * FROM candidate_job_analyses
    WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
      AND analysis_model = ? AND scoring_version = ?
  `).get(
    candidateId, profileVersion(candidateId), jobId, jdVersion,
    analysisModel(model), VERSIONS.scoring,
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

export function writeCached({ candidateId, jobId, jdVersion, absoluteFit, criteria, explanation, source, model = MATCH_MODEL }) {
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
    candidateId, profileVersion(candidateId), jobId, jdVersion, analysisModel(model),
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
/**
 * The job's requirements, with the ids every verdict comes back under.
 *
 * Derived from the stored job profile, so the list is identical for every
 * candidate judged against that job and for every re-run of the same job
 * version. Ids assigned per candidate would make verdicts unjoinable across a
 * batch and would change the meaning of a cached analysis.
 *
 * Hard constraints are deliberately absent: they gate eligibility rather than
 * contribute to fit, and mixing the two lets a candidate "make up" for missing
 * a legal requirement by being strong elsewhere.
 */
export function requirementsFrom(matchProfile) {
  const rows = []
  let n = 0

  const take = (items, tier) => {
    for (const item of items ?? []) {
      const text = String(item?.requirement ?? item ?? '').trim()
      if (!text) continue
      n += 1
      rows.push({ id: `R${n}`, text, tier })
    }
  }

  take(matchProfile.mustHaves, 'must_have')
  take(matchProfile.preferred, 'preferred')
  take(matchProfile.contextual, 'contextual')

  return rows
}

function deterministicFit({ candidate, matchProfile, cvText }) {
  const requiredSkills = (matchProfile.mustHaves ?? []).map((item) => item.requirement)
  const preferredSkills = (matchProfile.preferred ?? []).map((item) => item.requirement)

  /* C1 — keyed by the requirement text, which is what scoreCandidate
     canonicalises and looks up. Absent on a profile parsed before this
     existed, and absent means "exact matching only", which is what it did. */
  const expansions = Object.fromEntries(
    (matchProfile.expansions ?? []).map((row) => [row.requirement, row.alsoCalled]),
  )

  const result = scoreCandidate(
    { ...candidate, cv_text: cvText },
    {
      requiredSkills,
      preferredSkills,
      expansions,
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
export async function analyseBatch({
  job, matchProfile, rows, signal, context = 'search', companyId = null,
  /* Which model judges this batch. The public demo runs a cheaper one — see
     runPublicSearch — and it has to travel into the cache key as well as into
     the request, or the demo would write Sonnet's answers under Opus's name and
     never read its own work back. */
  model = MATCH_MODEL,
}) {
  const results = new Map()
  const misses = []

  for (const row of rows) {
    const cached = readCached({
      candidateId: row.candidate.id, jobId: job.id, jdVersion: job.jd_version, model,
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

  const requirements = requirementsFrom(matchProfile)

  /*
   * The ceiling, checked once per batch rather than per candidate.
   *
   * A runaway — a loop, a script, somebody pasting job descriptions all night —
   * spends money at four calls a second and nothing in the product noticed
   * until the invoice. Over the ceiling, the batch falls through to the
   * deterministic scorer: every candidate still gets a score and a place in the
   * ranking, the results are simply not model-read. That is the same path a
   * missing API key already takes, so it is exercised constantly rather than
   * being a failure mode nobody has seen.
   */
  const allowed = withinDailyCeiling({ context, companyId, wanted: misses.length })

  let aiResults = new Map()
  const started = Date.now()
  if (aiConfigured() && allowed) {
    aiResults = await analyseMatches({
      jobDescription: job.raw_jd,
      criteria: {
        title: matchProfile.title ?? job.title ?? '',
        jobDescription: job.raw_jd,
        instruction: job.instruction ?? '',
        requirements,
        /* Still sent: the fallback scorer reads these, and it runs for every
           candidate regardless of whether the model answers. */
        requiredSkills: (matchProfile.mustHaves ?? []).map((item) => item.requirement),
        preferredSkills: (matchProfile.preferred ?? []).map((item) => item.requirement),
        /* Read out of the JD once, by the profile pass, rather than re-read
           per candidate — 25 candidates is 25 chances to read it differently. */
        location: matchProfile.logistics?.location ?? null,
        workArrangement: matchProfile.logistics?.workArrangement ?? null,
      },
      candidates: misses.map((row) => ({
        candidate: { ...row.candidate, cv_text: row.cvText },
        profile: effectiveProfile(row.candidate.id),
      })),
      signal,
      model,
    })

    /* What the batch actually cost, from the provider's own counts. Search
       recorded nothing before this, which is why the only answer to "what does
       a search cost" was an estimate. */
    const usage = sumUsage([...aiResults.values()].map((result) => result.usage))
    if (usage.calls > 0) {
      recordCost({
        context,
        stage: 'match',
        model: analysisModel(model),
        companyId,
        calls: usage.calls,
        items: usage.calls,
        inputTokens: usage.inputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        cacheReadTokens: usage.cacheReadTokens,
        outputTokens: usage.outputTokens,
        durationMs: Date.now() - started,
      })
    }
  }

  for (const row of misses) {
    const id = row.candidate.id
    const ai = aiResults.get(id)
    const fallback = fallbacks.get(id)

    /*
     * The geographic nudge, applied here rather than asked of the model.
     *
     * The model reports friction and the backend prices it — so the weighting
     * is tunable per market without touching a prompt, and identical friction
     * is always worth identical points. A model asked to "factor in location"
     * spends a different amount on it every call.
     *
     * Clamped to the 0-100 the rest of the pipeline assumes.
     */
    const bonus = ai
      ? (MATCHING.locationBonus[ai.location_fit?.level] ?? 0)
      : 0

    /*
     * The score, computed here from the model's verdicts rather than read off
     * its answer. See matching/score.js for why.
     *
     * `fit` is null when nothing about the job could be checked against this
     * CV — an unreadable document, or a model response that came back empty.
     * That falls through to the deterministic score rather than publishing a
     * zero, because "we could not tell" and "they do not match" are different
     * claims and only one of them is supportable.
     */
    const judged = ai ? scoreAgainst(requirements, ai.criteria) : null
    const placed = judged?.fit === null || judged === null
      ? null
      : Math.max(0, Math.min(100, judged.fit + bonus))

    const record = ai && placed !== null
      ? {
        candidateId: id,
        absoluteFit: placed,
        criteria: {
          /* How much of the job this score actually rests on. Shown beside the
             number rather than folded into it. */
          coverage: judged.coverage,
          needsReview: needsReview(judged.coverage),
          verdicts: judged.breakdown,
          confidence: ai.confidence,
          /* Derived from the verdicts above rather than asked of the model,
             which used to write all three a second time. Same lists, same
             wording discipline, no tokens. */
          ...deriveHighlights(judged.breakdown),
          transferable: ai.transferable,
          /* Kept beside the criteria rather than folded into the score: both
             are decision-relevant on their own, and the ranking applies its own
             bounded adjustment for location rather than letting the model spend
             points on it. */
          locationFit: ai.location_fit ?? null,
          /*
           * The nudge itself, as a number, and not only the level it came from.
           *
           * It is added to the fit above and then exists nowhere: the stored
           * score is fit-plus-nudge with no record of which part was which.
           * That made every later recomputation a subtraction against the OLD
           * arithmetic, which works exactly once - after that the stored total
           * is on the new arithmetic and the subtraction recovers nonsense. So
           * MATCH_SILENCE_FRACTION could be tuned for new analyses and never
           * applied to the ones already scored, which is the half of the
           * product a recruiter is actually looking at.
           *
           * Written down, the recomputation is arithmetic: rescore the stored
           * verdicts at the current fraction and add this back. That is what
           * `score:migrate --refresh` does.
           */
          locationNudge: bonus,
          seniorityAlignment: ai.seniority_alignment ?? null,
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
      explanation: record.explanation, source: record.source, model,
    })

    results.set(id, record)
  }

  return { results, analysed: misses.length, reused: results.size - misses.length }
}

/**
 * Adds a written explanation to an analysis that already exists.
 *
 * Merged into the stored criteria rather than kept in a table of its own: it is
 * read in exactly one place, at exactly the moment the analysis beside it is
 * read, and a second table would mean a second query and a second thing that
 * can be out of step with the verdicts it describes.
 *
 * Returns false when there is nothing to attach it to — the analysis expired
 * from the cache, or the job version moved on — so the caller can say so rather
 * than reporting a success that stored nothing.
 */
export function attachExplanation({ candidateId, jobId, jdVersion, explain, model = MATCH_MODEL }) {
  const row = db.prepare(`
    SELECT criteria_results FROM candidate_job_analyses
    WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
      AND analysis_model = ? AND scoring_version = ?
  `).get(
    candidateId, profileVersion(candidateId), jobId, jdVersion,
    analysisModel(model), VERSIONS.scoring,
  )

  if (!row) return false

  const criteria = JSON.parse(row.criteria_results)
  criteria.explain = explain

  db.prepare(`
    UPDATE candidate_job_analyses SET criteria_results = ?
    WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
      AND analysis_model = ? AND scoring_version = ?
  `).run(
    JSON.stringify(criteria), candidateId, profileVersion(candidateId), jobId, jdVersion,
    analysisModel(model), VERSIONS.scoring,
  )

  return true
}

/**
 * Whether there is room under the daily ceiling for this much work.
 *
 * Two ceilings, because there are two things to protect against. A company's
 * own runaway is capped per company; the public demo is capped globally,
 * because it has no company behind it and anyone on the internet can start one.
 *
 * Deliberately not a hard stop: over the line, analysis falls back to the
 * deterministic scorer rather than failing the request. A recruiter who hits an
 * invisible limit should get a working, plainer search — and be told why, which
 * is the caller's job with the flag this returns.
 */
export function withinDailyCeiling({ context, companyId = null, wanted = 1 }) {
  const cap = context === 'demo' ? MATCHING.demoDailyAnalyses : MATCHING.companyDailyAnalyses
  if (!Number.isFinite(cap) || cap <= 0) return true

  const used = itemsInWindow(
    context === 'demo' ? { context: 'demo' } : { context, companyId },
  )

  if (used + wanted <= cap) return true

  console.warn(
    `  daily analysis ceiling reached (${context}${companyId ? ` company ${companyId}` : ''}): `
    + `${used} used, ${wanted} wanted, cap ${cap}. Falling back to deterministic scoring.`,
  )
  return false
}

/** Every analysis stored for this job version — the universe §10.2 normalises over. */
export function analysedUniverse({ jobId, jdVersion, model = MATCH_MODEL }) {
  return db.prepare(`
    SELECT candidate_id AS candidateId, absolute_fit AS absoluteFit,
           criteria_results AS criteria, explanation, source
    FROM candidate_job_analyses
    WHERE job_id = ? AND jd_version = ? AND analysis_model = ? AND scoring_version = ?
  `).all(jobId, jdVersion, analysisModel(model), VERSIONS.scoring)
    .map((row) => ({ ...row, criteria: JSON.parse(row.criteria) }))
}
