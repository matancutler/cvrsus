/**
 * §16 — the pseudoflow, executed.
 *
 * This is the only module that knows the order of the stages. Each stage lives
 * in its own file so it can change independently (§17), and this one wires them
 * together twice: once to start a search, once to extend it.
 *
 *   runSearch    JD -> job + match profile -> hard filter -> hybrid rank ->
 *                pool -> deep-analyse the first batch -> normalise -> results
 *   showMore     claim the next batch -> analyse only the new people ->
 *                renormalise across EVERYONE analysed so far -> results
 *
 * The asymmetry between those two is the whole design: the second path pays for
 * 25 analyses, not 50, and still returns scores that are comparable with the
 * first page because normalisation reads the full analysed universe.
 */
import db, { getCandidate, listCandidatesWithText } from '../db.js'
import { activityStatus, candidatesHiddenFrom } from '../profiles.js'
import { preferenceIndex, preferencePermitsJob } from './preferences.js'
import { MATCHING } from './config.js'
import { analyseBatch, analysedUniverse, analysisModel } from './analysis.js'
import { ensureJobMatchProfile, findOrCreateJob, jobConceptIds } from './jobProfile.js'
import { normalizeUniverse } from './normalize.js'
import { hardFilter, rankAndPool } from './retrieval.js'
import {
  claimNextBatch, createSession, displayedIds, getSession, latestSession,
} from './session.js'

/**
 * Starts (or resumes) a search.
 *
 * Resuming matters more than it looks: a recruiter who reopens yesterday's
 * search should not be charged for it again, and should not be shown a
 * different order. An unchanged JD produces the same job row, the same match
 * profile, the same retrieval order and therefore the same cache hits.
 */
export async function runSearch({
  recruiterId, companyId = null, chatId = null,
  jobDescription, instruction = null, title = null, refresh = false, signal,
}) {
  const { job, created } = findOrCreateJob({
    recruiterId, companyId, chatId, title, rawJd: jobDescription, instruction,
  })

  const matchProfile = await ensureJobMatchProfile(job, { signal })
  const jobConcepts = jobConceptIds(matchProfile)

  /*
   * `refresh` is the recruiter asking to run the pool again.
   *
   * Resuming is right for reopening a search — same order, no second charge —
   * but it makes "look again" impossible: the candidate pool moves, people join
   * and profiles go active, and a resumed session can only ever show the set
   * that existed when it was created. So a refresh skips the resume and builds
   * a new session against the pool as it stands now.
   *
   * It is not a re-analysis: the per-candidate judgements are cached against
   * the job, so anyone already read is reused and only newcomers cost anything.
   */
  const resumed = created || refresh ? null : latestSession({
    jobId: job.id, jdVersion: job.jd_version, recruiterId,
  })

  if (resumed) {
    const previous = await finishBatch({
      job, matchProfile, session: resumed, ids: [...displayedIds(resumed.id)],
      batchIndex: 0, resumed: true, recruiterId, signal,
    })

    /*
     * Unless there is nobody left in it.
     *
     * finishBatch re-checks eligibility on the way out, which is right: someone
     * retrieved last week may have deactivated, narrowed what they are open to,
     * or asked to be erased entirely. But when that check empties the whole
     * session, resuming stops being "the same search as before" and becomes a
     * dead end — the same job description returns nothing, for ever, with no
     * error and nothing on screen to suggest asking again would help. Only a
     * refresh escaped it, which a saved search reopened from the rail does not
     * send and the public demo cannot.
     *
     * A session decays: it is a snapshot of a pool that moves underneath it.
     * When the snapshot has emptied, the honest thing is to take another one.
     * The analyses are cached against the job, so anyone still around is reused
     * and only genuine newcomers cost anything.
     */
    if (previous.visibleIds.length > 0) return previous
  }

  const candidates = listCandidatesWithText()
  const { eligible, excluded } = hardFilter({
    candidates,
    matchProfile,
    jobConcepts,
    activityFor: activityStatus,
    /* Read per search rather than cached: somebody who adds a blocker should
       disappear from that employer's next search, not from the one after. */
    blocked: candidatesHiddenFrom(recruiterId),
  })

  const { pool, method } = rankAndPool({ eligible, matchProfile, jobConcepts })

  const session = createSession({
    jobId: job.id,
    jdVersion: job.jd_version,
    recruiterId,
    retrievedIds: pool.map((row) => row.candidate.id),
    method,
    excluded,
    poolSize: pool.length,
    batchSize: MATCHING.deepAnalysisBatch,
  })

  const batch = claimNextBatch(session.id, { batchIndex: 0 })

  return finishBatch({
    job, matchProfile, session: getSession(session.id), ids: batch.ids,
    batchIndex: 0, exhausted: batch.exhausted, universeTotal: candidates.length,
    eligibleTotal: eligible.length, recruiterId, signal,
  })
}

