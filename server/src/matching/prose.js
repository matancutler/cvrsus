/**
 * Whether a piece of model-written text is fit to show a recruiter.
 *
 * A verdict came back from a real analysis with its reason set to
 * "...quote shows business degree.ok.ok.ok.ok.ok." — the word "ok" repeated
 * twenty-one times. It passed the schema, which asks for a string of at most
 * 180 characters and got one; it passed JSON parsing; it was stored, and it
 * would have been rendered beside a candidate as the platform's explanation of
 * why they were judged the way they were.
 *
 * Nothing between the model and the database looked at it. A JSON schema
 * constrains shape, not sense, and every check in this codebase before now was
 * a shape check.
 *
 * ---
 *
 * WHAT THIS REFUSES, AND WHY EACH ONE
 *
 * Degeneration is the failure mode that produced the bug: a model that loses
 * the thread and emits the same token until it hits a stop. It is recognisable
 * without understanding the text at all, because human writing does not repeat
 * one short token a dozen times and the ratio of distinct tokens to total
 * tokens collapses when a model does.
 *
 * Length is refused because a field capped at 180 characters that arrives at
 * 4,000 is a model that ignored the cap, and whatever else it ignored is not
 * visible from here.
 *
 * Text with no letters is refused because a reason made of punctuation is not
 * a reason, and it is what several degeneration modes look like.
 *
 * ---
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not judge whether the reasoning is CORRECT, or whether the prose is
 * good. That is not mechanically decidable and pretending otherwise would
 * reject honest text. This is a floor, not a reviewer: it catches text that is
 * not language, and passes everything that is.
 *
 * It is also deliberately cheap — no model call, no network — because it runs
 * once per requirement, ten to fifteen times per CV, on every analysis.
 */

/** Longest a stored reason or explanation may be, in characters. */
const LIMITS = {
  /* The schema asks for 180. Twice that is room for a model that ran on a
     little, and a wall for one that ran on and on. */
  reason: 360,
  /* The schema asks for 400. Same reasoning. */
  explanation: 800,
}

/* Two words and a full stop is a reason; one word is a label. Below this the
   repetition tests have too little to work with to mean anything either. */
const MIN_WORDS = 2

/**
 * Whether the text is degenerate: the same handful of tokens, over and over.
 *
 * Measured as the share of tokens that are distinct. Ordinary prose, even
 * short and even repetitive prose, keeps this well above a half; ".ok" twenty
 * times scores 0.05. The floor is deliberately low so that a terse, legitimate
 * reason like "no evidence, no evidence at all" is never refused — this is
 * looking for a model that has stopped producing language, not one being
 * repetitive.
 */
function looksDegenerate(words) {
  if (words.length < 6) return false
  const distinct = new Set(words).size
  if (distinct / words.length < 0.34) return true

  /*
   * And the same thing again for short repeated runs, which the ratio misses
   * when the degenerate tail is bolted onto a legitimate sentence — which is
   * exactly the shape of the bug that prompted this. "Degree is business and
   * economics, not electrical engineering. ok ok ok ok ok ok" has a distinct
   * ratio near a half and is still plainly broken.
   */
  let run = 1
  for (let i = 1; i < words.length; i += 1) {
    run = words[i] === words[i - 1] ? run + 1 : 1
    if (run >= 4) return true
  }

  /* A single token taking a third of the text, wherever it sits. */
  const counts = new Map()
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1)
  const commonest = Math.max(...counts.values())
  return commonest / words.length > 0.34
}

/**
 * Why this text is not usable, or null if it is.
 *
 * A reason rather than a boolean, so the caller can log what was wrong and a
 * scan over stored rows can report the shape of the corruption it found.
 */
export function proseProblem(value, { kind = 'reason' } = {}) {
  const text = String(value ?? '').trim()

  if (!text) return 'empty'
  if (text.length > (LIMITS[kind] ?? LIMITS.reason)) return 'too long'

  /* Letters in any script: this product reads Hebrew CVs, so an ASCII-only
     test would reject a perfectly good Hebrew reason. */
  if (!/\p{L}/u.test(text)) return 'no letters'

  const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
  if (words.length < MIN_WORDS) return 'not a sentence'
  if (looksDegenerate(words)) return 'repeated tokens'

  return null
}

export function isUsableProse(value, options) {
  return proseProblem(value, options) === null
}

/**
 * What a recruiter sees when the model could not produce a usable reason.
 *
 * Written to be obviously a placeholder rather than an explanation. The
 * alternative — storing the broken text, or storing an empty string that
 * renders as nothing — both present the absence as though it were the
 * product's considered opinion. A recruiter reading this knows to look at the
 * verdict and the quote instead, which are unaffected.
 */
export const PLACEHOLDER = {
  reason: '(no readable explanation was produced for this requirement)',
  explanation: '(no readable summary was produced for this candidate)',
}

/**
 * The text if it is usable, the placeholder if it is not.
 *
 * `onProblem` is called with the reason so the caller can count, log or retry.
 * Empty is passed through as empty rather than replaced: a verdict with
 * nothing to say is a different thing from one whose explanation was mangled,
 * and filling every silent verdict with placeholder text would put a line of
 * apology on rows that never had a problem.
 */
export function usableOrPlaceholder(value, { kind = 'reason', onProblem } = {}) {
  const problem = proseProblem(value, { kind })
  if (problem === null) return String(value).trim()
  if (onProblem) onProblem(problem)
  if (problem === 'empty') return ''
  return PLACEHOLDER[kind] ?? PLACEHOLDER.reason
}

export const PROSE_LIMITS = LIMITS
