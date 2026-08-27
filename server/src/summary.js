/*
 * The Professional Summary: making sure every candidate has one, and that no
 * version a recruiter can read names the people who employed them.
 *
 * Why the second half matters. A summary is shown to recruiters BEFORE a reveal
 * — it is how somebody decides whether to spend one — while the surname, the
 * photograph, the contact details and even the CV's filename are withheld as
 * identifying. "Senior engineer at Wix for four years" defeats all of that in a
 * single clause: there is one such person, and the recruiter now knows where to
 * find them without paying. The rest of the sentence is worth keeping, so the
 * employer is abstracted rather than the summary refused.
 *
 * What abstraction means here: keep the shape of the experience, drop the
 * identity. "at Monday.com" becomes "at a B2B software company", not "at a
 * company" — a recruiter reading a profile needs to know what kind of place
 * this person has worked, and flattening every employer to one word throws away
 * the thing they were reading for.
 *
 * Two layers, in this order:
 *
 *   1. The candidate's own CV. Their employment history is already extracted,
 *      so the employers to look for are known rather than guessed. This is the
 *      layer that catches the small consultancy nobody has heard of, and it
 *      needs no model.
 *   2. A model pass, where one is configured, for names the CV does not
 *      contain — a pasted summary mentioning somewhere they never listed.
 *
 * The first layer runs whether or not the second can, so a keyless deployment
 * still sanitises everything the CV knows about.
 */
import {
  SUMMARY_MAX_CHARS, abstractSummaryEmployers, generateSummary, trimToLimit,
} from './ai.js'
import db, { getCandidate, updateCandidate } from './db.js'
import { getExtraction } from './profiles.js'
import { companyNamesMatch, companyTokens } from './companyMatch.js'
import { normalizeCompanyName } from './schema.js'

/**
 * Industry to the phrase that replaces an employer from it.
 *
 * Deliberately more specific than "a company". The candidate's extracted
 * industry is the best evidence available for what kind of place employed them,
 * and "a fintech company" tells a recruiter something "a company" does not.
 * Matched loosely, because the extractor writes free text here rather than
 * choosing from a list.
 */
const INDUSTRY_PHRASES = [
  [/fintech|financial technology/i, 'a fintech company'],
  [/bank|investment|asset management|capital market|insurance|financial/i, 'a financial institution'],
  [/consult|advisory/i, 'a consulting firm'],
  [/account(ing|ancy)|audit|legal|law/i, 'a professional services firm'],
  [/health|medical|pharma|biotech|clinical/i, 'a healthcare company'],
  [/e-?commerce|retail|marketplace/i, 'an e-commerce company'],
  [/manufactur|industrial|automotive|aerospace/i, 'a manufacturing company'],
  [/gaming|games/i, 'a gaming company'],
  [/media|publishing|advertis|marketing/i, 'a media company'],
  [/education|edtech|university|academic/i, 'an education organisation'],
  [/government|public sector|municipal|defen[cs]e/i, 'a public-sector organisation'],
  [/non-?profit|charity|ngo/i, 'a non-profit organisation'],
  [/telecom|communications/i, 'a telecommunications company'],
  [/energy|utilities|oil|gas|renewab/i, 'an energy company'],
  [/logistics|shipping|transport|supply chain/i, 'a logistics company'],
  [/real estate|property|construction/i, 'a property company'],
  [/travel|hospitality|hotel|airline/i, 'a travel company'],
  [/b2b|saas|enterprise software/i, 'a B2B software company'],
  [/software|technology|tech|internet|cyber|data|cloud|ai\b/i, 'a technology company'],
]

/** The safe default when nothing better can be said. */
const GENERIC = 'a company'

/**
 * A modest list of employers that turn up in pasted summaries without being in
 * the CV that was uploaded.
 *
 * A supplement to the two layers above, never the mechanism. A list of famous
 * names is exactly the wrong shape for this problem — it fails on the local
 * accountancy the candidate actually worked for, which is the case that matters
 * most to them — so it exists only to catch the obvious ones when there is no
 * model available and the CV happens not to mention the name.
 */
