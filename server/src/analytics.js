import db from './db.js'

/**
 * Local analytics. Posthog is not wired up, but the brief wants these events
 * tracked from day one, so they are recorded here and can be forwarded later by
 * changing this one function.
 */
export function track(name, { actorType = null, actorId = null, ...props } = {}) {
  try {
    db.prepare(`
      INSERT INTO analytics_events (name, actor_type, actor_id, props, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, actorType, actorId, JSON.stringify(props), new Date().toISOString())
  } catch {
    // Analytics must never break a request.
  }
}

/**
 * Forgets a deleted candidate, without forgetting that a deletion happened.
 *
 * Two different things live in this table under one actor. Almost every row is
 * a product event — a CV was read, a profile was built, an embedding was
 * written — and those describe a person who has asked to be erased, so they go.
 * The `candidate_account_deleted` row is the opposite: it is the record that we
 * honoured the request, and destroying it would leave no evidence the erasure
 * was ever performed.
 *
 * So that one row is redacted rather than removed. The actor id is nulled and
 * the props — which carry counts of the documents, messages and views the
 * person had — are replaced, leaving the event name and the timestamp. What
 * survives says "an account was deleted, then", and nothing about whose.
 *
 * Same reasoning as billing_ledger's exemption from the cascade in profiles.js,
 * and stated here for the same reason: an undocumented survival is a leak, and
 * a documented one is a decision.
 */
export function forgetCandidate(candidateId) {
  const redacted = db.prepare(`
    UPDATE analytics_events SET actor_id = NULL, props = ?
    WHERE actor_type = 'candidate' AND actor_id = ? AND name = 'candidate_account_deleted'
  `).run(JSON.stringify({ redacted: true }), candidateId).changes

  const removed = db.prepare(`
    DELETE FROM analytics_events WHERE actor_type = 'candidate' AND actor_id = ?
  `).run(candidateId).changes

  return { redacted, removed }
}

/** Counts per event name over a window, for the admin panel. */
export function eventCounts(sinceIso) {
  return db.prepare(`
    SELECT name, COUNT(*) AS count
    FROM analytics_events
    WHERE created_at >= ?
    GROUP BY name
    ORDER BY count DESC
  `).all(sinceIso ?? '1970-01-01')
}
