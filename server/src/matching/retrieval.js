/**
 * §9 — the funnel.
 *
 * Stage 1 removes people who cannot be considered. Stage 2 ranks everyone left
 * using only precomputed data. Stage 3 keeps the top N. Nothing here reads a CV
 * and nothing here calls a model, which is the entire point: the expensive step
 * happens later, to 25 people, not to the database.
 *
 * The governing asymmetry, stated in §9.1 and applied throughout: excluding
 * someone wrongly is invisible and permanent, while including someone wrongly
 * costs a recruiter one row of scrolling. So absence of evidence never excludes.
 */
import { allEmbeddings, cosine } from '../embeddings.js'
import { MATCHING } from './config.js'
import { conceptIndex, experienceIndex } from './intelligence.js'
import { preferenceIndex, preferencePermitsJob } from './preferences.js'

import { conceptSimilarity } from './taxonomy.js'

// ------------------------------------------------- stage 1: hard filtering ---

/**
 * Is a hard constraint clearly violated?
 *
 * "Clearly" is doing real work. A location constraint only excludes when the
 * candidate has stated a location, it differs, and they have said they will not
 * relocate. Missing location means unknown, and unknown survives.
 */
function violatesLocation(candidate, logistics) {
  const required = String(logistics?.location ?? '').trim().toLowerCase()
  if (!required) return null
  // Remote work makes location irrelevant regardless of what the JD names.
  if (logistics.workArrangement === 'remote') return null

  const actual = String(candidate.location ?? '').trim().toLowerCase()
  if (!actual) return null
  if (actual === required || actual.includes(required) || required.includes(actual)) return null

  // Willing to move, so a different city is not a bar.
  if (candidate.open_to_relocation) return null

  return `based in ${candidate.location}, role requires ${logistics.location}`
}

/**
 * Stage 1. Returns who survives and, separately, why anyone did not.
 *
 * The exclusion log is kept server-side for debugging (§17) and deliberately
 * never returned to the recruiter UI — "this candidate opted out of your sector"
 * is a fact about a named person that the recruiter has no right to.
 */
export function hardFilter({
  candidates, matchProfile, jobConcepts, activityFor, blocked = new Set(),
}) {
  const preferences = preferenceIndex()
  const eligible = []
  const excluded = []

  for (const candidate of candidates) {
    /*
     * §11.6 — the candidate named this employer and asked not to be seen by
     * them. First, before anything else is even read about them: every other
     * exclusion here is a judgement about fit, and this one is a person's
     * instruction. It was promised on the candidate's own settings page and
     * enforced nowhere, which made it the worst kind of privacy control — the
     * kind somebody relies on.
     */
    if (blocked.has(candidate.id)) {
      excluded.push({ id: candidate.id, stage: 'blocked', reason: 'blocked this employer' })
      continue
    }

    // §7 — an explicit "not looking" is applied before retrieval, not after.
    const activity = activityFor(candidate)
    if (!activity.visibleToRecruiters) {
      excluded.push({ id: candidate.id, stage: 'activity', reason: 'deactivated at their own request' })
      continue
    }

    // §5 — candidate intent as a hard exclusion.
    const verdict = preferencePermitsJob(preferences.get(candidate.id), jobConcepts)
    if (!verdict.allowed) {
      excluded.push({ id: candidate.id, stage: 'preference', reason: verdict.reason })
      continue
    }

    const locationProblem = violatesLocation(candidate, matchProfile?.logistics)
    if (locationProblem && (matchProfile?.hardConstraints ?? []).some((c) => c.kind === 'location')) {
      excluded.push({ id: candidate.id, stage: 'location', reason: locationProblem })
      continue
    }

    eligible.push({ candidate, activity })
  }

  return { eligible, excluded }
}

// ---------------------------------------------- stage 2: cheap ranking ------

/**
 * §7 — freshness as a bounded signal.
 *
 * Capped at 1 and weighted low in config, so it can only order near-equals. A
 * dormant strong candidate must still outrank a fresh weak one.
 */
