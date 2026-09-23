#!/usr/bin/env node
/**
 * Buys the half of a rubric migration that cannot be done for free.
 *
 *   npm run score:rubric                 what is left, and what it would cost
 *   npm run score:rubric -- --run        ask the model, and write the answers
 *   npm run score:rubric -- --limit 25   a first tranche, to read the output
 *   npm run score:rubric -- --job 12     one job's analyses
 *
 * ---
 *
 * WHY THIS IS A SEPARATE COMMAND
 *
 * score-migrate.mjs makes no model call. That is not an accident of how it was
 * written, it is the property that lets the server run it unattended on every
 * boot: the worst a bug in it can do is write a wrong number, not spend money.
 * A rubric bump breaks that, because the thing that changed is what a verdict
 * MEANS, and a verdict is something only the model can produce.
 *
 * So the migration is split along the line where the bill starts. score-migrate
 * carries forward every row the rubric could not have touched - the
 * keyword-scored ones, which never saw the prompt - and leaves the rest at the
 * old version. Leaving them there is already a working answer: a row at the old
 * version is a cache miss at the new one, so the next search of that job asks
 * the model about those candidates under the new rubric and writes the answer.
 * Nothing is lost and nothing is spent until somebody actually looks.
 *
 * This command is for the operator who would rather not wait for that: it does
 * the same work, for everybody, now, and says what it cost.
 *
 * ---
 *
 * IT USES THE PRODUCTION PATH ON PURPOSE
 *
 * The analysis is run through analyseBatch - the same function a live search
 * calls - rather than through a reimplementation. That is what guarantees the
 * rows it writes are indistinguishable from the rows a search would have
 * written: the same prompt, the same requirement ids, the same quote check, the
 * same prose gate, the same cost telemetry, the same cache key. A migration
 * that wrote its own slightly-different row would be a second implementation of
 * the most expensive thing in the product, kept in step by hope.
 *
 * It follows from that: analyseBatch reads the cache first, so a row already at
 * the new version is skipped without a call. Re-running this after a crash, or
 * after a partial tranche, costs nothing for the work already done.
 */
import './env.mjs'
import process from 'node:process'

/*
 * Flag values are validated rather than trusted.
 *
 * `--limit` with nothing after it made LIMIT NaN, and `done >= NaN` is false
 * for ever, so a typo silently became an unlimited run. `--job` with nothing
 * after it made ONLY_JOB NaN, which matched no rows and printed "nothing left
 * to re-score" - a typo reported as success on a command whose whole purpose is
 * to find work. Both now refuse.
 */
const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)

const refuse = (message) => {
  console.error('')
  console.error(`  ${message}`)
  console.error('')
  process.exit(1)
}

const num = (f) => {
  const at = argv.indexOf(`--${f}`)
  if (at < 0) return null

  const raw = argv[at + 1]
  if (raw === undefined || raw.startsWith('--')) refuse(`--${f} needs a number after it.`)

  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) refuse(`--${f} needs a number, not "${raw}".`)
  return value
}

const RUN = has('run')
const LIMIT = num('limit')
const ONLY_JOB = num('job')

const db = (await import('../src/db.js')).default
const { VERSIONS, MATCHING } = await import('../src/matching/config.js')
const {
  analyseBatch, withinDailyCeiling, analysisModel,
} = await import('../src/matching/analysis.js')
const { getJob, ensureJobMatchProfile } = await import('../src/matching/jobProfile.js')
const { candidatesWithTextByIds } = await import('../src/db.js')
const { effectiveProfile } = await import('../src/profiles.js')
const { profileVersion } = await import('../src/matching/intelligence.js')
const { isConfigured, MATCH_MODEL } = await import('../src/ai.js')
const { costOf } = await import('../src/costs.js')

const TARGET = String(VERSIONS.scoring)
const FROM = process.env.SCORE_MIGRATE_FROM ?? String(Number(TARGET) - 1)

/* The key analyseBatch will actually write under. Everything below asks about
   THIS, never about the key the old row happens to carry. */
const WRITE_MODEL = analysisModel(MATCH_MODEL)

