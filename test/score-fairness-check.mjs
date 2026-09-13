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

finish()
