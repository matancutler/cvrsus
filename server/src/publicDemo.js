import crypto from 'node:crypto'

import db from './db.js'
import { runSearch } from './matching/pipeline.js'
import { getConcept } from './matching/taxonomy.js'
import { getCandidate } from './db.js'
import { track } from './analytics.js'

/**
 * The live JD demo on the recruiter landing page.
 *
 * A recruiter with no account pastes a job description and gets real matches
 * from the real pool, masked. The point of the feature is that it is not a
 * mock-up: it runs the same pipeline an authenticated search runs, so what a
 * stranger sees is what the product actually does. That also means the masking
 * here is the only thing between the public internet and the candidate pool,
 * and it is applied on the way out of the server rather than in the browser.
 *
 * Two things are deliberately not the authenticated behaviour:
 *
 *   - The view is narrower than the pre-reveal recruiter view. That one still
 *     carries a first name and the candidate's own id, both of which are fine
 *     for somebody who has been approved and is spending money, and neither of
 *     which belongs in a response anyone on the internet can ask for.
 *   - Nothing here can spend a reveal. The route that reveals is behind
 *     recruiterOnly, and this module never calls it.
 */

/* Reserved owner for a search nobody has claimed. Recruiter ids are
   AUTOINCREMENT from 1, so this belongs to no account and cannot be read
   through any authenticated route. */
export const ANONYMOUS_RECRUITER_ID = 0

const asInt = (value, fallback) => {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

/**
 * Everything tunable, from the environment rather than from the UI.
 *
 * §8 asks that limits be configurable rather than baked into interface logic —
 * a threshold that only exists in the client is a threshold an attacker edits
 * out.
 */
export const PUBLIC_DEMO = {
  /* Enough of a brief to match against. A one-word "developer" cannot produce
     a meaningful ranking, and pretending otherwise wastes the analysis budget
     and misrepresents the product. */
  minJdLength: asInt(process.env.PUBLIC_DEMO_MIN_JD, 80),
  maxJdLength: asInt(process.env.PUBLIC_DEMO_MAX_JD, 20000),
  /* How many masked cards a stranger sees. Enough to judge the pool, not
     enough to be worth harvesting. */
  maxResults: asInt(process.env.PUBLIC_DEMO_MAX_RESULTS, 6),
  /* Below this a match is not worth showing. §9: do not fill the page with
     weak candidates — say there are not enough strong ones. */
  minScore: asInt(process.env.PUBLIC_DEMO_MIN_SCORE, 40),
  searchesPerWindow: asInt(process.env.PUBLIC_DEMO_MAX_SEARCHES, 8),
  windowMinutes: asInt(process.env.PUBLIC_DEMO_WINDOW_MINUTES, 60),
  /*
   * How many CVs a stranger may put through Triage to see what it does.
   *
   * Enough to be a real pile rather than a toy — a ranking of three files
   * proves nothing about ranking — and small enough that the work is bounded:
   * these are read and scored deterministically, never sent to a model, so the
   * cost is CPU on a handful of documents and nothing per CV.
   *
   * The number is also on the composer's placeholder, so it is stated here and
   * reported to the client rather than written twice.
   */
  triageMaxFiles: asInt(process.env.PUBLIC_DEMO_TRIAGE_MAX_FILES, 25),
  /*
   * There is deliberately no per-file byte ceiling here.
   *
   * The multer instance the route mounts already carries the site-wide 5MB
   * limit from MAX_DOCUMENT_BYTES, which is stricter than anything this file
   * would sensibly set. A second number would be inert at best and, the day
   * somebody raised it, would read as a promise the parser does not keep.
   */
}

/**
 * A per-search handle for a candidate.
 *
 * Derived rather than stored, and scoped to one search: the same candidate in
 * two different demo searches gets two different tokens, so tokens cannot be
 * collected and compared across searches to work out that they refer to one
 * person. Resolving one means checking it against the candidates that search
 * actually returned, which also means a token from search A is meaningless
 * against search B.
 *
 * §8 — "prevent enumeration of candidate IDs where practical; use opaque
 * identifiers/tokens".
 */
function candidateToken(searchToken, candidateId, secret) {
  return crypto.createHmac('sha256', secret)
    .update(`${searchToken}:${candidateId}`)
    .digest('hex')
    .slice(0, 24)
}

/** Which candidate a token refers to, or null. Constant-time per comparison. */
export function candidateForToken({ searchToken, token, candidateIds, secret }) {
  const wanted = String(token ?? '')
  for (const id of candidateIds) {
    const expected = candidateToken(searchToken, id, secret)
    if (expected.length === wanted.length
      && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(wanted))) {
      return id
    }
  }
  return null
}

