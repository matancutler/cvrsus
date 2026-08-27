/**
 * §6.3 — the six-month freshness cycle.
 *
 * Built and callable, but deliberately NOT on a timer. Scheduling it is a
 * decision about spending money on somebody else's behalf, and it should be
 * switched on knowingly rather than inherited from a default. Run it from
 * `node server/scripts/revalidate.mjs` until then.
 *
 * The governing rule is §6.3's: do not pay to reinterpret identical documents.
 * A profile due for revalidation is not automatically re-read. It is compared
 * against what produced its current interpretation, and only the ones whose
 * inputs or model versions actually moved are rebuilt. Everything else has its
 * clock reset, which costs nothing.
 */
import db from '../db.js'
import { sourceHash } from '../embeddings.js'
import { matchingDocumentText } from '../profiles.js'
import { VERSIONS } from './config.js'
import { TAXONOMY_VERSION } from './taxonomy.js'
import { buildIntelligence, needsRevalidation } from './intelligence.js'

/** Candidates whose interpretation is older than the cycle. */
export function dueForRevalidation({ now = new Date(), limit = 500 } = {}) {
  return db.prepare(`
    SELECT id FROM candidates
    WHERE deactivated_at IS NULL
    ORDER BY intelligence_at IS NULL DESC, intelligence_at ASC
    LIMIT ?
  `).all(limit)
    .map((row) => row.id)
    .filter((id) => needsRevalidation(id, now))
}

/**
 * Why this profile would or would not be rebuilt.
 *
 * Separated from the doing so the sweep can be inspected before it is trusted
 * with a budget — `--dry-run` prints exactly this.
 */
export function revalidationPlan(candidateId) {
  const stored = db.prepare(`
    SELECT taxonomy_version, intelligence_version, extraction_version
    FROM candidate_profile_intelligence i
    JOIN candidates c ON c.id = i.candidate_id AND c.profile_version = i.profile_version
    WHERE i.candidate_id = ?
  `).get(candidateId)

  if (!stored) return { candidateId, rebuild: true, reason: 'no interpretation on file' }

  if (stored.taxonomy_version !== TAXONOMY_VERSION) {
    return { candidateId, rebuild: true, reason: `taxonomy ${stored.taxonomy_version} -> ${TAXONOMY_VERSION}` }
  }
  if (stored.intelligence_version !== VERSIONS.intelligence) {
    return { candidateId, rebuild: true, reason: `intelligence ${stored.intelligence_version} -> ${VERSIONS.intelligence}` }
  }

  /*
   * Nothing about the model changed, so the only question left is whether the
   * documents did. Hashing them is far cheaper than reinterpreting them, and
   * §6.3 is explicit that identical sources must not be paid for twice.
   */
  const current = sourceHash(matchingDocumentText(candidateId))
  const previous = db.prepare(
    `SELECT source_hash FROM embeddings WHERE candidate_id = ?`,
  ).get(candidateId)?.source_hash

  if (previous && previous !== current) {
    return { candidateId, rebuild: true, reason: 'documents changed since the last build' }
  }

  return { candidateId, rebuild: false, reason: 'unchanged — clock reset only' }
}

/** Resets the freshness clock without rebuilding anything. */
function touch(candidateId, now) {
  db.prepare(`UPDATE candidates SET intelligence_at = ? WHERE id = ?`)
    .run(now.toISOString(), candidateId)
}

/**
 * Runs one pass. Returns what it did, per candidate, so a scheduled run can be
 * logged and a manual one can be read.
 */
export function runRevalidation({ now = new Date(), limit = 500, dryRun = false } = {}) {
  const due = dueForRevalidation({ now, limit })
  const plans = due.map(revalidationPlan)

  if (dryRun) {
    return {
      dryRun: true,
      due: due.length,
      wouldRebuild: plans.filter((plan) => plan.rebuild).length,
      wouldTouch: plans.filter((plan) => !plan.rebuild).length,
      plans,
    }
  }

  let rebuilt = 0
  let touched = 0
  const failures = []

  for (const plan of plans) {
    try {
      if (plan.rebuild) { buildIntelligence(plan.candidateId, { now }); rebuilt += 1 }
      else { touch(plan.candidateId, now); touched += 1 }
    } catch (error) {
      // One bad profile must not stop the sweep; it is retried next cycle with
      // its clock untouched, so nothing is silently skipped forever.
      failures.push({ candidateId: plan.candidateId, error: error.message })
    }
  }

  return { dryRun: false, due: due.length, rebuilt, touched, failures, plans }
}
