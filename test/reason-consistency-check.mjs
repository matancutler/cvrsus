/**
 * A reason has to argue for the verdict standing beside it.
 *
 * Two of twenty-one hand-read disagreements had a reason making the case for a
 * different answer than the one it was filed under. The worst was a `partial`
 * whose reason ended "evidencing resilience under pressure" — which is the
 * sentence you write for `meets`. Whatever the right verdict was, a row whose
 * explanation argues the other way is the one a recruiter raises a ticket
 * about, because the sentence is the part they read.
 *
 * The gate is lexical and cheap: no model, no network, no opinion about whether
 * the verdict is CORRECT. These checks cover the two ways it can be wrong, and
 * the second one — refusing honest text — has far more cases here, because that
 * is the failure that costs a candidate something.
 */
import fs from 'node:fs'

import { createReporter } from './helpers.mjs'
import { reasonDisagrees } from '../server/src/matching/prose.js'

const { section, check, finish } = createReporter('Reason vs verdict')

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const flags = (status, reason) => reasonDisagrees(status, reason) !== null

section('The failure that prompted this')

/* Verbatim from the disagreement sample, case 17. The verdict was `partial`;
   the reason is an unqualified argument for `meets`. */
const CASE_17 = 'Led a listed company out of crisis to a tenfold shareholder return, '
  + 'evidencing resilience under pressure.'

check('a partial whose reason names no limit is caught',
  flags('partial', CASE_17),
  'the sentence makes the whole case and withholds nothing, which is the shape '
  + 'of a meets')
check('and the problem says which way it argues',
  /names no limit/.test(reasonDisagrees('partial', CASE_17)),
  'so a log line is readable without the reason text beside it')
check('the same sentence under meets is fine',
  !flags('meets', CASE_17),
  'the text was never the defect; the pairing was')

/* The other direction, which does not occur in the sampled material and is
   worth catching anyway: a meets resting on something the CV does not contain. */
check('a meets whose reason says the evidence is absent is caught',
  flags('meets', 'Strong commercial background, but the certification is not mentioned anywhere.'))
check('and so is the bare form',
  flags('meets', 'Ten years in the domain; no evidence of the required licence.'))

section('And the ways it could be wrong in the other direction')

/*
 * Every one of these is a real stored reason or a close paraphrase of one, and
 * every one must pass. Measured over the 625 verdicts on the development
 * database the rule flags 5 — 0.8% — and these are the shapes that make the
 * other 620 survive.
 */
const HONEST = [
  ['partial', 'Commercial proposal evaluation and negotiation, but not technical specifications.'],
  ['partial', 'Procurement and hardware prototype coordination, though not construction or commissioning support'],
  ['partial', 'Private fundraising exposure only; no M&A, LBO or capital markets deal experience.'],
  ['partial', 'Professional working English stated, slightly below the high proficiency asked for.'],
  ['partial', 'Modeling work implies spreadsheet fluency, but Excel is never named directly.'],
  ['partial', 'Two years against a five-year requirement.'],
  ['partial', 'Adjacent experience in a regulated domain, rather than in payments.'],
  ['partial', 'Budget ownership is indirect evidence of transaction modelling.'],
  ['no_evidence', 'Career is entirely in accounting, audit and financial control; no electrical design work described.'],
  ['no_evidence', 'The CV does not mention Kubernetes.'],
  ['no_evidence', 'Nothing in the document bears on this.'],
  ['contradicted', 'Degree named is business administration, not electrical engineering.'],
  ['contradicted', 'States a total working life of three and a half years, short of the five required.'],
  ['contradicted', 'Grades their own English below the level asked for.'],
]

for (const [status, reason] of HONEST) {
  check(`${status}: ${reason.slice(0, 54)}…`, !flags(status, reason))
}

section('A meets is held to a much narrower test, and this is why')

/*
 * Seventeen per cent of real `meets` reasons carry a stray negation. A rule
 * that convicted on a bare "not" or "rather than" would fire on eighteen of the
 * hundred and six stored ones, every one of them legitimate — so `meets` is
 * flagged only on a hard statement that the thing is not in the document.
 */
