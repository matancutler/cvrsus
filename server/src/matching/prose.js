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
 * Leaked markup is refused because it is the other shape this has actually
 * come back in. A medium-effort verdict in the disagreement sample ended:
 *
 *   "…though not transaction-grade analytics.reason:analysis at a
 *    professional services firm evidences quantitative reasoning.
 *    :contentReference[oaicite:0]{index=0}"
 *
 * — a second copy of the field spliced onto the first with its own JSON key
 * still attached, and a citation token from somewhere in the model's training
 * data trailing after it. Every repetition test passes that text: the tokens
 * are varied, the ratio is healthy, it is under the length cap, and it is
 * mostly real words. It is still not something to put on a candidate's card.
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

/*
 * Markers that only appear when the answer stopped being prose.
 *
 * Deliberately narrow. Each of these is a token no recruiter-facing sentence
 * about a CV would contain, which is what makes them safe to refuse outright:
 *
 *   contentReference / oaicite / citeturn — citation scaffolding from
 *     training data, which surfaces when the model slips out of the task.
 *   {index= and 【…†…】 — the bracketed forms of the same thing.
 *   "key": mid-sentence — the model emitted another JSON field INSIDE the
 *     string value of this one, so the structure it was asked for has broken
 *     down even though the parse succeeded.
 *
 * Not included: a bare "reason:" or "note:", which a person might legitimately
 * write. The rule is that a marker has to be structural, not merely a colon
 * after a word this codebase happens to use as a field name.
 */
const LEAKED_MARKUP = [
  /contentReference/i,
  /oaicite/i,
  /citeturn/i,
  /\{index\s*=/,
  /【[^】]*†[^】]*】/,
  /\S"\s*[a-z_]{2,20}"\s*:/i,
]

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

  if (LEAKED_MARKUP.some((pattern) => pattern.test(text))) return 'leaked markup'

  const words = text.toLowerCase().match(/\p{L}+/gu) ?? []
  if (words.length < MIN_WORDS) return 'not a sentence'
  if (looksDegenerate(words)) return 'repeated tokens'

  return null
}

/*
 * Whether a reason argues for a different verdict than the one beside it.
 *
 * Two of twenty-one hand-read disagreements had this defect. One verdict came
 * back as `partial` with the reason "Led a listed company out of crisis to a
 * tenfold shareholder return, evidencing resilience under pressure." - which is
 * an argument for `meets`, written next to a score that says otherwise. The
 * recruiter reads the sentence, not the enum, so a row like that is the one
 * they raise a ticket about.
 *
 * This is a floor, exactly like proseProblem above it: no model, no network, no
 * opinion about whether the verdict is CORRECT. It asks one mechanical
 * question - does the sentence carry the shape its verdict requires?
 *
 * ---
 *
 * WHY THE RULE IS ASYMMETRIC
 *
 * Measured over the 625 verdicts stored on this machine (meets 106, partial
 * 138, no_evidence 375, contradicted 6), a limiting or negating word appears in
 * 93% of partial reasons, 100% of no_evidence, 100% of contradicted - and 17%
 * of meets. Those numbers set the two rules:
 *
 *   Anything that is NOT `meets` is a claim that something is missing or
 *   incomplete, so its reason has to say so. A reason with no limiting word
 *   anywhere is a reason for `meets`.
 *
 *   `meets` is the other way round and needs a much narrower test, because a
 *   perfectly good meets reason often contains a stray "not" or "rather than"
 *   - "Roughly twenty years of experience, far beyond the five-year bar",
 *   "Twelve years of commercial experience, though in sales rather than
 *   engineering". A bare-negation rule fires on 18 of the 106 real ones. So
 *   `meets` is flagged only on a hard, unhedged statement that something is
 *   not evidenced at all.
 *
 * Together they flag 5 of the 625 stored rows - 0.8% - and catch the real
 * failure. That rate is affordable because of what a flag costs: one retry,
 * and then a mark. It never moves a status and it never moves a score.
 */

/* Words that carry a limit, a gap or a hedge. Matched as whole tokens against
   the same /\p{L}+/gu split proseProblem uses, never with \b - \b is defined on
   ASCII word characters, so /\bלא\b/ is false inside Hebrew text. */