/* ------------------------------------------------------------- the work --- */

/*
 * Rows the model wrote at the old version with no twin at the new one.
 *
 * Three narrowings, each of which was a defect before it was a clause:
 *
 * `source = 'claude'` is the selector proper: those are the rows whose verdicts
 * the new rubric revises. A keyword-scored row is score-migrate's business.
 *
 * `analysis_model = WRITE_MODEL` is there because analyseBatch writes under the
 * CURRENT model. Without it this command picked up public-demo rows, which are
 * judged on Sonnet and stored under the Sonnet key, re-judged them at full Opus
 * price, wrote the answer under the Opus key - which the demo never reads - and
 * then reported them as failures for ever, because the NOT EXISTS below was
 * looking for a Sonnet-keyed row that was never going to appear.
 *
 * And the profile_version check, in JS below, because the cache is read at the
 * candidate's CURRENT profile version: a row whose candidate has re-profiled
 * since is already unreachable, so re-judging it buys an answer nothing will
 * ever read. score-migrate skips those as stale; this used to buy them.
 */
const candidates = db.prepare(`
  SELECT a.candidate_id, a.job_id, a.jd_version, a.analysis_model, a.profile_version
  FROM candidate_job_analyses a
  WHERE a.scoring_version = ?
    AND a.source = 'claude'
    AND a.analysis_model = ?
    ${ONLY_JOB === null ? '' : 'AND a.job_id = ?'}
    AND NOT EXISTS (
      SELECT 1 FROM candidate_job_analyses b
      WHERE b.candidate_id = a.candidate_id AND b.job_id = a.job_id
        AND b.jd_version = a.jd_version AND b.profile_version = a.profile_version
        AND b.analysis_model = a.analysis_model AND b.scoring_version = ?
    )
  ORDER BY a.job_id, a.candidate_id
`).all(...(ONLY_JOB === null
  ? [FROM, WRITE_MODEL, TARGET]
  : [FROM, WRITE_MODEL, ONLY_JOB, TARGET]))

const stale = []
const pending = []
for (const row of candidates) {
  if (profileVersion(row.candidate_id) !== row.profile_version) stale.push(row)
  else pending.push(row)
}

const byJob = new Map()
for (const row of pending) {
  const key = `${row.job_id}:${row.jd_version}`
  if (!byJob.has(key)) byJob.set(key, { jobId: row.job_id, jdVersion: row.jd_version, rows: [] })
  byJob.get(key).rows.push(row)
}

/* Roughly what a judgement costs, from the same table the cost report reads.
   An estimate and said to be one: the real number is printed at the end. */
const PER_ANALYSIS = costOf({
  model: MATCH_MODEL, inputTokens: 9000, outputTokens: 1400,
  cacheWriteTokens: 0, cacheReadTokens: 0,
})

console.log('')
console.log(`Rubric re-score, version ${FROM} to ${TARGET}`)
console.log('')
console.log(`  Model                    : ${MATCH_MODEL}`)
console.log(`  Analyses still to redo   : ${pending.length}`)
console.log(`  Across jobs              : ${byJob.size}`)
console.log(`  Rough cost               : $${(PER_ANALYSIS * pending.length).toFixed(2)}`)
if (stale.length > 0) {
  console.log(`  Skipped, profile moved   : ${stale.length}   (unreachable by the cache either way)`)
}
if (LIMIT !== null) console.log(`  Limited this run to      : ${LIMIT}`)
console.log('')

if (pending.length === 0) {
  console.log('  Nothing left to re-score. Every model-written analysis is at the new version.')
  console.log('')
  process.exit(0)
}

if (!RUN) {
  console.log('  Dry run - nothing was called and nothing was written.')
  console.log('  npm run score:rubric -- --run')
  console.log('')
  console.log('  Leaving them alone is also a working answer: a row at the old version is a')
  console.log('  cache miss at the new one, so the next search of each job asks the model')
  console.log('  about those candidates anyway. This only brings the bill forward.')
  console.log('')
  process.exit(0)
}

