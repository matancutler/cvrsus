/**
 * Model output is not language until something has checked.
 *
 * A verdict was stored with its reason set to the word "ok" repeated
 * twenty-one times. It satisfied the JSON schema — a string of at most 180
 * characters — parsed cleanly, and was written to the database, where it would
 * have been rendered beside a candidate as this product's explanation of why
 * they were judged the way they were.
 *
 * Nothing looked at it, because a schema constrains shape and not sense. These
 * checks cover the floor that now stands between a model and the database, and
 * the two ways it can be wrong: letting rubbish through, and refusing honest
 * text. The second is the one that costs a candidate something, so it has the
 * most cases here.
 */
import fs from 'node:fs'

import { createReporter } from './helpers.mjs'
import {
  proseProblem, isUsableProse, usableOrPlaceholder, PLACEHOLDER,
} from '../server/src/matching/prose.js'

const { section, check, finish } = createReporter('Prose')

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

section('The corruption that prompted this')

/* Verbatim, from a real analysis. */
const REAL = 'Degree is business and economics, not electrical engineering.'
  + '.ok'.repeat(21)

check('the reason that started it is refused', proseProblem(REAL) === 'repeated tokens', REAL.slice(0, 70))
check('and it would have passed the schema it was written against',
  REAL.length < 400 && typeof REAL === 'string',
  'a string under the cap — which is all the schema ever asked')

check('a bare run of one token is refused',
  proseProblem('ok ok ok ok ok ok ok ok') === 'repeated tokens')
check('a degenerate tail on a real sentence is refused',
  proseProblem('Five years in payments operations at a bank. ok ok ok ok ok ok') === 'repeated tokens',
  'the ratio test alone misses this, which is why there is a run-length test too')

section('And the ways it could be wrong in the other direction')

/*
 * Every one of these is text a model might legitimately produce about a real
 * candidate. A floor that refuses any of them costs somebody a place in a
 * ranking for no reason, which is worse than the rubbish it was built to
 * catch — so they are tested first-class rather than as an afterthought.
 */
const HONEST = [
  ['a plain reason', 'Ran SQL against the transaction database daily.'],
  ['a reason that repeats a word deliberately', 'No evidence, no evidence at all of this in the CV.'],
  ['Hebrew', 'שירת בצהל כקצין מודיעין ולכן יש לו ניסיון ניהולי מוכח'],
  ['a quoted fragment', 'The CV says "owned the dispute process end-to-end", which covers it.'],
  ['numbers and punctuation', 'Managed 14 sites and closed a NIS 180M facility; directly on point.'],
  ['a terse two-word verdict', 'Not mentioned.'],
  ['an em-dashed clause', 'Payments operations — four years, at a bank, on the exact product.'],
]

for (const [what, text] of HONEST) {
  check(`${what} passes`, isUsableProse(text), text.slice(0, 56))
}

section('The obvious failures')

check('empty is empty', proseProblem('') === 'empty')
check('whitespace is empty', proseProblem('   \n  ') === 'empty')
check('punctuation alone has no letters', proseProblem('... --- ...') === 'no letters')
check('one word is not a sentence', proseProblem('yes') === 'not a sentence')
check('far over the cap is refused', proseProblem('a b '.repeat(200)) !== null)
check('an explanation gets a longer rope than a reason',
  proseProblem('word '.repeat(90), { kind: 'explanation' }) !== 'too long'
  && proseProblem('word '.repeat(90), { kind: 'reason' }) === 'too long',
  'the schema asks for 180 on a reason and 400 on an explanation')

section('The second shape: the answer stops being prose and becomes markup')

/*
 * Verbatim from the medium-effort run in the disagreement sample — a second
 * copy of the field spliced onto the first with its JSON key still attached,
 * and a training-data citation token trailing after it. Every repetition test
 * passes it: varied tokens, healthy distinct ratio, under the length cap,
 * mostly real words.
 */
const LEAKED = 'Benchmarking and range analysis show quantitative work, though not '
  + 'transaction-grade analytics.reason:analysis at a professional services firm '
  + 'evidences quantitative reasoning.:contentReference[oaicite:0]{index=0}'

check('the leaked citation is refused', proseProblem(LEAKED) === 'leaked markup',
  'it is not degenerate by any repetition measure, and it is still not a sentence '
  + 'to put on a candidate’s card')
check('and the repetition tests alone would have passed it',
  proseProblem(LEAKED.replace(/:contentReference.*$/, '').replace('.reason:', '. ')) === null,
  'which is why this needed a rule of its own rather than a wider repetition threshold')

check('a JSON key spliced mid-sentence is refused',
  proseProblem('No degree is listed."quote":"B.B.A - Reichman University"') === 'leaked markup')
check('a bracketed citation is refused',
  proseProblem('Six years in audit, not electrical design. 【4†15†source】') === 'leaked markup')

check('but a plain colon after a common word is not',
  proseProblem('The reason: no engineering degree is listed anywhere.') === null,
  'a person may legitimately write that, and refusing it would delete honest text')
check('nor is a quoted CV fragment',
  proseProblem('Quote reads "Financial modeling & valuation", which implies Excel.') === null)
check('nor is Hebrew reasoning',
  proseProblem('הרקע האקדמי בהנדסת תעשייה, לא חשמל.') === null)

section('What gets stored when it fails')

check('a usable reason is stored as written',
  usableOrPlaceholder('Four years in payments operations.') === 'Four years in payments operations.')
check('a corrupt one becomes a visible placeholder',
  usableOrPlaceholder(REAL) === PLACEHOLDER.reason)
check('and the placeholder reads as one',
  /^\(.*\)$/.test(PLACEHOLDER.reason) && /no readable/i.test(PLACEHOLDER.reason),
  'storing the mangled text, or an empty string that renders as nothing, both '
  + 'present the absence as though it were the product’s considered opinion')
check('absence stays absence',
  usableOrPlaceholder('') === '',
  'a verdict with nothing to say is not a verdict whose explanation was mangled, '
  + 'and filling every silent one would apologise on rows that never had a problem')

check('the caller is told what was wrong', (() => {
  const seen = []
  usableOrPlaceholder(REAL, { onProblem: (why) => seen.push(why) })
  return seen.length === 1 && seen[0] === 'repeated tokens'
})(), 'so a scan can report the shape of the corruption it found')

section('And it is actually wired in')

const ai = read('../server/src/ai.js')

check('the analysis checks before it returns', /usableOrPlaceholder\(answer\.reasoning/.test(ai))
/* The call moved out of the object literal when the reason-vs-verdict gate
   landed beside it, so the assertion follows the call rather than the line it
   used to sit on. It still tests the thing that matters: every verdict's reason
   goes through the gate on its way to storage. */
check('every verdict reason too',
  /const reason = usableOrPlaceholder\(row\.reason, \{ kind: 'reason'/.test(ai)
  && /return \{ \.\.\.row, reason,/.test(ai))
check('and it asks once more before giving up',
  /asking once more/.test(ai) && /const ask = \(\) =>/.test(ai),
  'a model that degenerated in one field was not attending to the others either')
/* The reassignment, not the declaration: `let response = await ask()` contains
   the same substring, so a loose count reads the first call as a retry. */
check('the retry is bounded to one',
  (ai.match(/^\s*response = await ask\(\)/gm) ?? []).length === 1,
  'the second failure is a signal about the input; paying a third time does not change it')

finish()