/**
 * Years of experience, rounded to something a card can say.
 *
 * Deliberately coarse. An exact figure alongside a title and a city starts to
 * describe one person rather than a kind of person.
 */
function experienceBand(candidate) {
  const years = Number(candidate?.years_experience)
  if (!Number.isFinite(years) || years <= 0) return null
  if (years < 2) return 'Under 2 years'
  if (years < 5) return '2-5 years'
  if (years < 8) return '5-8 years'
  if (years < 12) return '8-12 years'
  return '12+ years'
}

/**
 * What to call a candidate who has recorded no job title.
 *
 * The heading is their role — "Senior Backend Engineer" — which most profiles
 * carry. Where the field is empty the card used to fall back to the words
 * "Candidate profile", which says nothing at all and reads as a stub.
 *
 * Built from the taxonomy the matcher already assigned, most specific first: a
 * specialization if one was found, otherwise the broader function. Both are
 * canonical concept ids resolved to their fixed labels — deliberately not the
 * raw_label beside them, which is free text the model wrote out of the CV and
 * has been seen to carry things like "Backend engineer - Tel Aviv". On a public
 * endpoint a fixed vocabulary is the difference between a heading that cannot
 * leak and one that merely has not yet.
 */
function taxonomyHeadline(candidateId) {
  const labels = db.prepare(`
    SELECT dimension, concept_id
    FROM candidate_taxonomy_labels
    WHERE candidate_id = ? AND dimension IN ('specialization', 'function')
    ORDER BY CASE dimension WHEN 'specialization' THEN 0 ELSE 1 END, confidence DESC
    LIMIT 1
  `).get(candidateId)

  return labels ? getConcept(labels.concept_id)?.label ?? null : null
}

/**
 * The public card.
 *
 * An allowlist, not a delete-list. Every field here was chosen; anything added
 * to the candidates table in future is absent by default rather than leaking
 * because nobody remembered to exclude it. §4 names what must never appear —
 * name, email, telephone, links, filenames — and none of them can, because
 * none of them is copied.
 */
function publicCard({ searchToken, candidateId, candidate, score, analysis, secret }) {
  const skills = Array.isArray(candidate.skills)
    ? candidate.skills
    : String(candidate.skills ?? '').split(',').map((s) => s.trim()).filter(Boolean)

  return {
    token: candidateToken(searchToken, candidateId, secret),
    score,
    /* The role, not the employer: "Senior Backend Engineer" describes the
       person, "Senior Backend Engineer at <small startup>" identifies them.
       Falls back to how the matcher categorised them rather than to a word
       meaning "we know nothing". */
    title: candidate.current_title || candidate.desired_role || taxonomyHeadline(candidateId),
    /* An area rather than an address. */
    location: candidate.location || null,
    experience: experienceBand(candidate),
    skills: skills.slice(0, 6),
    availability: candidate.availability || null,
    /* Why this one — the same explanation the authenticated result carries,
       which is the whole argument for the demo being honest. */
    reason: analysis?.explanation ?? null,
  }
}

/**
 * Run a demo search and return the masked payload.
 *
 * `visibleIds` and `scores` come straight from the pipeline, so the ordering
 * and the numbers are the product's own. The only editing is dropping weak
 * matches and capping the count.
 */
