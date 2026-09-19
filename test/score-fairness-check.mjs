/**
 * A relevant candidate is never shown 0%.
 *
 * This suite exists because of a real one. A CV was uploaded against a Hebrew
 * job description and came back at 0% — not low, zero — and the candidate was a
 * plausible fit for the role. Three separate faults stacked up:
 *
 *  1. Tokenising split on /[^a-z0-9+#.-]+/, so every Hebrew character counted
 *     as punctuation and a Hebrew posting produced NO words at all: no
 *     keywords, no title tokens, therefore no scoring components and a total of
 *     zero by construction.
 *  2. The model returns requirements as sentences — "Ability to make real-time
 *     decisions based on transaction data" — and these were searched for in the
 *     CV as literal strings. No CV contains such a string, so every requirement
 *     scored zero even in English.
 *  3. A requirement in an alphabet the CV does not use was scored zero rather
 *     than set aside, so an unanswerable question dragged the weighted total
 *     down as though the candidate had failed it.
 *
 * No server and no database: this drives the scorer directly, because the
 * arithmetic is the thing under test.
 */
import { createReporter } from './helpers.mjs'
import { scoreCandidate, keywordsFrom, contentTokens } from '../server/src/match.js'
import { normalizeUniverse } from '../server/src/matching/normalize.js'

const { check, section, finish } = createReporter('Score fairness')

const MATAN = `MATAN CUTLER Hertzeliya Israel
Executive Staff NCO, Intelligence Corps, Israel Defence Forces, Tel-Aviv.
Served in the personal bureau of senior commanders, managing high-priority schedules,
sensitive information flow and strategic administrative workflows. Processed, reviewed and
managed official bureau documentation and drafted comprehensive executive summaries.
Front Desk Operations, Steele Tennis. Managed facility administration, client scheduling,
point-of-sale payment processing and daily cash/card balancing. Resolved real-time customer
complaints and operational bottlenecks. Operations and Customer Service, Domino's Pizza.
Executed point-of-sale transactions and daily register balancing during high-volume periods.
B.B.A Reichman University: Business Management, Quantitative Methods, Financial Principles.`

const CHEF = `DANIEL ROTH Pastry chef, twelve years in hotel kitchens. Menu design, seasonal
desserts, plated service. Managed a brigade of six. Trained apprentices in laminated doughs.
Culinary Institute diploma. Baking, chocolate tempering, inventory ordering.`

const ANALYST = `SARAH BEN-DAVID Risk Analyst at an online payments company. Reviewed merchant
transactions in real time, approving or declining based on transaction data. Built fraud
decision rules. Strong analytical thinking and attention to detail. Served business clients.`

/* Exactly the shape deterministicFit builds: sentences, not keywords, and a
   title still in the language the recruiter typed. */
const ROLE = {
  requiredSkills: ['Analytical thinking, attention to detail and decision-making ability'],
  preferredSkills: ['Ability to make real-time decisions based on transaction data'],
  title: 'משרת חיתום',
  jobDescription: 'Reviewing online transactions, reading transaction data, approving or declining in real time.',
  keywords: ['Service orientation toward business clients / merchants'],
}

const scoreOf = (cv) => scoreCandidate({ cv_text: cv, skills: [] }, ROLE).score

section('Words exist in every alphabet')
check('a Hebrew posting yields keywords', keywordsFrom('משרת חיתום עסקאות אונליין מול בית עסק').length > 0,
  'this returned [] and was the whole of the 0%')
check('English is unchanged',
  keywordsFrom('Senior backend engineer Python PostgreSQL').includes('postgresql'))
check('and an accented word survives', contentTokens('Ingénieur logiciel expérimenté').includes('ingénieur'),
  'a French CV tokenised to nothing for the same reason')

section('A requirement is a sentence, and is judged on its content')
const matan = scoreOf(MATAN)
const chef = scoreOf(CHEF)
const analyst = scoreOf(ANALYST)

check('a plausible candidate is not zero', matan > 0, `${matan}%`)
check('and is well clear of zero', matan >= 15, `${matan}% — "not quite" must not look like "not at all"`)
check('the ideal candidate scores high', analyst >= 70, `${analyst}%`)
check('an irrelevant one stays low', chef < 15, `${chef}%`)
check('and the order is right', analyst > matan && matan > chef,
  `analyst ${analyst} > matan ${matan} > chef ${chef}`)

section('A question the CV cannot answer is set aside, not failed')
/* The title is Hebrew and the CVs are English. Scoring that component zero
   would silently spend its weight on a test nobody could pass. */
const withHebrewTitle = scoreCandidate({ cv_text: ANALYST, skills: [] }, ROLE)
const withNoTitle = scoreCandidate({ cv_text: ANALYST, skills: [] }, { ...ROLE, title: '' })
check('an untranslatable title costs nothing', withHebrewTitle.score === withNoTitle.score,
  `${withHebrewTitle.score}% vs ${withNoTitle.score}%`)
check('and no title component is reported',
  !(withHebrewTitle.breakdown ?? []).some((c) => c.key === 'title'))

section('Hebrew on both sides matches normally')
const hebrewCv = 'מנתח סיכונים בחברת תשלומים אונליין. קבלת החלטות בזמן אמת על בסיס נתוני עסקאות מול בית עסק.'
const hebrewRole = {
  requiredSkills: ['קבלת החלטות בזמן אמת על בסיס נתוני עסקאות'],
  preferredSkills: [],
  title: 'חיתום',
  jobDescription: 'חיתום עסקאות אונליין',
  keywords: [],
}
check('a Hebrew CV scores against a Hebrew role',
  scoreCandidate({ cv_text: hebrewCv, skills: [] }, hebrewRole).score > 40,
  `${scoreCandidate({ cv_text: hebrewCv, skills: [] }, hebrewRole).score}%`)

