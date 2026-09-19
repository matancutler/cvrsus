/**
 * The score is computed from the model's verdicts, not chosen by the model.
 *
 * `MATCH_SCHEMA` used to require `score: 0-100`, with calibration bands in the
 * prompt. A model judges "does this CV evidence this requirement" extremely
 * well and holds a numeric rubric across thousands of independent calls
 * extremely badly — nothing anchors the four-hundredth call to the twelfth — so
 * the number drifted, the ranking drifted with it, and no score could be
 * explained after the fact.
 *
 * These checks cover the contract in both directions: what the model is asked
 * for, and what the arithmetic does with the answer.
 */
import { createReporter } from './helpers.mjs'
import { scoreAgainst, needsReview } from '../server/src/matching/score.js'
import { requirementsFrom } from '../server/src/matching/analysis.js'

const { check, section, finish } = createReporter()

const REQS = [
  { id: 'R1', text: 'five years backend', tier: 'must_have' },
  { id: 'R2', text: 'Python',             tier: 'must_have' },
  { id: 'R3', text: 'Kubernetes',         tier: 'must_have' },
  { id: 'R4', text: 'fintech background', tier: 'preferred' },
  { id: 'R5', text: 'startup experience', tier: 'contextual' },
]

const verdicts = (map) => Object.entries(map).map(([id, status]) => ({ requirement_id: id, status }))

section('Silence is not failure — the whole point')
const quiet = scoreAgainst(REQS, verdicts({
  R1: 'meets', R2: 'meets', R3: 'no_evidence', R4: 'meets', R5: 'no_evidence',
}))
const denied = scoreAgainst(REQS, verdicts({
  R1: 'meets', R2: 'meets', R3: 'contradicted', R4: 'meets', R5: 'contradicted',
}))

/*
 * 78, not 100, and that change is the point of the new arithmetic.
 *
 * Silence used to leave the sum entirely: an unanswered requirement was
 * struck from the denominator as well as the numerator, so a CV that
 * answered four of five requirements well scored exactly the same as a CV
 * that answered all five well. That is not what a recruiter means by a
 * match, and it rewarded the thin CV over the thorough one - the less a
 * document said, the fewer chances it had to be wrong.
 *
 * Silence now earns a fraction of its weight (MATCH_SILENCE_FRACTION, 0.35)
 * against the full denominator. It costs something, because an unevidenced
 * must-have is a real risk. It does not cost everything, because a CV that
 * does not mention Kubernetes is not a CV saying the candidate cannot do it
 * - and that distinction is the whole difference between this and `denied`.
 */
check('a CV that says nothing about Kubernetes still scores well',
  quiet.fit === 78,
  `${quiet.fit} - two unknowns in 105 of weight, each earning 0.35 of its own`)
check('and reports how much it could actually check',
  quiet.coverage === 67,
  `${quiet.coverage}% — a must-have (30) and a contextual (5) are unknown, so 70 of 105 weight was checked`)
check('a CV that contradicts the same requirements scores lower',
  denied.fit < quiet.fit, `${denied.fit} vs ${quiet.fit}`)
check('and the gap is the whole distinction between silent and wrong',
  quiet.fit - denied.fit === 11,
  `${quiet.fit} - ${denied.fit}: saying nothing costs 0.65 of the weight, `
  + 'saying the wrong thing costs all of it')
check('while claiming full evidence', denied.coverage === 100,
  'nothing was unknown — the CV answered every requirement, badly')

section('An unknown must-have costs more coverage than an unknown nice-to-have')
const missingCore = scoreAgainst(REQS, verdicts({
  R1: 'no_evidence', R2: 'meets', R3: 'meets', R4: 'meets', R5: 'meets',
}))
const missingNice = scoreAgainst(REQS, verdicts({
  R1: 'meets', R2: 'meets', R3: 'meets', R4: 'meets', R5: 'no_evidence',
}))
check('coverage is weighted, not counted',
  missingCore.coverage < missingNice.coverage,
  `core unknown ${missingCore.coverage}% vs nice unknown ${missingNice.coverage}%`)

section('Partial evidence is worth something, and not everything')
const partial = scoreAgainst(REQS, verdicts({ R1: 'partial', R2: 'partial', R3: 'partial', R4: 'partial', R5: 'partial' }))
const full = scoreAgainst(REQS, verdicts({ R1: 'meets', R2: 'meets', R3: 'meets', R4: 'meets', R5: 'meets' }))
check('all-partial scores below all-meets', partial.fit < full.fit, `${partial.fit} vs ${full.fit}`)
check('but well above nothing', partial.fit > 0, `${partial.fit}`)

section('A thin CV is flagged, not silently trusted')
const thin = scoreAgainst(REQS, verdicts({ R1: 'meets', R2: 'no_evidence', R3: 'no_evidence', R4: 'no_evidence', R5: 'no_evidence' }))
/*
 * 54, where this used to be 100.
 *
 * One met must-have and four unanswered requirements produced a perfect
 * score, because the four left the denominator along with the numerator. It
 * was the least defensible number the old arithmetic could produce and the
 * one a recruiter was most likely to act on: a CV that said one true thing
 * and nothing else, at the top of the list. A little over half is what "we
 * could check a third of this job, and what we checked was good" should
 * look like.
 */
check('one met requirement out of five is no longer arithmetically 100',
  thin.fit === 54,
  `${thin.fit} - 30 earned outright and 26.25 across four silences, over 105`)
check('and is correctly called out as needing review', needsReview(thin.coverage),
  `${thin.coverage}% evidence — showing this as 100 would be confidently wrong`)
check('a well-evidenced score is not flagged', !needsReview(quiet.coverage), `${quiet.coverage}%`)

section('A bad response cannot manufacture a score')
check('missing verdicts become unknown, not met',
  scoreAgainst(REQS, verdicts({ R1: 'meets' })).coverage === 29,
  'the other four are absent and counted against coverage')
check('an unrecognised status is treated as unknown',
  scoreAgainst(REQS, [{ requirement_id: 'R1', status: 'excellent' }]).breakdown[0].status === 'no_evidence')
check('nothing checkable yields no opinion rather than zero',
  scoreAgainst(REQS, []).fit === null,
  'a zero would rank an unreadable CV below a genuinely poor one')
check('and no requirements at all does not divide by zero',
  scoreAgainst([], []).fit === null && scoreAgainst([], []).coverage === 0)

section('Every point is traceable')
const one = quiet.breakdown.find((b) => b.id === 'R3')
check('each requirement reports its own verdict', one?.status === 'no_evidence')
check('with the text a recruiter reads', one?.requirement === 'Kubernetes')
check('and the weight it carried', one?.weight === 30, `${one?.weight}`)

section('Requirement ids are stable for a job')
const profile = {
  mustHaves: [{ requirement: 'Python' }, { requirement: 'five years' }],
  preferred: [{ requirement: 'fintech' }],
  contextual: ['startup'],
}
const first = requirementsFrom(profile)
const again = requirementsFrom(profile)
check('the same profile gives the same ids',
  JSON.stringify(first) === JSON.stringify(again),
  'ids assigned per candidate would make verdicts unjoinable across a batch')
check('tiers come from where the requirement sat',
  first[0].tier === 'must_have' && first[2].tier === 'preferred' && first[3].tier === 'contextual')
check('and hard constraints are excluded from fit',
  requirementsFrom({ ...profile, hardConstraints: [{ requirement: 'work permit' }] }).length === first.length,
  'a gate decides eligibility; it must not be something strong candidates outscore')

finish()