if (!isConfigured()) {
  console.error('  No API key, so there is no model to ask. Nothing was written.')
  console.error('')
  process.exit(1)
}

/* ------------------------------------------------------------ the manifest --- */

/*
 * Recorded the same way score-migrate records its own writes, under the same
 * kind, so `score:migrate -- --revert` undoes this run as well without knowing
 * it was a different command. The tables are created by that script; this one
 * refuses to invent them, because a manifest that exists only when this runs is
 * a manifest the revert cannot find.
 *
 * The scope carries `rubric: true`, and that marker is load-bearing.
 * score-migrate's boot gate looks for a completed, un-reverted run with
 * from_version, to_version AND scope exactly '{"job":null,"triage":null}'. An
 * unscoped run of THIS command wrote a byte-identical row - so one use of it
 * before score-migrate had finished its own pass would have satisfied that gate
 * for ever, and the free carry-forward would simply never happen: every
 * keyword-scored row stranded at the old version, invisible to the new cache,
 * re-analysed and re-paid on every search, with nothing ever coming back for
 * them. --refresh marks its runs for exactly this reason; this one had not.
 */
const hasManifest = db.prepare(
  `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'score_migration_runs'`,
).pluck().get()

if (!hasManifest) {
  console.error('  No migration manifest. Run `npm run score:migrate -- --run` first: it')
  console.error('  creates the tables, carries forward everything that is free, and leaves')
  console.error('  exactly these rows behind.')
  console.error('')
  process.exit(1)
}

const now = () => new Date().toISOString()

const runId = db.prepare(`
  INSERT INTO score_migration_runs (stamp, from_version, to_version, silence, scope, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(
  `rubric re-score on ${MATCH_MODEL}`, FROM, TARGET, 0,
  JSON.stringify({ job: ONLY_JOB, triage: null, rubric: true }), now(),
).lastInsertRowid

const noteRow = db.prepare(
  `INSERT INTO score_migration_rows (run_id, kind, key_json, payload) VALUES (?, ?, ?, ?)`,
)

/*
 * Whether a row exists under the key analyseBatch WRITES: the current model and
 * the candidate's current profile version, not whatever the old row carried.
 * Asking the old row's key meant a successful write was reported as a failure,
 * left out of the manifest - so unrevertible, and unrefundable - and counted as
 * outstanding by a closing query that could then never reach zero.
 */
const existsAt = db.prepare(`
  SELECT 1 FROM candidate_job_analyses
  WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
    AND analysis_model = ? AND scoring_version = ?
`).pluck()

const writtenAlready = (row) => Boolean(existsAt.get(
  row.candidate_id, profileVersion(row.candidate_id), row.job_id, row.jd_version,
  WRITE_MODEL, TARGET,
))

/*
 * What this run cost, from its own telemetry.
 *
 * ai_cost_events stores tokens rather than dollars - the price of a model is
 * not a property of the call and would go stale in the row - so the money is
 * derived here the same way the cost report derives it. Scoped to this
 * command's own context string, which is also why it has one: it keeps the
 * migration's spend attributable rather than blended into the recruiters'.
 */
const spendSince = (mark) => db.prepare(`
  SELECT model, SUM(input_tokens) AS inputTokens, SUM(cache_write_tokens) AS cacheWriteTokens,
         SUM(cache_read_tokens) AS cacheReadTokens, SUM(output_tokens) AS outputTokens
  FROM ai_cost_events
  WHERE context = 'rubric-migration' AND id > ?
  GROUP BY model
`).all(mark).reduce((sum, row) => sum + costOf(row), 0)

const costMark = db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM ai_cost_events`).pluck().get()

/* --------------------------------------------------------------- the run --- */

let done = 0
let written = 0
let skipped = 0
let failed = 0
let ceilingHits = 0

/* The same size a live search analyses in one go. A whole job group used to be
   handed to analyseBatch and to the ceiling check in one piece, so a job with
   more pending rows than the daily cap failed the check on every run however
   empty the window was - and the response was `break`, which abandoned every
   job after it too. A blocked chunk now moves to the next group. */
const CHUNK = Math.max(1, MATCHING.deepAnalysisBatch)

