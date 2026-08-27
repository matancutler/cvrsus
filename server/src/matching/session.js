/**
 * §11 — Show More without moving anything.
 *
 * The spec is explicit that previously displayed candidates must not be shuffled
 * to the bottom of the database. Nothing about a candidate changes when a
 * recruiter pages through results; what changes is this session's cursor. So the
 * ordering lives here, in per-search state, and the candidate rows are never
 * touched.
 *
 * Idempotency is the other requirement, and it is the one that costs money when
 * it fails: a double-clicked Show More must not analyse the next 25 people
 * twice. The cursor advances inside the same transaction that records the
 * batch, so a repeat sees the work already done.
 */
import db from '../db.js'

import { MATCHING } from './config.js'

export function createSession({ jobId, jdVersion, recruiterId, retrievedIds, method, excluded, poolSize, batchSize }) {
  const now = new Date().toISOString()

  const result = db.prepare(`
    INSERT INTO retrieval_sessions (
      job_id, jd_version, recruiter_id, retrieved_ids, cursor, pool_size,
      batch_size, retrieval_method, excluded, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
  `).run(
    jobId, jdVersion, recruiterId, JSON.stringify(retrievedIds),
    poolSize ?? MATCHING.retrievalPoolSize, batchSize ?? MATCHING.deepAnalysisBatch,
    method ?? null, JSON.stringify(excluded ?? []), now, now,
  )

  return getSession(result.lastInsertRowid)
}

export function getSession(sessionId) {
  const row = db.prepare(`SELECT * FROM retrieval_sessions WHERE id = ?`).get(sessionId)
  if (!row) return null

  return {
    id: row.id,
    jobId: row.job_id,
    jdVersion: row.jd_version,
    recruiterId: row.recruiter_id,
    retrievedIds: JSON.parse(row.retrieved_ids),
    cursor: row.cursor,
    poolSize: row.pool_size,
    batchSize: row.batch_size,
    method: row.retrieval_method,
    excluded: JSON.parse(row.excluded ?? '[]'),
  }
}

/**
 * The most recent session for this recruiter and job version.
 *
 * Reopening an unchanged search resumes rather than restarting, which is what
 * makes §18's "reopening reuses existing analyses" true at the session layer as
 * well as the cache layer.
 */
export function latestSession({ jobId, jdVersion, recruiterId }) {
  const row = db.prepare(`
    SELECT id FROM retrieval_sessions
    WHERE job_id = ? AND jd_version = ? AND recruiter_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(jobId, jdVersion, recruiterId)

  return row ? getSession(row.id) : null
}

/** Candidate ids this session has already put in front of the recruiter. */
export function displayedIds(sessionId) {
  return new Set(
    db.prepare(`SELECT candidate_id FROM displayed_match_state WHERE session_id = ?`)
      .all(sessionId).map((row) => row.candidate_id),
  )
}

/**
 * Claims the next batch and advances the cursor atomically.
 *
 * Returns the candidate ids to analyse. An exhausted session returns an empty
 * array rather than wrapping around — running off the end of the pool is a
 * normal outcome, not an error, and §11 says the caller may then widen
 * retrieval.
 */
export function claimNextBatch(sessionId, { batchIndex } = {}) {
  return db.transaction(() => {
    const session = getSession(sessionId)
    if (!session) return { ids: [], exhausted: true, batchIndex: 0 }

    const start = session.cursor
    const ids = session.retrievedIds.slice(start, start + session.batchSize)

    if (ids.length === 0) return { ids: [], exhausted: true, batchIndex: batchIndex ?? 0 }

    db.prepare(`UPDATE retrieval_sessions SET cursor = ?, updated_at = ? WHERE id = ?`)
      .run(start + ids.length, new Date().toISOString(), sessionId)

    const index = batchIndex ?? Math.floor(start / Math.max(1, session.batchSize))
    const now = new Date().toISOString()
    const mark = db.prepare(`
      INSERT INTO displayed_match_state (session_id, candidate_id, batch_index, displayed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (session_id, candidate_id) DO NOTHING
    `)
    for (const id of ids) mark.run(sessionId, id, index, now)

    return {
      ids,
      exhausted: start + ids.length >= session.retrievedIds.length,
      batchIndex: index,
    }
  })()
}

/**
 * Replaces the retrieval list when the pool is exhausted but the recruiter
 * wants more (§11, final bullet).
 *
 * Already-retrieved ids are appended to rather than overwritten, so the cursor
 * stays meaningful and nobody analysed under the old list is offered again.
 */
export function extendSession(sessionId, additionalIds) {
  const session = getSession(sessionId)
  if (!session) return null

  const known = new Set(session.retrievedIds)
  const fresh = additionalIds.filter((id) => !known.has(id))
  if (fresh.length === 0) return session

  db.prepare(`UPDATE retrieval_sessions SET retrieved_ids = ?, pool_size = ?, updated_at = ? WHERE id = ?`)
    .run(
      JSON.stringify([...session.retrievedIds, ...fresh]),
      session.retrievedIds.length + fresh.length,
      new Date().toISOString(), sessionId,
    )

  return getSession(sessionId)
}
