/*
 * Does this recruiter's organisation correspond to a company a candidate asked
 * not to be seen by?
 *
 * Kept in its own module because the answer will get better over time and the
 * places that ask the question should not have to change when it does. Every
 * caller wants one boolean, and every caller gets it from `companyNamesMatch`.
 *
 * This is a privacy control, so the bias runs one way: a missed match shows
 * somebody to an employer they hid from, which is the failure that matters, but
 * a false match is not free either — it silently removes a candidate from a
 * company that never did anything wrong, and neither side is told. So the rules
 * here are deterministic and explainable, and a name has to actually look like
 * the other name rather than merely score well against it.
 *
 * Deliberately NOT here: embedding similarity, edit distance, and any model
 * call. "Delta" and "Delco" are one edit apart and are not the same firm.
 */
import { normalizeCompanyName } from './schema.js'

/*
 * Words that identify nobody on their own.
 *
 * These exist so that a single-token block cannot swallow every organisation
 * that happens to share a common word: blocking "Global" must not hide somebody
 * from "Global Payments", "Global Foods" and "Global Logistics" alike, and a
 * candidate who typed one of these almost certainly meant a longer name.
 *
 * They are only ever consulted for the ONE-token case. "Global Payments" is two
 * tokens and matches "Global Payments Ltd" exactly as you would expect.
 */
const GENERIC_TOKENS = new Set([
  'group', 'global', 'international', 'holdings', 'partners', 'ventures',
  'solutions', 'systems', 'services', 'consulting', 'consultants', 'technologies',
  'technology', 'tech', 'digital', 'labs', 'studio', 'studios', 'media', 'agency',
  'capital', 'management', 'industries', 'enterprises', 'associates', 'company',
  'trading', 'software', 'security', 'health', 'finance', 'financial', 'bank',
  'insurance', 'energy', 'retail', 'foods', 'group', 'israel', 'usa', 'uk',
  'europe', 'asia', 'america', 'national', 'general', 'united', 'first', 'new',
  'the', 'and', 'of',
])

/** The shortest a lone token may be before it is allowed to match a longer name. */
const MIN_DISTINCTIVE_LENGTH = 3

/** Normalised name to its words. Exported so callers can explain a decision. */
export function companyTokens(value) {
  const normalized = normalizeCompanyName(value)
  return normalized ? normalized.split(' ').filter(Boolean) : []
}

/**
 * Is `shorter` a prefix of `longer`, word for word?
 *
 * Anchored at the start on purpose. "Apple" appears inside "Big Apple Movers",
 * and an unanchored subset test would treat those as one company.
 */
function isPrefix(shorter, longer) {
  if (shorter.length === 0 || shorter.length >= longer.length) return false
  return shorter.every((token, index) => token === longer[index])
}

/**
 * Would a candidate who wrote `blockedName` mean the organisation `orgName`?
 *
 * The layers, in order, each stricter than a human would need to be:
 *
 *   1. Identical once normalised. "KPMG Ltd" and "kpmg" are one company.
 *   2. One name is the other with more words on the end, and the shorter name
 *      is distinctive enough to stand alone. "KPMG" matches "KPMG Israel";
 *      "Tech" does not match "Tech Solutions", because "tech" identifies
 *      nobody.
 *
 * Everything else is a non-match, including names that merely share a word.
 */
export function companyNamesMatch(blockedName, orgName) {
  const blocked = companyTokens(blockedName)
  const org = companyTokens(orgName)
  if (blocked.length === 0 || org.length === 0) return false

  // 1. Same name.
  if (blocked.length === org.length && blocked.every((token, i) => token === org[i])) return true

  // 2. Same name, plus a region, division or suffix the other side omitted.
  const [shorter, longer] = blocked.length < org.length ? [blocked, org] : [org, blocked]
  if (!isPrefix(shorter, longer)) return false

  /*
   * A single word carries the whole match here, so it has to be able to. Two or
   * more words are treated as distinctive on their own: "New York Times" leads
   * with two stoplisted words and is nobody else.
   */
  if (shorter.length === 1) {
    const [token] = shorter
    if (token.length < MIN_DISTINCTIVE_LENGTH) return false
    if (GENERIC_TOKENS.has(token)) return false
  }

  return true
}

/**
 * The blocked names an organisation matches, from a list of stored ones.
 *
 * Takes the names rather than reading them, so the matching can be tested and
 * reasoned about without a database, and so the query shape stays the caller's
 * business.
 */
export function matchingBlockedNames(normalizedNames, orgName) {
  if (!orgName) return []
  return normalizedNames.filter((name) => companyNamesMatch(name, orgName))
}