section('The displayed score is relative to the pool')
/* What the recruiter actually reads: absolute fit mapped across everyone
   analysed, so a lone candidate is not punished for having no company. */
const alone = normalizeUniverse([{ candidateId: 'm', absoluteFit: matan }])
check('a single candidate is scored on their own merit', alone.get('m') > matan,
  `raw ${matan} shown ${alone.get('m')}`)

const field = normalizeUniverse([
  { candidateId: 'm', absoluteFit: matan },
  { candidateId: 'c', absoluteFit: chef },
  { candidateId: 'a', absoluteFit: analyst },
])
check('a strong field pushes a partial fit down', field.get('m') < alone.get('m'),
  `${alone.get('m')}% alone vs ${field.get('m')}% against a strong field`)
check('and the best reaches the top of the scale', field.get('a') === 100, `${field.get('a')}%`)
check('while the weakest stays at the bottom', field.get('c') < field.get('m'))

section('Silence is priced, so saying less cannot help')

/*
 * The arithmetic excluded no_evidence from both halves of the fraction,
 * which made silence strictly better than evidence: a requirement nobody
 * could check cost nothing, while the same requirement marked `partial`
 * cost 0.4 of its weight. Two candidates, one demonstrably closer to the
 * job, and the ranking preferred the one who said less.
 */
const { scoreAgainst, silenceFraction, quoteIsInText, checkQuotes, rescoreBreakdown } =
  await import('../server/src/matching/score.js')

const NINE = [
  { id: 'r1', tier: 'must_have', text: 'card-not-present review' },
  { id: 'r2', tier: 'must_have', text: 'chargebacks end to end' },
  { id: 'r3', tier: 'must_have', text: 'SQL' },
  { id: 'r4', tier: 'must_have', text: 'Hebrew and English' },
  { id: 'r5', tier: 'preferred', text: 'fraud tooling' },
  { id: 'r6', tier: 'preferred', text: 'rules engines' },
  { id: 'r7', tier: 'preferred', text: 'PSP or acquirer' },
  { id: 'r8', tier: 'contextual', text: 'small team' },
  { id: 'r9', tier: 'contextual', text: 'multi-site' },
]

const REST = [
  { requirement_id: 'r1', status: 'meets' }, { requirement_id: 'r3', status: 'meets' },
  { requirement_id: 'r4', status: 'meets' }, { requirement_id: 'r5', status: 'partial' },
  { requirement_id: 'r6', status: 'no_evidence' }, { requirement_id: 'r7', status: 'no_evidence' },
  { requirement_id: 'r8', status: 'meets' }, { requirement_id: 'r9', status: 'no_evidence' },
]

const silent = scoreAgainst(NINE, [...REST, { requirement_id: 'r2', status: 'no_evidence' }])
const partial = scoreAgainst(NINE, [...REST, { requirement_id: 'r2', status: 'partial' }])

check('evidence beats silence on the same CV', partial.fit > silent.fit,
  `unmentioned ${silent.fit}, partial ${partial.fit} — it used to be the other way round`)
check('and coverage still counts silence as unchecked', partial.coverage > silent.coverage,
  `${silent.coverage}% vs ${partial.coverage}% — fit and coverage answer different questions`)

const oneOfNine = scoreAgainst(NINE, [{ requirement_id: 'r1', status: 'meets' }])
check('one requirement of nine no longer scores 100', oneOfNine.fit < 60,
  `${oneOfNine.fit}% on ${oneOfNine.coverage}% coverage`)

check('silence sits between contradicted and partial',
  silenceFraction() > 0 && silenceFraction() < 0.6, String(silenceFraction()))

check('a CV nothing could be read from still has no opinion',
  scoreAgainst(NINE, []).fit === null,
  'null, not the silence fraction — a confident number for a document we failed to read')

section('A quote that is not in the CV is not evidence')

const CV = 'Served in the personal bureau of senior commanders, managing '
  + 'high-priority schedules. Owned the dispute process end-to-end.'

check('an exact quote passes', quoteIsInText('managing high-priority schedules', CV))
check('punctuation and case do not matter',
  quoteIsInText('OWNED THE DISPUTE PROCESS END TO END', CV),
  'a model silently normalises dashes and quotes; the check is about the words')
check('an invented quote fails', !quoteIsInText('led a team of forty engineers in Berlin', CV))
check('something too short to judge passes', quoteIsInText('SQL', CV),
  'generous on purpose — a false positive costs a real candidate a real place')

const bad = checkQuotes([
  { requirement: 'scheduling', tier: 'must_have', weight: 30, status: 'meets', quote: 'managing high-priority schedules' },
  { requirement: 'Berlin', tier: 'must_have', weight: 30, status: 'meets', quote: 'led a team of forty engineers in Berlin' },
], CV)

check('the unsupported verdict is downgraded and counted',
  bad.downgraded === 1 && bad.breakdown[1].status === 'no_evidence'
  && bad.breakdown[0].status === 'meets')
check('and it keeps its quote, so the downgrade can be looked at',
  bad.breakdown[1].quote.length > 0 && bad.breakdown[1].quoteUnverified === true)

check('a stored breakdown can be rescored with no requirements and no model',
  rescoreBreakdown(bad.breakdown).fit !== null,
  'each entry carries its own tier and weight — that is what makes the migration possible')

finish()
