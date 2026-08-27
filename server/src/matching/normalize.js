/**
 * §10.2, §10.3 — the displayed score.
 *
 * Two layers, and the separation is the point. The absolute layer asks "how
 * well does this person meet this job's requirements" and is stable: it does
 * not move because other candidates arrived. The relative layer turns that into
 * something a recruiter can rank by, across everyone deeply analysed for this
 * job so far.
 *
 * The rule that makes this worth building (§10.2, and §18's acceptance list):
 * a second batch of 25 weaker candidates must NOT produce a fresh 100%. The
 * batch is not the universe. Normalising per batch would tell a recruiter the
 * 40th-best candidate is perfect, which is worse than showing no score at all —
 * it is confidently wrong, and it is the failure mode this design exists to
 * prevent.
 */
import { MATCHING } from './config.js'

/**
 * Maps absolute fit onto the displayed 0-100 scale.
 *
 * The ceiling is not simply "the best candidate found". A field where the best
 * absolute fit is weak scales DOWN, so 100 keeps meaning "strong against this
 * job" rather than "best of a poor bunch". Only once someone clears
 * credibleTopRaw does the top of the scale become reachable.
 *
 * `universe` must be every analysed candidate for the job, not the page being
 * rendered. Passing a batch here is the bug this module exists to prevent, so
 * the caller's contract is spelled out rather than assumed.
 */
export function normalizeUniverse(universe) {
  if (!Array.isArray(universe) || universe.length === 0) return new Map()

  const top = universe.reduce((best, row) => Math.max(best, row.absoluteFit ?? 0), 0)
  const scores = new Map()

  if (top <= 0) {
    for (const row of universe) scores.set(row.candidateId, 0)
    return scores
  }

  const ceiling = top >= MATCHING.credibleTopRaw
    ? 100
    : Math.round((top / MATCHING.credibleTopRaw) * 100)

  for (const row of universe) {
    const fit = Math.max(0, row.absoluteFit ?? 0)
    // Ties are allowed, including several at the ceiling (§10.3): two equally
    // strong candidates should not be separated by invented precision.
    scores.set(row.candidateId, Math.round((fit / top) * ceiling))
  }

  return scores
}

/**
 * Recomputes display scores across the expanded universe and reports movement.
 *
 * The movement report exists because §10.2 makes rescoring a visible event: a
 * recruiter who saw 82 before Show More and 74 after deserves an explanation
 * that the scale moved, not a suspicion that the product is unstable.
 */
export function rescore({ universe, previousScores = new Map() }) {
  const scores = normalizeUniverse(universe)
  const moved = []

  for (const [candidateId, score] of scores) {
    const before = previousScores.get(candidateId)
    if (before !== undefined && before !== score) {
      moved.push({ candidateId, from: before, to: score })
    }
  }

  return { scores, moved, universeSize: universe.length }
}