const CONTRAST = new Set([
  'but', 'though', 'although', 'however', 'albeit', 'yet', 'while', 'whereas',
  'rather', 'instead', 'other', 'outside', 'beyond', 'short', 'below', 'less',
  'only', 'still', 'limited', 'partial', 'partially', 'adjacent', 'indirect',
  'implies', 'imply', 'implied', 'suggests', 'appears', 'unclear',
  'not', 'never', 'none', 'nothing', 'without', 'lacks', 'lacking', 'absent',
  'neither', 'nor', 'different', 'no', 'non',
  /* Comparatives. A terse partial often names the shortfall as a comparison
     rather than as a negation - "Two years against a five-year requirement" is
     the rubric's own example of what partial means, and it carries no negating
     word at all. Erring towards more contrast words is the safe direction: a
     word missing from this set costs a flag that should not fire, and a word
     wrongly in it costs only a flag that does not. */
  'against', 'versus', 'despite', 'slightly', 'barely', 'somewhat',
  'narrow', 'narrower', 'shy', 'stops',
  /* The Hebrew half. Reasons are English today, but this file deliberately
     protects Hebrew prose everywhere else, and a check that silently
     mis-handles it is a regression waiting to be written. */
  'לא', 'אין', 'אינו', 'אינה', 'אינם', 'אינן', 'ללא', 'בלי', 'מבלי',
  'חסר', 'חסרה', 'חסרים', 'חוסר', 'אך', 'אבל', 'אולם', 'אלא', 'ברם',
  'למרות', 'אמנם', 'רק', 'בלבד', 'חלקי', 'חלקית', 'מוגבל', 'מוגבלת',
  'פחות', 'מתחת', 'מעולם', 'שום', 'במקום', 'לכאורה', 'כמעט', 'בקושי',
  'עקיף', 'עקיפה', 'בלתי', 'ובלתי',
])

/* Two-word forms the token set cannot see, tested on the lowercased string. */
const CONTRAST_PHRASES = [
  'rather than', 'instead of', 'other than', 'less than', 'short of',
  'no evidence', 'does not', 'did not', 'not mentioned', 'stops short',
]

/*
 * The only shape that convicts a `meets`.
 *
 * Every one of these asserts that the thing is not in the document at all,
 * which cannot sit beside a verdict claiming the document plainly evidences it.
 * Deliberately not "not" or "no" on their own - see the note above.
 */
const HARD_ABSENCE = /no (evidence|mention)|not (mentioned|listed|stated|described|evidenced|shown|named|present)|never (mentioned|named|listed|described|stated)|does not (mention|say|state|show)|nowhere/i

/** Whether the text is mostly written in a non-Latin script. */
function mostlyNonLatin(words) {
  if (words.length === 0) return false
  const latin = words.filter((word) => /^[a-z]+$/.test(word)).length
  return latin / words.length < 0.5
}

/**
 * Why this reason does not match its verdict, or null if it does.
 *
 * A string rather than a boolean, so the caller can log which requirement and
 * a scan over stored rows can report the shape of what it found.
 */
export function reasonDisagrees(status, reason) {
  const text = String(reason ?? '').trim()

  /* Nothing to disagree with. A verdict with no reason is proseProblem's
     business, not this function's. */
  if (!text) return null

  const lowered = text.toLowerCase()
  const words = lowered.match(/\p{L}+/gu) ?? []
  if (words.length < MIN_WORDS) return null

  if (status === 'meets') {
    return HARD_ABSENCE.test(lowered)
      ? 'a meets whose reason says the evidence is absent'
      : null
  }

  if (status !== 'partial' && status !== 'contradicted' && status !== 'no_evidence') {
    return null
  }

  const limited = words.some((word) => CONTRAST.has(word))
    || CONTRAST_PHRASES.some((phrase) => lowered.includes(phrase))
    || /\bnon-/.test(lowered)

  if (limited) return null

  /*
   * No opinion on text this function cannot read.
   *
   * The English list is measured; the Hebrew list is hand-built and certainly
   * incomplete, and Hebrew fuses its prefixes (ללא, שלא and מבלי all contain
   * לא), so a miss is likelier there. Silence is the right answer when the
   * evidence for flagging is the absence of a word we might simply not know.
   */
  if (mostlyNonLatin(words)) return null

  return `a ${status} whose reason names no limit`
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
