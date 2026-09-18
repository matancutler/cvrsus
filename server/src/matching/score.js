/**
 * The fit score, computed in code from the model's per-requirement verdicts.
 *
 * The model used to return `score: 0-100` directly, with calibration bands in
 * its prompt. It judges evidence extremely well and holds a numeric rubric
 * across thousands of independent calls extremely badly: nothing anchors the
 * four-hundredth call to the twelfth, so the number drifted and the ranking
 * drifted with it. Two equally strong candidates could land ten points apart
 * for no reason anybody could name, and nobody could explain a score after the
 * fact because the reasoning that produced it was gone.
 *
 * So the split is: Claude says whether each requirement is evidenced, this file
 * says what that is worth. Same verdicts in, same score out, every time — and
 * every point traceable to a named requirement and a quote.
 */
import { MATCHING } from './config.js'

/**
 * What each verdict is worth.
 *
 * `no_evidence` is deliberately absent rather than zero. A requirement the CV
 * never mentions is unknown, not failed, and scoring it zero is the single
 * most common way a ranking buries a good candidate — CVs are summaries
 * written in an afternoon, and the things they leave out are not things the
 * candidate cannot do. Unknowns leave the sum entirely and are reported
 * separately as coverage.
 *
 * `contradicted` IS zero, because that is a real failure the CV proves.
 */
const MULTIPLIER = {
  meets: 1,
  partial: 0.6,
  contradicted: 0,
}

/** Unknown requirements are excluded from fit and counted against coverage. */
const UNKNOWN = 'no_evidence'

/**
 * What a requirement is worth, by how the job description framed it.
 *
 * Held here rather than asked of the model for the same reason as the score:
 * a model asked to weight requirements weights them differently each call, and
 * a weight that moves is a ranking that moves. Hard constraints carry no weight
 * because they are gates — they decide whether a candidate is eligible at all,
 * which is a different question from how well they fit.
 */
const TIER_WEIGHT = {
  must_have: 30,
  preferred: 10,
  contextual: 5,
}

/**
 * Fit and coverage from a set of verdicts.
 *
 * `fit` answers "of what we could actually check, how much does this person
 * meet?" — 0 to 100. `coverage` answers "how much of the job could we check at
 * all?" — also 0 to 100, weighted, so an unknown must-have costs far more than
 * an unknown nice-to-have.
 *
 * Reporting both is the honest alternative to folding unknowns into the score
 * and hiding the uncertainty inside an average. "Fit 85, evidence 80%" tells a
 * recruiter something true that "68%" does not.
 */
export function scoreAgainst(requirements, verdicts) {
  const byId = new Map(
    (verdicts ?? [])
      .filter((v) => v && typeof v.requirement_id === 'string')
      .map((v) => [v.requirement_id, v]),
  )

  let knownWeight = 0
  let totalWeight = 0
  let earned = 0

  const breakdown = []

  for (const requirement of requirements ?? []) {
    const weight = TIER_WEIGHT[requirement.tier] ?? TIER_WEIGHT.contextual
    totalWeight += weight

    const verdict = byId.get(requirement.id)
    /*
     * A requirement the model skipped is unknown, not met. The schema asks for
     * every id back, but a scorer that assumed the schema held would turn one
     * malformed response into a confidently wrong ranking.
     */
    const status = verdict?.status && status_is_known(verdict.status)
      ? verdict.status
      : UNKNOWN

    breakdown.push({
      id: requirement.id,
      requirement: requirement.text,
      tier: requirement.tier,
      weight,
      status,
      quote: verdict?.quote ?? '',
      reason: verdict?.reason ?? '',
    })

    if (status === UNKNOWN) continue

    knownWeight += weight
    earned += (MULTIPLIER[status] ?? 0) * weight
  }

  return {
    /* Nothing checkable means no opinion, not a zero — a zero here would rank
       an unreadable CV below a bad one, which is a claim we cannot support. */
    fit: knownWeight === 0 ? null : Math.round((earned / knownWeight) * 100),
    coverage: totalWeight === 0 ? 0 : Math.round((knownWeight / totalWeight) * 100),
    knownWeight,
    totalWeight,
    breakdown,
  }
}

function status_is_known(status) {
  return status === UNKNOWN || Object.prototype.hasOwnProperty.call(MULTIPLIER, status)
}

/**
 * Strengths, gaps and evidence — derived from the verdicts rather than bought.
 *
 * The model used to be asked for all three by name, on top of the verdicts, and
 * they were the same information written a second time: a strength is a
 * requirement it just said meets and quoted, a gap is one nothing could be
 * found for, and evidence is the quote it already gave. Three extra lists on
 * every CV, at five times the input price, restating what the verdicts hold —
 * so they are computed here, for nothing, and the model writes less.
 *
 * The wording of a gap matters and is the reason this is not a one-liner.
 * no_evidence means the CV is silent, not that the candidate cannot do it, and
 * a list that renders silence as failure is exactly the mistake the scorer is
 * careful to avoid. The two are phrased differently, and only contradicted is
 * stated as a fact about the person.
 */
export function deriveHighlights(breakdown, { limit = 8 } = {}) {
  const rows = breakdown ?? []
  const byTier = (a, b) => (TIER_WEIGHT[b.tier] ?? 0) - (TIER_WEIGHT[a.tier] ?? 0)

  /* The model's own one-line reason where it gave one, because it says what
     this candidate did; the requirement text otherwise, which at least says
     what was being asked. */
  const said = (row) => (String(row.reason ?? '').trim() || String(row.requirement ?? '').trim())

  const strengths = rows
    .filter((row) => row.status === 'meets')
    .sort(byTier)
    .map(said)
    .filter(Boolean)
    .slice(0, limit)

  const gaps = [
    ...rows
      .filter((row) => row.status === 'contradicted')
      .sort(byTier)
      .map((row) => `${row.requirement} — the CV shows otherwise`),
    ...rows
      .filter((row) => row.status === 'no_evidence' && row.tier === 'must_have')
      .map((row) => `${row.requirement} — the CV does not mention it`),
  ].slice(0, limit)

  const evidence = rows
    .filter((row) => String(row.quote ?? '').trim().length > 0)
    .sort(byTier)
    .map((row) => ({ claim: said(row), quote: String(row.quote).trim() }))
    .slice(0, limit)

  return { strengths, gaps, evidence }
}

/**
 * Whether a score rests on enough evidence to show as a number.
 *
 * Below the floor the fit is arithmetically fine and practically meaningless:
 * 100% of the one requirement out of nine that the CV happened to mention is
 * not a strong candidate, and displaying it as 100 is confidently wrong in the
 * direction that costs a recruiter money. Those rows are shown, and shown as
 * needing review — never silently dropped, because an unreadable CV is a
 * problem to look at rather than a candidate to discard.
 */
export function needsReview(coverage) {
  return coverage < MATCHING.coverageFloor
}