export async function runPublicSearch({ jobDescription, clientHash = null, secret, signal }) {
  const outcome = await runSearch({
    recruiterId: ANONYMOUS_RECRUITER_ID,
    companyId: null,
    jobDescription,
    signal,
  })

  const searchToken = crypto.randomBytes(24).toString('base64url')
  const byId = new Map(outcome.universe.map((row) => [row.candidateId, row]))

  const ranked = outcome.visibleIds
    .map((id) => ({ id, score: outcome.scores.get(id) ?? 0 }))
    .filter((row) => row.score >= PUBLIC_DEMO.minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, PUBLIC_DEMO.maxResults)

  const results = ranked
    .map(({ id, score }) => {
      const candidate = getCandidate(id)
      if (!candidate) return null
      return publicCard({
        searchToken, candidateId: id, candidate, score,
        analysis: byId.get(id) ?? null, secret,
      })
    })
    .filter(Boolean)

  db.prepare(`
    INSERT INTO public_searches (token, job_id, session_id, result_count, client_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    searchToken, outcome.job.id, outcome.session.id,
    results.length, clientHash, new Date().toISOString(),
  )

  return {
    searchToken,
    title: outcome.job.title ?? null,
    /* How the role was read. Useful, and says nothing about any candidate. */
    interpretation: outcome.matchProfile?.interpretation ?? null,
    results,
    /* §9 — how many were considered, so "only two" reads as a fact about the
       pool rather than as a broken search. */
    considered: outcome.stats?.poolSize ?? outcome.universe.length,
    truncated: ranked.length < outcome.visibleIds
      .filter((id) => (outcome.scores.get(id) ?? 0) >= PUBLIC_DEMO.minScore).length,
  }
}

/** The stored record for a token, or null. */
export function publicSearch(token) {
  return db.prepare(`SELECT * FROM public_searches WHERE token = ?`).get(String(token ?? '')) ?? null
}

/**
 * Remember which candidate the sign-up gate interrupted.
 *
 * Recorded server-side against the search rather than carried in the browser,
 * because it has to survive the round trip through registration — and because
 * the candidate is identified here by a real id, which is exactly what the
 * public side is not allowed to hold.
 */
export function recordRevealIntent({ token, candidateId }) {
  return db.prepare(`
    UPDATE public_searches SET intent_candidate_id = ?
    WHERE token = ? AND claimed_company_id IS NULL
  `).run(candidateId, String(token ?? '')).changes > 0
}

/**
 * The search a newly approved recruiter left behind, if any.
 *
 * Looked up by company rather than by recruiter: the person who registered is
 * the company's first administrator, and the search belongs to the account they
 * created. Most recent first, so a recruiter who demoed twice resumes the one
 * they actually converted on.
 */
export function claimedSearchFor(companyId) {
  /*
   * The job description comes back with it. Re-running that text finds the same
   * job by hash and resumes its existing session, so the recruiter is shown the
   * ranking they saw as a stranger rather than a fresh one that could differ —
   * which is the difference between restoring their search and running a new
   * one that happens to look similar.
   */
  return db.prepare(`
    SELECT p.job_id, p.session_id, p.intent_candidate_id, p.claimed_at, j.raw_jd
    FROM public_searches p
    JOIN jobs j ON j.id = p.job_id
    WHERE p.claimed_company_id = ?
    ORDER BY p.claimed_at DESC
    LIMIT 1
  `).get(companyId) ?? null
}

/** The candidates a given demo search returned, for resolving a card token. */
export function searchCandidateIds(sessionId) {
  return db.prepare(
    `SELECT candidate_id FROM displayed_match_state WHERE session_id = ?`,
  ).all(sessionId).map((row) => row.candidate_id)
}

/**
 * Hand an anonymous search to the account that just registered.
 *
 * The job and its retrieval session are re-pointed rather than copied, so the
 * recruiter resumes the search they actually ran — same job, same ranking, same
 * cached analyses — instead of a re-run that might rank differently and make
 * the demo look like a lie.
 *
 * Idempotent and one-way: a search already claimed cannot be claimed again, so
 * a replayed request cannot move somebody else's search onto your account.
 */
export function claimPublicSearch({ token, recruiterId, companyId }) {
  const record = publicSearch(token)
  if (!record) return { ok: false, reason: 'not_found' }
  if (record.claimed_company_id !== null) {
    return record.claimed_company_id === companyId
      ? { ok: true, jobId: record.job_id, sessionId: record.session_id, alreadyClaimed: true }
      : { ok: false, reason: 'already_claimed' }
  }

  db.transaction(() => {
    db.prepare(`UPDATE jobs SET recruiter_id = ?, company_id = ? WHERE id = ? AND recruiter_id = ?`)
      .run(recruiterId, companyId, record.job_id, ANONYMOUS_RECRUITER_ID)
    db.prepare(`UPDATE retrieval_sessions SET recruiter_id = ? WHERE id = ? AND recruiter_id = ?`)
      .run(recruiterId, record.session_id, ANONYMOUS_RECRUITER_ID)
    db.prepare(`
      UPDATE public_searches SET claimed_company_id = ?, claimed_at = ?
      WHERE token = ? AND claimed_company_id IS NULL
    `).run(companyId, new Date().toISOString(), token)
  })()

  track('demo_search_claimed', {
    actorType: 'recruiter', actorId: recruiterId, companyId, jobId: record.job_id,
  })

  return { ok: true, jobId: record.job_id, sessionId: record.session_id, alreadyClaimed: false }
}

/**
 * Whether this client has run too many searches lately.
 *
 * Counted from what was actually stored rather than from an in-memory counter,
 * so a restart does not reset somebody's allowance, and counted per client
 * fingerprint rather than per IP alone — an office behind one NAT address is
 * many genuine recruiters. express-rate-limit still guards the route itself;
 * this is the second, slower limit that survives process restarts.
 */
export function recentSearchCount(clientHash) {
  if (!clientHash) return 0
  const since = new Date(Date.now() - PUBLIC_DEMO.windowMinutes * 60_000).toISOString()

  /*
   * Both kinds of run, against one allowance.
   *
   * A demo search leaves a public_searches row; a demo Triage leaves nothing
   * anywhere, deliberately, so it needs its own record or it is not counted at
   * all. Counting only searches would have meant the sentence in the Triage
   * route — "so a visitor cannot run the search demo out and then keep going
   * here" — was true one way round and false the other: searches throttled
   * Triage, and Triage throttled nothing.
   */
  const searches = db.prepare(
    `SELECT COUNT(*) AS n FROM public_searches WHERE client_hash = ? AND created_at > ?`,
  ).get(clientHash, since).n

  const runs = db.prepare(
    `SELECT COUNT(*) AS n FROM public_demo_runs WHERE client_hash = ? AND created_at > ?`,
  ).get(clientHash, since).n

  return searches + runs
}

/**
 * Records a demo run that leaves no other trace.
 *
 * Written before the work rather than after it: a run that fails halfway still
 * cost the server the reading it did, and a throttle that only counts successes
 * is a throttle somebody can hold open by failing.
 */
export function recordDemoRun({ kind, clientHash }) {
  db.prepare(
    `INSERT INTO public_demo_runs (kind, client_hash, created_at) VALUES (?, ?, ?)`,
  ).run(String(kind), clientHash ?? null, new Date().toISOString())
}

/** A stable, non-reversible handle for one client. Never stores the address. */
export function clientFingerprint(req, secret) {
  const ip = req.ip ?? req.socket?.remoteAddress ?? ''
  const agent = req.get?.('user-agent') ?? ''
  return crypto.createHmac('sha256', secret).update(`${ip}|${agent}`).digest('hex').slice(0, 32)
}

/**
 * How long an anonymous demonstration's leftovers are kept.
 *
 * Comfortably longer than PUBLIC_DEMO.windowMinutes, because these rows are
 * also the durable throttle: recentSearchCount counts stored public_searches
 * and public_demo_runs rows, so deleting one inside the window hands a client
 * back an allowance it has already spent. Seven days leaves that mechanism
 * alone entirely while still putting an end to rows that otherwise last as long
 * as the database does.
 */
const DEMO_RETENTION_DAYS = 7

/**
 * Deletes what an anonymous demonstration leaves behind.
 *
 * Nothing here had any expiry. A demo search writes rows into five tables —
 * jobs, job_match_profiles, retrieval_sessions, displayed_match_state and
 * public_searches — all owned by ANONYMOUS_RECRUITER_ID, and no deletion path
 * in the product could reach any of them: they belong to no account, so closing
 * an account never touched them.
 *
 * Three things make this more delicate than it looks, and each is why a step is
 * written the way it is:
 *
 *   1. A CLAIMED search must survive. Registering after a demonstration
 *      re-points its job and session at the new recruiter and stamps
 *      claimed_company_id; claimedSearchFor then reads the row back to restore
 *      the search. So claimed rows are excluded, and the recruiter_id = 0 tests
 *      below already exclude the re-pointed jobs and sessions.
 *   2. Anonymous JOBS ARE SHARED. findOrCreateJob dedupes on (recruiter_id,
 *      jd_hash), so one job row serves every visitor who pasted the same text —
 *      in the live database, 144 searches over 7 jobs. Deleting a job because
 *      one search expired would destroy the others, so jobs go last and only
 *      when nothing points at them any more.
 *   3. There are no foreign keys on any of these tables, so SQLite will not
 *      order this or catch a mistake. Children first, in one transaction; the
 *      dangling job_ids already sitting in public_searches are what the last
 *      hand-ordered cleanup left behind.
 */
export function sweepAnonymousDemoArtefacts() {
  const cutoff = new Date(Date.now() - DEMO_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()

  return db.transaction(() => {
    const removed = {}

    removed.searches = db.prepare(`
      DELETE FROM public_searches
      WHERE claimed_company_id IS NULL AND created_at < ?
    `).run(cutoff).changes

    removed.runs = db.prepare(
      `DELETE FROM public_demo_runs WHERE created_at < ?`,
    ).run(cutoff).changes

    /*
     * Sessions still owned by nobody, that no surviving search points at.
     * The anti-join is what keeps a claimed search's session — and a session
     * from a search inside the retention window — out of reach.
     */
    removed.displayed = db.prepare(`
      DELETE FROM displayed_match_state
      WHERE session_id IN (
        SELECT id FROM retrieval_sessions
        WHERE recruiter_id = ? AND created_at < ?
          AND id NOT IN (SELECT session_id FROM public_searches)
      )
    `).run(ANONYMOUS_RECRUITER_ID, cutoff).changes

    removed.sessions = db.prepare(`
      DELETE FROM retrieval_sessions
      WHERE recruiter_id = ? AND created_at < ?
        AND id NOT IN (SELECT session_id FROM public_searches)
    `).run(ANONYMOUS_RECRUITER_ID, cutoff).changes

    /* Jobs last, and only the orphans: see note 2 above. */
    const orphanJobs = `
      SELECT id FROM jobs
      WHERE recruiter_id = ${ANONYMOUS_RECRUITER_ID}
        AND created_at < ?
        AND id NOT IN (SELECT job_id FROM public_searches)
        AND id NOT IN (SELECT job_id FROM retrieval_sessions)
    `

    removed.analyses = db.prepare(
      `DELETE FROM candidate_job_analyses WHERE job_id IN (${orphanJobs})`,
    ).run(cutoff).changes

    removed.profiles = db.prepare(
      `DELETE FROM job_match_profiles WHERE job_id IN (${orphanJobs})`,
    ).run(cutoff).changes

    removed.jobs = db.prepare(`DELETE FROM jobs WHERE id IN (${orphanJobs})`).run(cutoff).changes

    return removed
  })()
}
