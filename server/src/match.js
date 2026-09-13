import { canonicalize, detectSkills, textHasSkill } from './skills.js'

/**
 * Relative importance of each scoring component. When a component does not
 * apply (e.g. the recruiter listed no preferred skills), its weight is spread
 * across the components that do apply, so the score always tops out at 100.
 */
const WEIGHTS = {
  required: 50,
  preferred: 18,
  title: 12,
  keywords: 20,
}

const STOPWORDS = new Set(`
a about above after again against all am an and any are as at be because been before being below between both but by
can cannot could did do does doing down during each few for from further had has have having he her here hers herself
him himself his how i if in into is it its itself me more most my myself no nor not of off on once only or other ought
our ours ourselves out over own same she should so some such than that the their theirs them themselves then there
these they this those through to too under until up very was we were what when where which while who whom why with
would you your yours yourself yourselves will shall may might must us also across within without upon among
role job work working experience experienced years year team teams company companies candidate candidates
looking seeking join strong excellent good great ability able skills skill knowledge understanding
responsibilities requirements qualifications required preferred plus bonus nice must etc using use used
new well including include includes ideal ideally you'll we're our position opportunity please apply
`.trim().split(/\s+/))

/** Words in a job title that carry no signal about the actual discipline. */
const TITLE_NOISE = new Set(['senior', 'junior', 'sr', 'jr', 'lead', 'principal', 'staff', 'i', 'ii', 'iii', 'iv', 'mid', 'level', 'entry', 'the', 'of', 'and', 'a', 'an'])

