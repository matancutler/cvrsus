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
export function keywordsFrom(text, limit = 30) {
  const counts = new Map()

  for (const raw of String(text ?? '').toLowerCase().split(/[^a-z0-9+#.\-]+/)) {
    const token = raw.replace(/^[.\-]+|[.\-]+$/g, '')
    if (token.length < 3 || STOPWORDS.has(token) || /^\d+$/.test(token)) continue
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
export function scoreCandidate(candidate, criteria) {
  const haystack = haystackFor(candidate)
  const requiredSkills = (criteria.requiredSkills ?? []).map(canonicalize).filter(Boolean)
  const preferredSkills = (criteria.preferredSkills ?? []).map(canonicalize).filter(Boolean)

  const matchedRequired = requiredSkills.filter((s) => textHasSkill(haystack, s))
  const missingRequired = requiredSkills.filter((s) => !matchedRequired.includes(s))
  const matchedPreferred = preferredSkills.filter((s) => textHasSkill(haystack, s))
  const missingPreferred = preferredSkills.filter((s) => !matchedPreferred.includes(s))

  const keywords = criteria.keywords ?? keywordsFrom(criteria.jobDescription ?? '')
  const keywordHits = keywords.filter((k) => new RegExp(`(?<![a-z0-9])${escapeRegex(k)}`, 'i').test(haystack))

  const titleTokens = tokenizeTitle(criteria.title)
  const candidateTitleText = [candidate.current_title, candidate.desired_role].filter(Boolean).join(' ')
  const titleHits = titleTokens.filter((t) => {
    const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(t)}`, 'i')
    return pattern.test(candidateTitleText) || pattern.test(haystack)
  })

  const components = []

  if (requiredSkills.length > 0) {
    components.push({
      key: 'required',
      label: 'Required skills',
      weight: WEIGHTS.required,
      // Left as a plain fraction: this is the one component that measures the
      // thing itself rather than a proxy for it.
      value: matchedRequired.length / requiredSkills.length,
      detail: `${matchedRequired.length} of ${requiredSkills.length} matched`,
    })
  }

  if (preferredSkills.length > 0) {
    components.push({
      key: 'preferred',
      label: 'Preferred skills',
      weight: WEIGHTS.preferred,
      value: saturating(matchedPreferred.length, preferredSkills.length, 0.6),
      detail: `${matchedPreferred.length} of ${preferredSkills.length} matched`,
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
      value: saturating(keywordHits.length, keywords.length, 0.35),
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
function saturating(hits, total, full) {
  if (total === 0) return 0
  const target = Math.max(1, Math.ceil(total * full))
  return Math.min(1, hits / target)
}

function tokenizeTitle(title) {
  return String(title ?? '')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length >= 2 && !TITLE_NOISE.has(t) && !STOPWORDS.has(t))
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