const COMMON_EMPLOYERS = [
  ['apple', 'a technology company'], ['google', 'a technology company'],
  ['alphabet', 'a technology company'], ['microsoft', 'a technology company'],
  ['amazon', 'a technology company'], ['meta', 'a technology company'],
  ['facebook', 'a technology company'], ['netflix', 'a technology company'],
  ['nvidia', 'a technology company'], ['intel', 'a technology company'],
  ['ibm', 'a technology company'], ['oracle', 'a technology company'],
  ['salesforce', 'a software company'], ['sap', 'an enterprise software company'],
  ['adobe', 'a software company'], ['uber', 'a technology company'],
  ['airbnb', 'a technology company'], ['spotify', 'a technology company'],
  ['stripe', 'a fintech company'], ['paypal', 'a fintech company'],
  ['revolut', 'a fintech company'], ['monday com', 'a B2B software company'],
  ['wix', 'a technology company'], ['checkpoint', 'a cybersecurity company'],
  ['check point', 'a cybersecurity company'], ['palo alto networks', 'a cybersecurity company'],
  ['goldman sachs', 'a global financial institution'], ['morgan stanley', 'a global financial institution'],
  ['jpmorgan', 'a global financial institution'], ['jp morgan', 'a global financial institution'],
  ['citigroup', 'a global financial institution'], ['barclays', 'a global financial institution'],
  ['hsbc', 'a global financial institution'], ['deutsche bank', 'a global financial institution'],
  ['deloitte', 'a professional services firm'], ['pwc', 'a professional services firm'],
  ['pricewaterhousecoopers', 'a professional services firm'],
  ['ernst young', 'a professional services firm'], ['kpmg', 'a professional services firm'],
  ['accenture', 'a consulting firm'], ['mckinsey', 'a consulting firm'],
  ['bain', 'a consulting firm'], ['boston consulting group', 'a consulting firm'],
  ['tesla', 'a technology company'], ['siemens', 'a manufacturing company'],
  ['pfizer', 'a healthcare company'], ['johnson johnson', 'a healthcare company'],
]

/*
 * Entries above that are also ordinary English words.
 *
 * Abstracted only where the sentence is introducing an employer — "at Meta",
 * not "a meta-analysis"; "joined Intel", not "an intel briefing". Everything
 * else on the list is a name nobody writes by accident.
 */
const AMBIGUOUS_NAMES = new Set([
  'meta', 'intel', 'oracle', 'apple', 'amazon', 'checkpoint', 'check point',
  'bain', 'sap', 'stripe', 'adobe', 'uber', 'tesla',
])

/** What to call an employer, given whatever is known about them. */
export function describeEmployer(name, industry = null) {
  const normalized = normalizeCompanyName(name)

  /*
   * An exact name from the list wins, because it is the best evidence there is.
   */
  for (const [known, phrase] of COMMON_EMPLOYERS) {
    if (normalizeCompanyName(known) === normalized) return phrase
  }

  /*
   * Then what the candidate's own CV says their industry is.
   *
   * This used to come last, after a LOOSE match against the list — and that
   * match is prefix-anchored, so "Apple Orchard Ltd", a real greengrocer on
   * somebody's CV, was described to recruiters as "a technology company". A
   * guess from a list of famous names is worse evidence than the industry read
   * off the person's own CV, so it now goes after it.
   */
  const text = String(industry ?? '')
  for (const [pattern, phrase] of INDUSTRY_PHRASES) {
    if (pattern.test(text)) return phrase
  }

  /* A loose match is better than nothing, which is what is left. */
  for (const [known, phrase] of COMMON_EMPLOYERS) {
    if (companyNamesMatch(known, normalized)) return phrase
  }

  return GENERIC
}

/** Escapes a string so it can be dropped into a RegExp as a literal. */
const literal = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/*
 * One employer name, as a pattern.
 *
 * Built from the name's own letter-and-digit runs rather than from the raw
 * string, and rejoined with a class covering the punctuation a company name
 * picks up between one document and another: "Monday.com" and "Monday com",
 * "Ben & Jerry's" and "Ben and Jerrys", "Check Point" and "Check-Point". One
 * separator between runs, never a repeat — the old [\s.]* was unbounded, so a
 * two-word name matched straight across a full stop and a newline and ate the
 * start of the next sentence.
 *
 * \p{L}\p{N} rather than \w, so a Hebrew or Cyrillic employer is a name here
 * and not an empty pattern that silently matches nothing.
 *
 * The edges are lookarounds rather than \b: a name ending in a full stop
 * ("Monday.com") has no word boundary after it, and \b there meant the pattern
 * simply never fired for exactly the names most likely to be punctuated.
 */