const REQUIRED_HEADINGS = /\b(requirements?|required|must[- ]haves?|must have|qualifications?|what you(?:'ll| will)? need|minimum|essential|you have|we require)\b/i
const PREFERRED_HEADINGS = /\b(preferred|nice[- ]to[- ]have|nice to have|bonus|desirable|plus(?:es)?|advantageous|good to have|a plus|would be great)\b/i

/**
 * Best-effort structuring of a pasted job description. Everything it returns is
 * shown to the recruiter as editable defaults, never applied silently.
 */
export function parseJobDescription(text) {
  const source = String(text ?? '')

  const required = new Set()
  const preferred = new Set()

  let bucket = 'required'
  for (const line of source.split('\n')) {
    if (PREFERRED_HEADINGS.test(line)) bucket = 'preferred'
    else if (REQUIRED_HEADINGS.test(line)) bucket = 'required'

    for (const skill of detectSkills(line)) {
      ;(bucket === 'preferred' ? preferred : required).add(skill)
    }
  }

  // A skill named in both sections is genuinely required.
  for (const skill of required) preferred.delete(skill)

  return {
    title: guessTitle(source),
    requiredSkills: [...required],
    preferredSkills: [...preferred],
  }
}

function guessTitle(text) {
  const labelled = text.match(/^\s*(?:job\s+)?title\s*[:\-]\s*(.+)$/im)
  if (labelled) return labelled[1].trim().slice(0, 100)

  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean)
  if (firstLine && firstLine.length <= 80 && !firstLine.endsWith('.')) return firstLine
  return ''
}

/** The distinctive terms of a JD, most frequent first — used for loose overlap. */
/*
 * A word, in any alphabet.
 *
 * This used to split on /[^a-z0-9+#.-]+/, which treats every character outside
 * ASCII as punctuation. A Hebrew job description therefore tokenised to NOTHING
 * — no keywords, no title tokens, so no scoring components at all and a
 * confident 0% for every candidate, which is what it did. The same held for any
 * accented word in a French or Spanish CV.
 *
 * \p{L} and \p{N} are the same rule expressed about letters and digits rather
 * than about one alphabet's byte range, so Hebrew, Arabic, Cyrillic, Greek and
 * accented Latin all tokenise, and ASCII behaves exactly as it did. The kept
 * punctuation is unchanged: + # . - are inside words that matter (C++, .NET,
 * node.js, real-time).
 */
const WORD_SPLIT = /[^\p{L}\p{N}+#.\-]+/u

/* A short word is meaningful in a language that writes without vowels: Hebrew
   "בית", "מול", "אמת" are three characters and carry the sentence. The old
   floor of three characters was tuned for English alone. */
const MIN_TOKEN = 2

/*
 * Words too common to be evidence of anything, beyond the English set above.
 *
 * Hebrew function words, which would otherwise be the most frequent tokens in
 * any Hebrew posting and would match every CV equally.
 */
const EXTRA_STOPWORDS = new Set([
  'של', 'על', 'את', 'עם', 'אל', 'מן', 'גם', 'או', 'אך', 'כי', 'אם', 'לא', 'כן',
  'זה', 'זו', 'הוא', 'היא', 'הם', 'הן', 'אני', 'אנחנו', 'אתה', 'יש', 'אין',
  'היה', 'להיות', 'עבודה', 'משרה', 'תפקיד', 'כולל', 'תוך', 'לפי', 'בין', 'אחר',
  'מאוד', 'יותר', 'כמו', 'רק', 'כל', 'בעל', 'בעלת', 'בתחום', 'וכן',
])

const isNoise = (token) => (
  token.length < MIN_TOKEN
  || STOPWORDS.has(token)
  || EXTRA_STOPWORDS.has(token)
  || /^[\d.\-+#]+$/u.test(token)
)

/** The content words of a phrase, which is what a requirement is made of. */
export function contentTokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(WORD_SPLIT)
    .map((raw) => raw.replace(/^[.\-]+|[.\-]+$/g, ''))
    .filter((token) => !isNoise(token))
}

export function keywordsFrom(text, limit = 30) {
  const counts = new Map()

  for (const token of contentTokens(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([token]) => token)
}

/** Everything about a candidate that a skill or keyword could legitimately appear in. */
function haystackFor(candidate) {
  return [
    candidate.cv_text,
    candidate.current_title,
    candidate.desired_role,
    candidate.notes,
    (candidate.skills ?? []).join(' '),
  ].filter(Boolean).join('\n')
}

/**
 * Scores one candidate against the recruiter's criteria.
 *
 * Returns the 0-100 score plus a per-component breakdown, because a number on
 * its own is not something a recruiter can defend to a hiring manager.
 */
/*
 * Which alphabets a piece of text is written in.
 *
 * Needed because this scorer compares words literally, and words in different
 * alphabets never match however related the meaning. A Hebrew job title against
 * an English CV cannot score above zero — not because the candidate is wrong
 * for the job, but because the question is unanswerable this way.
 */
function scriptsOf(text) {
  const found = new Set()
  const value = String(text ?? '')
  if (/\p{Script=Latin}/u.test(value)) found.add('latin')
  if (/\p{Script=Hebrew}/u.test(value)) found.add('hebrew')
  if (/\p{Script=Arabic}/u.test(value)) found.add('arabic')
  if (/\p{Script=Cyrillic}/u.test(value)) found.add('cyrillic')
  if (/\p{Script=Greek}/u.test(value)) found.add('greek')
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(value)) {
    found.add('cjk')
  }
  return found
}

/*
 * Whether comparing these two texts word by word can tell us anything.
 *
 * If they share no alphabet the answer is no, and the component is left OUT
 * rather than scored zero. That distinction is the whole of the "too harsh"
 * complaint: a zero is a statement that the candidate fails the requirement,
 * and it drags the weighted total down accordingly, when the truth is that this
 * particular instrument cannot read this particular pair. Dropping the
 * component renormalises the others over the weight that remains, so the score
 * reflects what could actually be judged.
 *
 * Numbers and shared loan-words mean a little overlap is common, so a text with
 * no letters at all (a list of years) is treated as comparable with anything.
 */
function comparable(phrase, haystack) {
  const a = scriptsOf(phrase)
  if (a.size === 0) return true
  const b = scriptsOf(haystack)
  if (b.size === 0) return true
  for (const script of a) if (b.has(script)) return true
  return false
}

/*
 * Whether one word appears in the text, in any alphabet.
 *
 * The old boundary was (?<![a-z0-9]), which is not a boundary at all next to a
 * Hebrew or accented letter — every character there is "not a-z0-9", so a token
 * matched inside longer words and scored hits that were not there.
 */
function tokenInText(haystack, token) {
  return new RegExp(
    `(?<![\p{L}\p{N}])${escapeRegex(token)}(?![\p{L}\p{N}])`, 'iu',
  ).test(haystack)
}

/*
 * How much of a requirement the CV actually evidences, from 0 to 1.
 *
 * This is the fix for a 0% that should not have been. The model returns
 * requirements as SENTENCES — "Ability to make real-time decisions based on
 * transaction data" — and this was asking whether that sentence appeared in the
 * CV word for word. No CV has ever contained such a string, so every
 * requirement scored zero, every component scored zero, and a genuinely
 * relevant candidate was shown a confident 0%.
 *
 * A requirement is therefore scored by how much of its content the CV supports.
 * A named skill still matches exactly through the taxonomy, which is what keeps
 * "Python" precise; anything longer is judged on its words, so a CV that talks
 * about real-time decisions and transactions gets credit for a requirement
 * about real-time transaction decisions, which is the whole point.
 *
 * Crude next to the reasoning pass, and deliberately so: this runs when the
 * model is unavailable, and its job is to be roughly right rather than
 * confidently wrong.
 */
function phraseCoverage(haystack, phrase) {
  /* A taxonomy skill is matched as a skill, with its aliases — "JS" for
     JavaScript, "Postgres" for PostgreSQL. Nothing below improves on that. */
  if (textHasSkill(haystack, phrase)) return 1

  /*
   * The concepts the requirement NAMES, matched as concepts.
   *
   * A requirement is a sentence, and the sentence usually names two or three
   * real skills: "Analytical thinking, attention to detail and decision-making
   * ability" is three. Reading it word by word asks whether the CV happens to
   * repeat those words; reading it as concepts asks whether the CV evidences
   * the SKILLS, which is the actual question and is what lets "Postgres" in a
   * CV answer a requirement for relational databases.
   *
   * Taken as the better of the two measures rather than replacing the word
   * count: a requirement naming no taxonomy concept at all — a domain this
   * vocabulary has never heard of — still scores on its words, and a CV that
   * evidences two of three named concepts should not be dragged down because
   * it phrases them differently.
   */
  const named = detectSkills(phrase)
  const byConcept = named.length === 0
    ? 0
    : named.filter((skill) => textHasSkill(haystack, skill)).length / named.length

  const tokens = contentTokens(phrase)
  if (tokens.length === 0) return byConcept

  const hits = tokens.filter((token) => tokenInText(haystack, token)).length

  /*
   * Every word of a long requirement is not needed to believe it. Four words of
   * a seven-word sentence is real evidence, so coverage is measured against a
   * majority rather than against the whole — otherwise long requirements are
   * harder to satisfy than short ones purely by being wordier.
   */
  const enough = Math.max(1, Math.ceil(tokens.length * 0.6))
  return Math.max(byConcept, Math.min(1, hits / enough))
}

/* Met well enough to call it met, for the requirement lists a recruiter reads.
   Below this it is partial evidence and shows as a gap. */
const MEETS_AT = 0.75

export function scoreCandidate(candidate, criteria) {
  const haystack = haystackFor(candidate)
  const requiredSkills = (criteria.requiredSkills ?? []).map(canonicalize).filter(Boolean)
  const preferredSkills = (criteria.preferredSkills ?? []).map(canonicalize).filter(Boolean)

  /* Requirements written in an alphabet the CV does not use are set aside
     rather than failed — see comparable() above. */
  const judgeable = (list) => list.filter((s) => comparable(s, haystack))

  const requiredJudged = judgeable(requiredSkills)
  const preferredJudged = judgeable(preferredSkills)

  const requiredCoverage = requiredJudged.map((s) => phraseCoverage(haystack, s))
  const preferredCoverage = preferredJudged.map((s) => phraseCoverage(haystack, s))

  const matchedRequired = requiredJudged.filter((_, i) => requiredCoverage[i] >= MEETS_AT)
  const missingRequired = requiredJudged.filter((_, i) => requiredCoverage[i] < MEETS_AT)
  const matchedPreferred = preferredJudged.filter((_, i) => preferredCoverage[i] >= MEETS_AT)
  const missingPreferred = preferredJudged.filter((_, i) => preferredCoverage[i] < MEETS_AT)

  /*
   * `contextual` from the job profile arrives as phrases, not as words, so
   * these are covered the same way rather than searched for literally.
   */
  const keywords = judgeable(criteria.keywords ?? keywordsFrom(criteria.jobDescription ?? ''))
  const keywordCoverage = keywords.map((k) => phraseCoverage(haystack, k))
  const keywordHits = keywords.filter((_, i) => keywordCoverage[i] >= MEETS_AT)

  const titleTokens = comparable(criteria.title, haystack) ? tokenizeTitle(criteria.title) : []
  const candidateTitleText = [candidate.current_title, candidate.desired_role].filter(Boolean).join(' ')
  const titleHits = titleTokens.filter((t) => {
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(t)}`, 'i')
    return pattern.test(candidateTitleText) || pattern.test(haystack)
  })

  const components = []

  if (requiredJudged.length > 0) {
    components.push({
      key: 'required',
      label: 'Required skills',
      weight: WEIGHTS.required,
      /*
       * The MEAN coverage, not the count that cleared the bar. Counting
       * treats a requirement the CV half-evidences exactly like one it never
       * mentions, and across a list of sentences that is the difference
       * between a fair score and a zero.
       */
      value: mean(requiredCoverage),
      detail: `${matchedRequired.length} of ${requiredJudged.length} matched`,
    })
  }

  if (preferredJudged.length > 0) {
    components.push({
      key: 'preferred',
      label: 'Preferred skills',
      weight: WEIGHTS.preferred,
      /* Coverage already forgives the words a CV does not repeat — see the
         0.6 allowance inside phraseCoverage. Discounting it a second time here
         gave a pastry chef most of the marks for a payments role on the word
         "service" alone. */
      value: mean(preferredCoverage),
      detail: `${matchedPreferred.length} of ${preferredJudged.length} matched`,
    })
  }

  if (titleTokens.length > 0) {
    components.push({
      key: 'title',
      label: 'Title relevance',
      weight: WEIGHTS.title,
      value: saturating(titleHits.length, titleTokens.length, 0.5),
      detail: titleHits.length > 0 ? `matched ${titleHits.join(', ')}` : 'no title overlap',
    })
  }

  if (keywords.length > 0) {
    components.push({
      key: 'keywords',
      label: 'JD keyword overlap',
      weight: WEIGHTS.keywords,
      value: mean(keywordCoverage),
      detail: `${keywordHits.length} of ${keywords.length} terms present`,
    })
  }

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0)
  const breakdown = components.map((c) => ({
    ...c,
    // Normalise so the applicable components always add up to 100.
    normalizedWeight: round(totalWeight > 0 ? (c.weight / totalWeight) * 100 : 0),
    points: round(totalWeight > 0 ? (c.weight / totalWeight) * 100 * c.value : 0),
  }))

  const score = Math.round(breakdown.reduce((sum, c) => sum + c.points, 0))

  return {
    score: totalWeight > 0 ? score : 0,
    breakdown,
    matchedRequired,
    missingRequired,
    matchedPreferred,
    missingPreferred,
    keywordHits,
    meetsAllRequired: missingRequired.length === 0,
  }
}

/**
 * Overlap on a curve instead of a plain fraction.
 *
 * A CV is not a copy of the job description. Dividing hits by every term the JD
 * happens to contain meant a genuinely strong candidate scored near zero on the
 * loose components — thirty keywords, six hits, 20% — and the ranking behaved
 * like a keyword search. Matching `full` of the terms now earns the whole
 * component, and anything below scales smoothly up to it.
 */
function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length
}

function saturating(hits, total, full) {
  if (total === 0) return 0
  const target = Math.max(1, Math.ceil(total * full))
  return Math.min(1, hits / target)
}

function tokenizeTitle(title) {
  /* Same alphabet-agnostic rule as the keywords: a Hebrew job title used to
     tokenise to nothing and silently remove the whole title component. */
  return contentTokens(title).filter((t) => !TITLE_NOISE.has(t))
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function round(value) {
  return Math.round(value * 10) / 10
}

/**
 * A raw score good enough that the best candidate in the pool deserves to show
 * as a full match. Below this the pool is weak in absolute terms, and lifting
 * its best to 100 would tell a recruiter they had found someone excellent when
 * they had found the least bad of a poor field.
 */
const CREDIBLE_TOP_RAW = 55

/** Raws within this of the top all display the same score, so ties are real. */
const TOP_BAND = 2

/**
 * Stage 2: normalise raw JD-fit scores against the pool that was searched.
 *
 * Stage 1 asks "how well does this person meet the requirements", which is
 * absolute and can top out below 100 — nobody may satisfy every criterion. This
 * step answers the question a recruiter is actually asking: of the people
 * available, who is strongest. The best of the pool can therefore display 100
 * even when nobody literally meets everything, and several candidates can share
 * a displayed score.
 *
 * The one guard: a pool whose best candidate is weak in absolute terms does not
 * get promoted to 100. Relative strength is worth showing; inventing a perfect
 * match out of a thin field is not.
 *
 * Raw scores are kept on every row for the audit trail and are not displayed.
 */
export function normalizeAgainstPool(rows) {
  const top = rows.reduce((best, row) => Math.max(best, row.rawScore ?? 0), 0)
  if (top <= 0) return rows.map((row) => ({ ...row, score: 0 }))

  const ceiling = top >= CREDIBLE_TOP_RAW
    ? 100
    : Math.round((top / CREDIBLE_TOP_RAW) * 100)

  return rows.map((row) => {
    const raw = row.rawScore ?? 0
    const score = raw >= top - TOP_BAND
      ? ceiling
      : Math.round((raw / top) * ceiling)

    return { ...row, score: Math.max(0, Math.min(100, score)) }
  })
}

/** Hard gates the recruiter can switch on. Applied before ranking. */
export function passesFilters(candidate, result, filters = {}) {
  if (filters.requireAllSkills && !result.meetsAllRequired) return false

  if (Number.isFinite(filters.minScore) && result.score < filters.minScore) return false

  if (filters.location) {
    const needle = String(filters.location).toLowerCase()
    if (!String(candidate.location ?? '').toLowerCase().includes(needle)) return false
  }

  if (filters.availability) {
    if (candidate.availability !== filters.availability) return false
  }

  if (filters.search) {
    const needle = String(filters.search).toLowerCase()
    const hay = [candidate.name, candidate.email, candidate.current_title, candidate.desired_role]
      .filter(Boolean).join(' ').toLowerCase()
    if (!hay.includes(needle)) return false
  }

  return true
}