function freshnessSignal(activity) {
  if (!activity) return 0.5
  /*
   * The fields are `state` and `days` — see activityStatus in profiles.js.
   *
   * Read the wrong field names here once before and this returned 1 for
   * everybody, which switched the signal off silently rather than failing. It
   * is worth restating: Green is a full mark, and Orange decays across the
   * thirty days it lasts rather than dropping off a step, so a candidate quiet
   * for 31 days is not ranked as though they were quiet for 59.
   */
  if (activity.state === 'green') return 1
  if (activity.state !== 'orange') return 0.2

  const days = Number(activity.days ?? 30)
  return Math.max(0.2, 1 - ((days - 30) / 30) * 0.8)
}

/**
 * Structured attributes that need no interpretation: availability stated,
 * relocation flexibility, and whether they have any recorded experience at all.
 * Each is a small nudge, never a gate.
 */
function structuredSignal(candidate, experience) {
  const parts = []

  parts.push(candidate.availability ? 1 : 0.5)
  parts.push(candidate.open_to_relocation ? 1 : 0.6)

  const overall = experience?.overall?.years ?? null
  // No dated history is not "no experience" — it is a CV we could not date.
  parts.push(overall === null ? 0.5 : Math.min(1, overall / 8))

  return parts.reduce((sum, value) => sum + value, 0) / parts.length
}

/**
 * §9.2 — the hybrid score.
 *
 * Weights come from config and are divided by the weight actually applied, so a
 * candidate with no embedding is scored on the signals that exist rather than
 * being pushed down for a gap in our own data.
 */
export function retrievalScore({ candidate, activity, jobConcepts, candidateConcepts, experience, similarity }) {
  const w = MATCHING.retrievalWeights
  const parts = []

  parts.push({ weight: w.structured, value: structuredSignal(candidate, experience) })

  const taxonomy = conceptSimilarity(jobConcepts, candidateConcepts ?? [])
  if (taxonomy !== null) parts.push({ weight: w.taxonomy, value: taxonomy })

  if (similarity !== null && similarity !== undefined) {
    // Cosine runs -1..1; the negative half is noise here, not signal.
    parts.push({ weight: w.semantic, value: Math.max(0, similarity) })
  }

  parts.push({ weight: w.freshness, value: freshnessSignal(activity) })

  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0)
  if (totalWeight === 0) return { score: 0, components: {} }

  const score = parts.reduce((sum, part) => sum + (part.weight * part.value), 0) / totalWeight

  return {
    score,
    components: {
      structured: structuredSignal(candidate, experience),
      taxonomy,
      semantic: similarity ?? null,
      freshness: freshnessSignal(activity),
    },
  }
}

/**
 * Stages 2 and 3 together: rank the eligible universe, keep the pool.
 *
 * Every index is read once up front rather than per candidate — §17 warns
 * against assuming the pool fits comfortably in memory, and a per-row query is
 * the first thing that stops scaling.
 */
export function rankAndPool({ eligible, matchProfile, jobConcepts, poolSize = MATCHING.retrievalPoolSize }) {
  const concepts = conceptIndex()
  const experience = experienceIndex()
  const vectors = allEmbeddings()
  const jdVector = matchProfile?.embedding ?? null

  const ranked = eligible.map(({ candidate, activity }) => {
    const vector = vectors.get(candidate.id)
    const similarity = (jdVector && vector && jdVector.length === vector.length)
      ? cosine(jdVector, vector)
      : null

    const { score, components } = retrievalScore({
      candidate,
      activity,
      jobConcepts,
      candidateConcepts: concepts.get(candidate.id) ?? [],
      experience: experience.get(candidate.id) ?? null,
      similarity,
    })

    return { candidate, activity, retrievalScore: score, retrievalComponents: components }
  })

  ranked.sort((a, b) => b.retrievalScore - a.retrievalScore
    // Stable and deterministic, so an unchanged search returns an unchanged
    // order and the analysis cache actually hits.
    || a.candidate.id - b.candidate.id)

  const method = jdVector
    ? (vectors.size > 0 ? 'hybrid' : 'structured')
    : 'structured'

  return { ranked, pool: ranked.slice(0, poolSize), method }
}