function namePattern(name) {
  const runs = String(name).match(/[\p{L}\p{N}]+/gu) ?? []
  if (runs.length === 0) return null

  /* Three, not two: " & " and " - " are a separator with a space either side,
     and at two the class could not span them. Still bounded, and still only
     separator characters, so it can never run into an adjacent word. */
  const gap = '(?:[\\s.,\'’&-]|\\sand\\s){0,3}'

  /*
   * A one- or two-letter tail is optional.
   *
   * "Ben & Jerry's" splits into three runs, the last being the "s" of the
   * possessive — and a summary mentioning them is as likely to write "Ben &
   * Jerry". Requiring every run meant the stored name and the written one
   * failed to meet over an apostrophe. Only a short tail, so "Check Point"
   * still needs both of its words.
   */
  const short = runs.length > 1 && runs[runs.length - 1].length <= 2
  const head = (short ? runs.slice(0, -1) : runs).map(literal).join(gap)
  const body = short
    ? `${head}(?:${gap}${literal(runs[runs.length - 1])})?`
    : head

  return `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])${SUFFIX}`
}

/*
 * An optional legal suffix after a company name, and nothing else.
 *
 * The word boundary sits immediately after the alternation rather than at the
 * end, which is load-bearing in both directions: without it "Co" matched the
 * first two letters of "covering" and turned "at Goldman Sachs covering
 * technology" into "at a global financial institutionvering technology"; with
 * it after the optional full stop instead, "Ltd." would stop matching, because
 * there is no boundary between a stop and the space after it.
 */
const SUFFIX = '(?:\\s+(?:Ltd|Limited|Inc|Incorporated|LLC|GmbH|PLC|Corp|Corporation|Co)\\b\\.?)?'

/**
 * The employers named in a candidate's own CV, from the extraction that has
 * already been done. The list a summary is checked against.
 */