const GOOD_MEETS = [
  'Roughly twenty years of experience, far beyond the five-year bar.',
  'Twelve years of commercial experience, though in sales rather than engineering.',
  'Led the payments rewrite, not merely contributed to it.',
  'Runs the function today, with no gap since 2019.',
  'Owns the P&L for three units; nothing here is delegated.',
  'Qualified in Israel rather than the UK, which the requirement allows.',
]

for (const reason of GOOD_MEETS) {
  check(`meets: ${reason.slice(0, 54)}…`, !flags('meets', reason))
}

section('Hebrew is read, not guessed at')

check('a Hebrew partial that names its limit passes',
  !flags('partial', 'מנהל צוות במשרה דומה, אך ללא ניסיון בינלאומי.'),
  'אך and ללא are both in the set, and neither would be found by a \\b matcher — '
  + '\\b is defined on ASCII word characters')
check('and one that names none is left alone rather than flagged',
  !flags('partial', 'ניסיון נרחב בניהול צוותים גדולים ומורכבים בארגון.'),
  'the English list is measured and the Hebrew list is hand-built, so a miss is '
  + 'likelier there; silence is the right answer when the evidence for flagging '
  + 'is the absence of a word we might simply not know')
check('a mixed reason is judged on the words it does carry',
  !flags('partial', 'Mentoring is explicit and ongoing, though גיוס וחניכה is the only phrasing used.'))

section('And the things it deliberately has no opinion about')

check('an empty reason is proseProblem’s business, not this one’s',
  !flags('partial', '') && !flags('meets', '   '),
  'a verdict with nothing to say is a different defect and has its own gate')
check('a one-word reason is too short to read',
  !flags('partial', 'Adjacent'))
check('an unknown status is not judged',
  !flags('unknown', CASE_17) && !flags(undefined, CASE_17),
  'the four statuses are the contract; anything else is somebody else’s bug')

section('And it is actually wired in')

const ai = read('../server/src/ai.js')
const score = read('../server/src/matching/score.js')

check('the check runs inside the existing retry',
  /const mismatch = mustHaveIds\.has\(row\?\.requirement_id\)/.test(ai)
  && /reasonDisagrees\(row\?\.status, row\?\.reason\)/.test(ai),
  'sharing degenerate() means one retry, not two, and it sees the reason before '
  + 'capWords can amputate a trailing limiting clause')

/*
 * degenerate() returns on the FIRST bad row and a retry re-runs the WHOLE
 * analysis, so an unscoped rule at 0.8% per verdict, over fifteen to
 * twenty-five verdicts, retries roughly one analysis in eight - measured at
 * 12% over a real 25-candidate re-score. That is a 12% rise in the cost of the
 * most expensive step, much of it spent re-reading a CV because one contextual
 * requirement's sentence was terse.
 *
 * A must-have carries three times a preferred and six times a contextual, and
 * is what the score is mostly made of. Buying a second opinion there is worth
 * it; buying one for a contextual is not, and it still gets the mark.
 */
check('but only a must-have buys a second ask',
  /requirements\.filter\(\(row\) => row\?\.tier === 'must_have'\)/.test(ai),
  'a retry re-runs the whole analysis, so the trigger has to be worth a whole '
  + 'analysis')
check('while every tier still gets the mark',
  /const disagrees = reasonDisagrees\(row\.status, reason\)/.test(ai),
  'the post-retry pass is unscoped: flagging is free, asking again is not')
check('and the retry is still bounded to one',
  (ai.match(/^\s*response = await ask\(\)/gm) ?? []).length === 1,
  'the second failure is a signal about the input; paying a third time does not '
  + 'change it')
check('a surviving mismatch is flagged, never downgraded',
  /reasonUnverified: true/.test(ai) && /flagged, not downgraded/.test(ai),
  'a lexical rule with a measured false-positive rate is a fine trigger for '
  + 'asking again and is not a ranking input')
check('the flag has a route to storage',
  /\.\.\.\(verdict\?\.reasonUnverified \? \{ reasonUnverified: true \} : \{\}\)/.test(score),
  'the fixed field list in scoreAgainst is the only way through, and it swallowed '
  + 'quoteUnverified once already')
check('a flagged reason is not republished as a strength',
  /row\.reasonUnverified === true/.test(score))
check('nor as an evidence claim',
  /\.filter\(\(row\) => row\.reasonUnverified !== true\)/.test(score))

finish()
