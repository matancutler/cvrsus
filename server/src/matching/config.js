/**
 * Every tunable the matching architecture depends on, in one file.
 *
 * §17 asks for this explicitly: thresholds and weights must not be scattered
 * through business logic, because the moment they are, changing one becomes a
 * code review of the whole pipeline. Nothing else in matching/ hard-codes a
 * number that belongs here.
 *
 * The VERSIONS block is what makes cached work safe to reuse. Every stored
 * artefact records the versions that produced it, so bumping one of these
 * invalidates exactly the analyses that depended on it and nothing else.
 * Bump a version when the *meaning* of the output changes, not when a comment
 * moves.
 */
const num = (name, fallback) => {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const MATCHING = {
  /** §2 — the candidate may name at most this many interest areas. */
  preferenceTagCap: num('MATCH_TAG_CAP', 10),

  /** §9.3 — how many candidates cheap retrieval hands to the funnel. */
  retrievalPoolSize: num('MATCH_POOL_SIZE', 100),

  /** §9.4 — how many of those get expensive reasoning per batch. */
  deepAnalysisBatch: num('MATCH_DEEP_BATCH', 25),

  /** §6.3 — revalidate profile intelligence this long after it was built. */
  freshnessMonths: num('MATCH_FRESHNESS_MONTHS', 6),

  /**
   * §9.2 — hybrid retrieval weights. Deliberately not normalised to 1 here:
   * the scorer divides by the sum of the weights it actually used, so a
   * candidate missing an embedding is judged on the signals that do exist
   * rather than being penalised for a gap in our data.
   */
  retrievalWeights: {
    structured: num('MATCH_W_STRUCTURED', 30),
    taxonomy: num('MATCH_W_TAXONOMY', 30),
    semantic: num('MATCH_W_SEMANTIC', 30),
    /**
     * §7 — "a modest signal". Kept small on purpose: freshness must never let
     * a clearly weaker candidate leapfrog a materially stronger one, and at
     * this weight it can only break near-ties.
     */
    freshness: num('MATCH_W_FRESHNESS', 10),
  },

  /**
   * §10.3 — the absolute fit a candidate must reach for the display scale to
   * top out at 100. Below it the whole batch is scaled down, so a weak field
   * cannot manufacture a perfect score.
   */
  credibleTopRaw: num('MATCH_CREDIBLE_TOP', 55),
}

export const VERSIONS = {
  /** Stage A: how documents become facts. */
  extraction: process.env.MATCH_V_EXTRACTION ?? '1',
  /** §4 — concept set and alias table. */
  taxonomy: process.env.MATCH_V_TAXONOMY ?? '1',
  /** Stage B: how facts become multi-label intelligence. */
  intelligence: process.env.MATCH_V_INTELLIGENCE ?? '1',
  /** §10 — the absolute-fit and normalisation methodology. */
  scoring: process.env.MATCH_V_SCORING ?? '1',
}

/**
 * §6.1 vs §6.2. The single list that decides whether a candidate edit is worth
 * paying to reinterpret.
 *
 * Kept as data rather than an if-chain because the cost of getting it wrong is
 * asymmetric and invisible: forgetting a field here means stale intelligence
 * that no test notices, while a stray addition only wastes money. Both are
 * covered by tests against these lists.
 */
export const MATCHING_RELEVANT_FIELDS = [
  'location', 'availability', 'capacity', 'notice_period',
  'open_to_relocation', 'preferred_regions',
  'skills', 'notes', 'current_title', 'desired_role',
  'open_to_all_opportunities',
]

/** §6.2 — changes that must never trigger re-analysis. */
export const COSMETIC_FIELDS = [
  'photo_name', 'password_hash', 'first_name', 'middle_name', 'last_name',
  'email', 'phone', 'links',
]