/**
 * §11 — the next batch.
 *
 * Idempotent: the cursor advanced when the batch was claimed, so a repeated
 * click analyses nobody twice and shows nobody twice.
 */
export async function showMore({ sessionId, recruiterId, signal }) {
  const session = getSession(sessionId)
  if (!session) return { error: 'not_found' }
  // Sessions carry a recruiter's private position in a search; another
  // recruiter must not be able to drive it, even within the same company.
  if (session.recruiterId !== recruiterId) return { error: 'forbidden' }

  const job = jobFor(session.jobId)
  if (!job) return { error: 'not_found' }

  const matchProfile = await ensureJobMatchProfile(job, { signal })
  const batch = claimNextBatch(session.id)

  if (batch.ids.length === 0) {
    // Nothing left in the pool. Return what exists rather than an error: the
    // recruiter has simply reached the end of this retrieval.
    return finishBatch({
      job, matchProfile, session, ids: [], batchIndex: batch.batchIndex,
      exhausted: true, recruiterId, signal,
    })
  }

  return finishBatch({
    job, matchProfile, session, ids: batch.ids,
    batchIndex: batch.batchIndex, exhausted: batch.exhausted, recruiterId, signal,
  })
}

function jobFor(jobId) {
  return db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(jobId) ?? null
}

/**
 * Analyses the claimed ids, then rescores the whole analysed universe.
 *
 * `analysedUniverse` is read from the cache table rather than from this batch,
 * which is what keeps §10.2's promise across pages: the 26th candidate is
 * scored against candidates 1-50, not against candidates 26-50.
 */
async function finishBatch({
  job, matchProfile, session, ids, batchIndex, exhausted = false,
  universeTotal = null, eligibleTotal = null, resumed = false, recruiterId = null, signal,
}) {
  const rows = ids.length > 0 ? rowsFor(ids) : []

  const analysis = ids.length > 0
    ? await analyseBatch({ job, matchProfile, rows, signal })
    : { results: new Map(), analysed: 0, reused: 0 }

  const universe = analysedUniverse({ jobId: job.id, jdVersion: job.jd_version })
  const scores = normalizeUniverse(universe)

  /*
   * §7, §9.1 — eligibility is re-checked on the way out, not just on the way in.
   *
   * A session outlives the state it was built from. Someone retrieved last week
   * may have deactivated since, or narrowed what they are open to; a resumed or
   * extended search would otherwise keep showing them, because the hard filter
   * ran once at creation and never again. The cached analysis is still valid
   * work and is kept — it simply stops being displayed.
   *
   * This is the difference between a candidate opting out and a candidate
   * appearing to opt out. Only one of them is a promise we can keep.
   */
  const preferences = preferenceIndex()
  const jobConcepts = jobConceptIds(matchProfile)

  /*
   * Blocks are re-checked here too, and this was the gap.
   *
   * The paragraph above promises eligibility is re-checked on the way out, and
   * it was — for activity and for stated preferences, but not for employer
   * blocks, which were tested once by the hard filter when the pool was built.
   * So a candidate who blocked a company after a search had run stayed visible
   * in that search for as long as the session lasted, and every page of Show
   * more kept serving them. Of the three ways a candidate can withdraw, this
   * was the only one they had asked for by name.
   *
   * recruiterId defaults to null so an omission cannot silently skip the check:
   * candidatesHiddenFrom treats anything that is not a real recruiter id as the
   * anonymous case, which withholds more rather than less.
   */
  const blocked = candidatesHiddenFrom(recruiterId ?? session.recruiterId ?? null)

  const visibleIds = [...displayedIds(session.id)].filter((id) => {
    const candidate = getCandidate(id)
    if (!candidate) return false
    if (blocked.has(id)) return false
    if (!activityStatus(candidate).visibleToRecruiters) return false
    return preferencePermitsJob(preferences.get(id), jobConcepts).allowed
  })

  return {
    job,
    matchProfile,
    session,
    visibleIds,
    batchIndex,
    exhausted,
    resumed,
    analysed: analysis.analysed,
    reused: analysis.reused,
    scores,
    universe,
    analysisModel: analysisModel(),
    stats: {
      universeTotal,
      eligibleTotal,
      poolSize: session.retrievedIds.length,
      excluded: session.excluded.length,
      batchSize: session.batchSize,
    },
  }
}

/** Candidate rows for a set of ids, in the order the ids were given. */
function rowsFor(ids) {
  const wanted = new Set(ids)
  const byId = new Map(
    listCandidatesWithText().filter((row) => wanted.has(row.id)).map((row) => [row.id, row]),
  )

  return ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((candidate) => ({ candidate, cvText: candidate.cv_text }))
}