export function employersFromCv(candidateId, extraction = getExtraction(candidateId)) {
  const history = Array.isArray(extraction?.employment_history) ? extraction.employment_history : []

  const seen = new Set()
  const out = []
  for (const role of history) {
    const name = String(role?.company ?? '').trim()
    if (!name || name.length < 2) continue
    const key = normalizeCompanyName(name)
    /* One token and two characters is an initialism the matcher cannot tell
       from an ordinary word — "at BT" and "at IT" are one edit apart. Left to
       the model pass rather than risked here. */
    if (!key || key.length < 3 || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/**
 * Replaces named employers with a description of what kind of place they are.
 *
 * Works on the text it is given and the names it is told about; the caller
 * decides where those come from. Returns the rewritten text and what it
 * changed, so a caller can tell "nothing to do" from "could not tell".
 *
 * Only the employer's name moves. The article in front of it goes too when
 * there is one, because "a a technology company" is worse than the problem it
 * is fixing.
 */
export function abstractEmployers(text, { employers = [], industry = null } = {}) {
  const original = String(text ?? '')
  if (!original.trim()) return { text: original, replaced: [] }

  let out = original
  const replaced = []

  /* Longest first, so "Bank of America" is matched before "Bank". */
  const names = [...new Set(employers.map((name) => String(name).trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)

  const swap = (name, phrase, { needsLead = false } = {}) => {
    const body = namePattern(name)
    if (!body) return false

    /* An article in front of the name goes with it: "at the Acme Ltd" must not
       become "at the a technology company". */
    const source = needsLead
      ? `(\\b(?:at|with|for|from|joined|by)\\s+)(?:a|an|the)?\\s*${body}`
      : `\\b(?:a|an|the)\\s+${body}|${body}`

    const pattern = new RegExp(source, 'giu')
    if (!pattern.test(out)) return false
    pattern.lastIndex = 0

    out = out.replace(pattern, needsLead ? `$1${phrase}` : phrase)
    replaced.push({ name, phrase })
    return true
  }

  for (const name of names) swap(name, describeEmployer(name, industry))

  /*
   * A second pass for the well-known names the CV did not mention.
   *
   * The ones that are also ordinary English words only count where the sentence
   * is talking about an employer. Without that, every summary mentioning a
   * checkpoint, a meta-analysis or an intel briefing had the word replaced with
   * a company description, and the damage was written back over what the
   * candidate typed.
   */
  for (const [known, phrase] of COMMON_EMPLOYERS) {
    if (replaced.some((entry) => companyNamesMatch(entry.name, known))) continue
    swap(known, phrase, { needsLead: AMBIGUOUS_NAMES.has(known) })
  }

  /*
   * Tidying the seams — only where this call actually put a phrase in.
   *
   * It used to run unconditionally, so a summary nobody had touched still came
   * back changed: "an A grade" became "A grade", and "the a priori assumption"
   * lost its article. A function that promises not to rewrite a clean summary
   * has to leave a clean summary alone.
   */
  if (replaced.length > 0) {
    out = out
      .replace(/\b(?:a|an|the)\s+(a|an)\s+/gi, '$1 ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
  }

  return { text: out, replaced }
}

/**
 * Everything known about one candidate that the sanitiser needs.
 *
 * Read once per call rather than per name, because a summary mentioning four
 * employers should not cost four reads of the same row.
 */
export function sanitisationContext(candidateId) {
  /* One read, passed down. It used to be read here and again inside
     employersFromCv, which is two queries per candidate — and repairSummaries
     does this once per row. */
  const extraction = getExtraction(candidateId)
  return {
    employers: employersFromCv(candidateId, extraction),
    industry: extraction?.industry ?? null,
  }
}

/** The whole job for one candidate's text, in one call. */
export function sanitiseSummary(candidateId, text) {
  return abstractEmployers(text, sanitisationContext(candidateId))
}

// ------------------------------------------------------ the persisted one ---

/**
 * The candidate's Professional Summary, guaranteed to exist and guaranteed to
 * name no employer.
 *
 * `candidates.notes` is the one authoritative copy — the column the form writes,
 * the column recruiters read, and the only one this ever writes to. The CV-drafted
 * summary inside extracted_profiles is raw material, not a second answer: when
 * notes is empty this copies it across, sanitised, and from then on there is one
 * value rather than two that can disagree.
 *
 * Precedence, highest first:
 *   1. What the candidate wrote or edited. Never replaced, only sanitised.
 *   2. What they generated and kept — which is (1) by the time it is saved.
 *   3. What we drafted from their CV because they did neither.
 *
 * Idempotent and cheap to call again: a summary that is already clean is left
 * exactly as it is, and nothing is written.
 */
export async function ensureSummary(candidateId, { cvText = null, signal } = {}) {
  const candidate = getCandidate(candidateId)
  if (!candidate) return { changed: false, reason: 'no-candidate' }

  const written = String(candidate.notes ?? '').trim()
  const context = sanitisationContext(candidateId)

  let text = written
  let origin = 'candidate'

  if (!text) {
    /*
     * Nobody wrote one, so one is drafted. The CV-drafted summary from the
     * extraction is preferred over a second model call — it was made from the
     * same CV moments ago and costs nothing to reuse.
     */
    const extraction = getExtraction(candidateId)
    const drafted = String(extraction?.summary ?? '').trim()

    if (drafted) {
      text = drafted
      origin = 'cv'
    } else if (cvText) {
      const generated = await generateSummary(cvText, { signal }).catch(() => null)
      text = String(generated?.summary ?? '').trim()
      origin = 'generated'
    }

    /*
     * Still nothing, so one is assembled from the extracted facts.
     *
     * This is the path a deployment with no model configured takes every time,
     * and it is why "every candidate has a summary" is a guarantee rather than
     * an aspiration. Four facts in a sentence is not what a person would write,
     * and it is a great deal better than a blank space where a recruiter
     * expects to read who somebody is.
     */
    if (!text) {
      text = String(draftSummaryDeterministically(candidateId) ?? '').trim()
      origin = 'facts'
    }
  }

  if (!text) {
    /* Nothing to work with — no key, an unreadable CV, a model that refused.
       Left empty rather than filled with a placeholder: an invented summary
       under somebody's name is worse than a missing one, and the caller can
       try again. */
    return { changed: false, reason: 'nothing-to-summarise' }
  }

  /*
   * The employers to look for, from three places: the structured history the
   * extractor produced, the names the summary and the CV both use, and the
   * short list of well-known ones inside abstractEmployers. The second is what
   * covers a keyless deployment, where the first is empty because the
   * deterministic extractor produces no employment history.
   */
  const named = employersNamedInBoth(text, candidate.cv_text, {
    exclude: [
      candidate.first_name, candidate.last_name, candidate.location,
      ...(Array.isArray(candidate.skills) ? candidate.skills : []),
    ],
  })

  const cleaned = await sanitiseText(
    text,
    { ...context, employers: [...context.employers, ...named] },
    { signal },
  )

  if (cleaned === written) return { changed: false, reason: 'already-clean', origin }

  /*
   * What was there when we started has to still be there.
   *
   * This reads notes, awaits a model call or two, then writes — and the
   * candidate can save their own summary during that gap. Without the re-read,
   * the generated draft lands on top of what they just typed, which is the one
   * thing the precedence rule exists to prevent. better-sqlite3 is synchronous
   * and the server is one process, so the check and the write below cannot be
   * interleaved: this is a real compare-and-swap, not a hopeful one.
   */
  const now = String(getCandidate(candidateId)?.notes ?? '').trim()
  if (now !== written) return { changed: false, reason: 'overtaken' }

  updateCandidate(candidateId, { notes: cleaned })
  return { changed: true, origin, from: written || null, to: cleaned }
}

/**
 * Both passes, in order: what the CV names, then what a model can still see.
 *
 * The model only ever runs on what the first pass left, and only when one is
 * configured. Its answer is taken only if it did not empty the paragraph —
 * see abstractSummaryEmployers, which returns null rather than a ruined
 * summary.
 */
export async function sanitiseText(text, context, { signal } = {}) {
  const deterministic = abstractEmployers(text, context).text

  const assisted = await abstractSummaryEmployers(deterministic, { signal }).catch(() => null)

  /*
   * Capped here, which is the one exit every path out of this module uses.
   *
   * "at Ziv Haddad Accounting Ltd" becoming "at a professional services firm"
   * makes a summary longer, and a summary written up to the limit could be
   * pushed past it — past what the candidate's own form will then accept, so
   * their next save would be refused for a length they did not choose.
   */
  return trimToLimit(String(assisted ?? deterministic).trim(), SUMMARY_MAX_CHARS)
}

/**
 * Brings existing candidates up to the rule, once, at startup.
 *
 * Two conditions to repair, and both are data conditions rather than product
 * states: a profile with a CV and no summary, and a summary written before
 * anything screened it for employer names. Neither should exist going forward —
 * ensureSummary runs on every write path — so this is for the rows that predate
 * it.
 *
 * Deliberately narrow about what it touches:
 *
 *   - Only rows whose summary would actually change. A clean summary is read,
 *     compared and left alone; nothing is rewritten to look busy.
 *   - Only the deterministic pass, never the model. A backfill that made one
 *     model call per candidate would be slow, expensive and — since it runs at
 *     boot — a way to make a restart take minutes. What the CV names is what
 *     this fixes; anything subtler waits for the candidate's next save, which
 *     goes through the full path.
 *   - Bounded, and it says what it did. A silent loop over every row is not
 *     something to discover from a slow start-up.
 *
 * Idempotent: run it twice and the second run reports nothing, because the
 * first left nothing that would change.
 */
export function repairSummaries({ batch = 500 } = {}) {
  /*
   * Oldest first, through the whole table, a page at a time.
   *
   * It used to take one page of the 500 NEWEST rows — which are the rows least
   * likely to need repairing, since every write path keeps new ones clean — and
   * a database with more than 500 summaries would have seen the same 500
   * examined on every boot and the older ones never once.
   */
  const select = db.prepare(`
    SELECT id, notes FROM candidates
    WHERE notes IS NOT NULL AND trim(notes) != '' AND id > ?
    ORDER BY id LIMIT ?
  `)

  let cleaned = 0
  let examined = 0
  let after = 0

  for (;;) {
    const rows = select.all(after, batch)
    if (rows.length === 0) break

    for (const row of rows) {
      examined += 1
      after = row.id

      /*
       * No early exit on an empty employer list.
       *
       * There used to be one, and it skipped exactly the rows this exists for:
       * a legacy profile with no extraction has no employment history, so the
       * list is empty — and the well-known-name pass inside abstractEmployers
       * needs no list at all. The rows most likely to name an employer were the
       * ones the guard sent past.
       */
      const context = sanitisationContext(row.id)
      const result = abstractEmployers(row.notes, context)

      /* Gated on a replacement rather than on the text differing, so the
         trailing whitespace tidy cannot rewrite a row nothing was found in. */
      if (result.replaced.length === 0 || result.text === row.notes) continue

      updateCandidate(row.id, { notes: result.text })
      cleaned += 1
    }
  }

  /*
   * The missing ones are counted rather than generated. Drafting a summary
   * needs the CV text and a model call each, which is the wrong shape for a
   * boot-time pass — reported so the gap is visible, and closed by the
   * candidate's next save or by a deliberate backfill.
   */
  const missing = db.prepare(`
    SELECT COUNT(*) AS n FROM candidates
    WHERE (notes IS NULL OR trim(notes) = '')
      AND cv_text IS NOT NULL AND trim(cv_text) != ''
  `).get().n

  return { cleaned, missing, examined }
}

// ------------------------------------------- what the CV names, in prose ---

/*
 * Words that follow an employer in ordinary English, and the ones that follow
 * a place of study instead.
 *
 * The cross-reference below only looks at phrases introduced by one of these,
 * which is what keeps it from abstracting the candidate's own name, their city
 * or a technology they listed. "at Ziv Haddad Systems" is an employer;
 * "Ziv Haddad Systems" on its own in a sentence about something else is not
 * something this should touch.
 */
const EMPLOYER_LEAD = /\b(?:at|with|for|joined|from)\s+/i

/** A capitalised run of words: "Ziv Haddad Systems", "Monday.com", "PwC". */
const PROPER_RUN = /(?:[A-Z][\w&'’.-]*)(?:[ ]+(?:of|and|&)?[ ]*[A-Z][\w&'’.-]*)*/

/*
 * Words that look like an employer but are somewhere they studied. A degree is
 * not an employer, and "at the Technion" should survive.
 */
const SCHOOLING = /\b(?:universit|college|school|institute|academy|technion|faculty)\b/i

/**
 * Employers named in the summary that the CV also mentions.
 *
 * The rule §15 asks for, stated literally: if the CV says they worked somewhere
 * and that same name is in their summary, abstract it. It needs no model and no
 * list, and it is the layer that catches the small firm nobody has heard of —
 * which is the case a famous-names list is worst at and candidates care most
 * about.
 *
 * Deliberately narrow. Only phrases introduced by "at", "with", "for", "joined"
 * or "from" are considered, so a technology, a city or the person's own name
 * cannot be swept up by appearing in both documents.
 */
export function employersNamedInBoth(summary, cvText, { exclude = [] } = {}) {
  const text = String(summary ?? '')
  const cv = String(cvText ?? '')
  if (!text.trim() || !cv.trim()) return []

  const safe = new Set(exclude.map((word) => normalizeCompanyName(word)).filter(Boolean))
  const found = []

  const pattern = new RegExp(`${EMPLOYER_LEAD.source}(${PROPER_RUN.source})`, 'g')
  for (const match of text.matchAll(pattern)) {
    /*
     * Cut at a sentence end, then trim the punctuation.
     *
     * The capitalised run happily walks past a full stop into the next
     * sentence — "at Ziv Haddad Systems. I work on..." captured "Ziv Haddad
     * Systems. I", which then matched nothing in the CV and was silently
     * skipped. A stop followed by a space ends a sentence; the one inside
     * "Monday.com" has no space after it and survives.
     */
    const name = match[1].split(/\.\s+/)[0].replace(/[.,;:]+$/, '').trim()
    const key = normalizeCompanyName(name)

    if (!key || key.length < 3 || safe.has(key)) continue
    if (SCHOOLING.test(name)) continue
    /* One capitalised word that is also an ordinary word — "at Product", "at
       Sales" — is a sentence, not an employer. Two words, or one that the CV
       repeats, is evidence. */
    if (!cv.toLowerCase().includes(name.toLowerCase())) continue
    if (found.some((seen) => normalizeCompanyName(seen) === key)) continue

    found.push(name)
  }

  return found
}

/**
 * A plain summary built from what was extracted, for when no model is available.
 *
 * Not a substitute for a written one — it is four facts in a sentence — but the
 * product promises every candidate has a summary, and a promise that holds only
 * where an API key is configured is not one. Names no employer by construction:
 * it is assembled from a title, a seniority, an industry and a few skills, none
 * of which is an employer.
 */
export function draftSummaryDeterministically(candidateId) {
  const candidate = getCandidate(candidateId)
  if (!candidate) return null

  const profile = getExtraction(candidateId) ?? {}
  const title = String(profile.current_title ?? candidate.current_title ?? '').trim()
  const industry = String(profile.industry ?? '').trim()
  const skills = Array.isArray(candidate.skills) ? candidate.skills.slice(0, 4) : []
  const years = Number(candidate.detected_years ?? 0)

  if (!title && skills.length === 0) return null

  const opening = title
    ? (years > 0
      ? `${title} with ${years} year${years === 1 ? '' : 's'} of experience`
      : String(title))
    : 'Professional'

  const parts = [industry ? `${opening} in ${industry}.` : `${opening}.`]
  if (skills.length > 0) parts.push(`Works with ${skills.join(', ')}.`)

  return parts.join(' ')
}
