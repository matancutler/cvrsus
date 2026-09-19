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

/** Unknown requirements are excluded from coverage and earn SILENCE below. */
const UNKNOWN = 'no_evidence'

/**
 * What a requirement nobody could check is worth.
 *
 * It used to be worth nothing at all — excluded from both halves of the
 * fraction — and that made silence strictly better than evidence. A CV that
 * never mentioned chargebacks scored higher than the same CV with adjacent
 * chargeback experience marked `partial`, because the first took the
 * requirement out of the denominator and the second paid 0.6 of it. Two
 * candidates, one of them demonstrably closer to the job, and the ranking
 * preferred the one who said less.
 *
 * Worse at the top of the scale: a CV meeting one requirement of nine and
 * mentioning nothing else scored 100 — one for one — and could sit above a
 * candidate who met seven.
 *
 * So silence is priced. 0.35 sits above `contradicted`, which is a proven
 * failure, and below `partial`, which is real evidence of something — the
 * order is the claim, and it is the one the old arithmetic got backwards.
 * The number itself is a starting point and is tuned in the eval; it is a
 * setting so that tuning does not need a deploy.
 *
 * COVERAGE is untouched by this and still counts silence as not checked.
 * That is the whole reason the two numbers exist separately: fit says how
 * good the case is, coverage says how much of the job the case rests on, and
 * folding the second into the first is what this fraction is carefully not
 * doing.
 */
const SILENCE = (() => {
  const raw = Number(process.env.MATCH_SILENCE_FRACTION ?? 0.35)
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.35
})()

/** Exported so the migration and the eval can price old verdicts the same way. */
export function silenceFraction() {
  return SILENCE
}

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

    /*
     * Everything counts towards fit now, including silence.
     *
     * The denominator is the whole job rather than the part of it the CV
     * happened to address — which is what stops a candidate improving their
     * score by saying less. `knownWeight` still counts only what was
     * genuinely judged, because that is coverage's question and it has not
     * changed.
     */
    if (status !== UNKNOWN) knownWeight += weight
    earned += (status === UNKNOWN ? SILENCE : (MULTIPLIER[status] ?? 0)) * weight
  }

  return {
    /*
     * Nothing checkable at all means no opinion, not 35.
     *
     * With silence priced, a CV nobody could read anything out of would
     * otherwise land on exactly the silence fraction — a confident-looking
     * number for a document we failed to read. `null` is the honest answer
     * and the callers already handle it; this is the same guard the old
     * arithmetic had, kept for the same reason.
     */
    fit: knownWeight === 0 ? null : Math.round((earned / totalWeight) * 100),
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
 * Checks that a quoted line is actually in the CV.
 *
 * Every verdict the model returns carries the sentence it read the claim
 * out of. Nothing has ever checked that the sentence is there. A quote that
 * is not in the document is one of two things, and both matter: the model
 * invented the evidence, or it paraphrased — and a paraphrase presented as a
 * quotation is the shape of an invention even when the conclusion is right.
 *
 * Compared after flattening everything that can differ without the meaning
 * differing: case, every kind of whitespace, and the punctuation a model
 * silently normalises. Curly quotes become straight, dashes become hyphens,
 * and then all punctuation is dropped — so "end-to-end." matches "end to
 * end" and the check is about the words rather than the typography.
 *
 * Deliberately generous. A false positive here downgrades a verdict that
 * was correct, which costs a real candidate a real place in the ranking; a
 * false negative lets a sloppy quote through, which costs nothing anybody
 * can see. When in doubt this says yes.
 */
const PUNCTUATION = /[\u2018\u2019\u201c\u201d\u2013\u2014.,;:!?()[\]{}"'`/\\|&*_~^<>+=-]+/g

export function flattenForQuote(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function quoteIsInText(quote, cvText) {
  const needle = flattenForQuote(quote)
  /* Nothing to check. A verdict with no quote is not a verdict claiming
     evidence, and `meets` without a quote is a separate problem the schema
     is responsible for. */
  if (!needle) return true
  /* Too short to be evidence of anything, and too short to fail honestly:
     "sql" appears in half the CVs on the platform by accident. */
  if (needle.length < 12) return true

  const haystack = flattenForQuote(cvText)
  if (!haystack) return true

  return haystack.includes(needle)
}

/**
 * Downgrades verdicts whose quote is not in the CV, and says how many.
 *
 * Applied to the breakdown rather than to the model's raw answer, so the
 * migration can run it over verdicts stored months ago and get the same
 * result as the live path gets on a fresh one.
 *
 * A downgraded verdict becomes `no_evidence` and keeps its quote and reason
 * for the record — throwing them away would leave nothing to look at when
 * somebody asks why a score moved, and the whole point of counting these is
 * that somebody looks.
 */
export function checkQuotes(breakdown, cvText) {
  let downgraded = 0
  const examples = []

  const checked = (breakdown ?? []).map((row) => {
    if (row.status === UNKNOWN) return row
    if (quoteIsInText(row.quote, cvText)) return row

    downgraded += 1
    if (examples.length < 3) {
      examples.push({ requirement: row.requirement, was: row.status, quote: row.quote })
    }
    return { ...row, status: UNKNOWN, quoteUnverified: true }
  })

  return { breakdown: checked, downgraded, examples }
}

/**
 * Fit and coverage from a breakdown that has already been scored once.
 *
 * scoreAgainst() needs the requirement list; this needs only the breakdown,
 * because each entry already carries its tier and weight. That is what lets
 * a score be recomputed from what is stored — no requirements to look up, no
 * job description to re-read, and above all no model call.
 */
export function rescoreBreakdown(breakdown) {
  let knownWeight = 0
  let totalWeight = 0
  let earned = 0

  for (const row of breakdown ?? []) {
    const weight = Number(row.weight) || TIER_WEIGHT[row.tier] || TIER_WEIGHT.contextual
    totalWeight += weight
    if (row.status !== UNKNOWN) knownWeight += weight
    earned += (row.status === UNKNOWN ? SILENCE : (MULTIPLIER[row.status] ?? 0)) * weight
  }

  return {
    fit: knownWeight === 0 ? null : Math.round((earned / totalWeight) * 100),
    coverage: totalWeight === 0 ? 0 : Math.round((knownWeight / totalWeight) * 100),
    knownWeight,
    totalWeight,
  }
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