for (const group of byJob.values()) {
  if (LIMIT !== null && done >= LIMIT) break

  const job = getJob(group.jobId)
  if (!job) {
    console.log(`  job ${group.jobId}: gone, so its analyses are unreachable. Skipped.`)
    skipped += group.rows.length
    continue
  }

  const matchProfile = await ensureJobMatchProfile(job)
  let analysedHere = 0

  for (let at = 0; at < group.rows.length; at += CHUNK) {
    if (LIMIT !== null && done >= LIMIT) break

    let take = group.rows.slice(at, at + CHUNK)
    if (LIMIT !== null) take = take.slice(0, LIMIT - done)
    if (take.length === 0) break

    /*
     * The ceiling is asked BEFORE the call, and a refusal skips rather than
     * falling through. Falling through is what analyseBatch does for a live
     * search, and it is right there: a recruiter gets keyword scores and is
     * told. Here it would write a keyword score into the cache under the
     * model's name, which is the exact defect unpoison exists to clean up.
     *
     * companyId is omitted rather than passed as null. itemsInWindow turns an
     * explicit null into `company_id IS NULL`, and the spend this is meant to
     * count is booked by analyseBatch under the job's real company id - so the
     * guard was counting a bucket nothing ever writes to, read zero every time,
     * and could not fire.
     */
    if (!withinDailyCeiling({ context: 'rubric-migration', wanted: take.length })) {
      ceilingHits += 1
      console.log(`  job ${group.jobId}: daily analysis ceiling reached, ${take.length} left here`)
      break
    }

    /* Which of these already had a row at the written key BEFORE the call.
       Authorship cannot be inferred from existence afterwards: a live search
       running alongside this writes real v4 rows of its own, and recording
       those as this run's would have `--revert` delete a judgement somebody
       paid for, under a message promising only this run's writes were touched. */
    const before = new Set(take.filter(writtenAlready).map((row) => row.candidate_id))

    const people = candidatesWithTextByIds(take.map((row) => row.candidate_id))
    const rows = take
      .map((row) => {
        const candidate = people.get(row.candidate_id)
        if (!candidate) return null
        return { candidate, cvText: candidate.cv_text, profile: effectiveProfile(row.candidate_id) }
      })
      .filter(Boolean)

    if (rows.length === 0) {
      skipped += take.length
      continue
    }

    try {
      const out = await analyseBatch({
        job, matchProfile, rows, context: 'rubric-migration', companyId: job.company_id ?? null,
      })
      analysedHere += out.analysed

      for (const row of take) {
        if (before.has(row.candidate_id)) { skipped += 1; continue }

        if (writtenAlready(row)) {
          written += 1
          noteRow.run(runId, 'analysis_insert', JSON.stringify({
            candidate_id: row.candidate_id,
            profile_version: profileVersion(row.candidate_id),
            job_id: row.job_id,
            jd_version: row.jd_version,
            analysis_model: WRITE_MODEL,
          }), null)
        } else {
          failed += 1
        }
      }

      done += take.length
    } catch (error) {
      failed += take.length
      console.log(`  job ${group.jobId}: ${error.message}`)
    }
  }

  if (analysedHere > 0) console.log(`  job ${group.jobId}: ${analysedHere} analysed`)
}

db.prepare(`UPDATE score_migration_runs SET completed_at = ? WHERE id = ?`).run(now(), runId)

const left = pending.filter((row) => !writtenAlready(row)).length

console.log('')
console.log('DONE')
console.log(`  written at version ${TARGET}   : ${written}`)
console.log(`  already there, skipped  : ${skipped}`)
console.log(`  not written             : ${failed}`)
console.log(`  still at version ${FROM}      : ${left}`)
if (ceilingHits > 0) {
  console.log(`  stopped by the ceiling  : ${ceilingHits} chunk(s); re-run and it picks up here`)
}
console.log(`  ACTUAL COST             : $${spendSince(costMark).toFixed(4)}`)
console.log(`  manifest run id         : ${runId}   (npm run score:migrate -- --revert)`)
console.log('')
