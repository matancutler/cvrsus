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
   * Ceilings on model-read analyses in a rolling 24 hours.
   *
   * Not a budget — a circuit breaker. It sits far above what real use looks
   * like, so hitting it means something is wrong rather than something is
   * popular. Over the line, scoring falls back to the deterministic path,
   * which still ranks everybody, and the recruiter is told rather than left
   * wondering why the reasoning went quiet.
   *
   * The demo's is global and much lower for the obvious reason: nobody behind
   * it is paying, anybody on the internet can start one, and eight searches an
   * hour per browser is not a limit when there is no limit on browsers.
   */
  companyDailyAnalyses: num('MATCH_DAILY_CAP', 1500),
  demoDailyAnalyses: num('DEMO_DAILY_CAP', 200),

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

  /**
   * How much of a job's weight must be evidenced before the fit is shown as a
   * number rather than as "needs review".
   *
   * Below this the arithmetic is fine and the meaning is not: 100% of the one
   * requirement out of nine a CV happened to mention is not a strong candidate.
   * The row is still shown — an unreadable CV is something to look at, not
   * somebody to discard.
   */
  coverageFloor: num('MATCH_COVERAGE_FLOOR', 50),

  /**
   * What each level of geographic friction is worth, in absolute-fit points.
   *
   * Bounded on purpose, and small. The rule this implements is "geography is
   * friction, not a fence": it separates candidates who are otherwise
   * comparable and must never move a strong candidate below a weak local one.
   * At these sizes the whole span from local to international is 12 points,
   * which reorders a cluster and cannot overturn a real difference in fit.
   *
   * Positive for being easy to hire rather than negative for being far away, so
   * a search with no location information scores exactly as it did before this
   * existed — `uncertain` is worth nothing either way.
   */
  locationBonus: {
    local: num('MATCH_LOC_LOCAL', 8),
    commutable: num('MATCH_LOC_COMMUTABLE', 6),
    remote_compatible: num('MATCH_LOC_REMOTE', 6),
    same_region: num('MATCH_LOC_REGION', 4),
    same_country_relocation: num('MATCH_LOC_COUNTRY', 2),
    international_relocation: num('MATCH_LOC_INTERNATIONAL', -4),
    uncertain: num('MATCH_LOC_UNCERTAIN', 0),
  },
}

export const VERSIONS = {
  /** Stage A: how documents become facts. */
  extraction: process.env.MATCH_V_EXTRACTION ?? '1',
  /** §4 — concept set and alias table. */
  taxonomy: process.env.MATCH_V_TAXONOMY ?? '1',
  /** Stage B: how facts become multi-label intelligence. */
  intelligence: process.env.MATCH_V_INTELLIGENCE ?? '1',
  /** §10 — the absolute-fit and normalisation methodology. */
  /* 2: fit computed in code from per-requirement verdicts, replacing the
     model-invented 0-100. Bumped so cached analyses in the old shape are not
     reused — the cache key includes this. */
  /* 3: silence earns a fraction of its weight instead of being struck from
     the fraction, and a verdict whose quote is not in the CV is downgraded.
     Bumped so the two arithmetics are never mixed in one ranking — and the
     stored analyses were MIGRATED to it rather than left behind, because
     this key is what the cache reads on and abandoning them would have paid
     a model to recompute what was already on disk. See score-migrate.mjs. */
  /* 4: the judgement rubric gained a rule separating a CV that CONTRADICTS a
     requirement from one that is merely SILENT on it - describing a different
     career is silence; contradiction is reserved for a CV that answers the
     requirement directly with the wrong answer. That changes which verdict the
     model returns, so it changes the score, so the two cannot share a cache
     key. Unlike 2 to 3, this one cannot be migrated arithmetically: a verdict
     is something only the model can produce. See score-migrate.mjs, which
     carries forward every row the rubric never touched and leaves the rest to
     be asked again. */
  scoring: process.env.MATCH_V_SCORING ?? '4',
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
