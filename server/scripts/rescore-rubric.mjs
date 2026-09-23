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

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const num = (f) => {
  const at = argv.indexOf(`--${f}`)
  return at > -1 ? Number(argv[at + 1]) : null
}

const RUN = has('run')
const LIMIT = num('limit')
const ONLY_JOB = num('job')

const db = (await import('../src/db.js')).default
const { VERSIONS } = await import('../src/matching/config.js')
const { analyseBatch, withinDailyCeiling } = await import('../src/matching/analysis.js')
const { getJob, ensureJobMatchProfile } = await import('../src/matching/jobProfile.js')
const { candidatesWithTextByIds } = await import('../src/db.js')
const { effectiveProfile } = await import('../src/profiles.js')
const { isConfigured, MATCH_MODEL } = await import('../src/ai.js')
const { costOf } = await import('../src/costs.js')

const TARGET = String(VERSIONS.scoring)
const FROM = process.env.SCORE_MIGRATE_FROM ?? String(Number(TARGET) - 1)

/* ------------------------------------------------------------- the work --- */

/*
 * Rows the model wrote at the old version with no twin at the new one.
 *
 * `source = 'claude'` is the whole selector: those are the rows whose verdicts
 * the new rubric revises. A keyword-scored row is score-migrate's business and
 * has already been carried forward by the time anybody runs this.
 *
 * The NOT EXISTS is what makes a second run free rather than a second bill.
 */
const pending = db.prepare(`
  SELECT a.candidate_id, a.job_id, a.jd_version, a.analysis_model, a.profile_version
  FROM candidate_job_analyses a
  WHERE a.scoring_version = ?
    AND a.source = 'claude'
    ${ONLY_JOB === null ? '' : 'AND a.job_id = ?'}
    AND NOT EXISTS (
      SELECT 1 FROM candidate_job_analyses b
      WHERE b.candidate_id = a.candidate_id AND b.job_id = a.job_id
        AND b.jd_version = a.jd_version AND b.profile_version = a.profile_version
        AND b.analysis_model = a.analysis_model AND b.scoring_version = ?
    )
  ORDER BY a.job_id, a.candidate_id
`).all(...(ONLY_JOB === null ? [FROM, TARGET] : [FROM, ONLY_JOB, TARGET]))

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
  JSON.stringify({ job: ONLY_JOB, triage: null }), now(),
).lastInsertRowid

const noteRow = db.prepare(
  `INSERT INTO score_migration_rows (run_id, kind, key_json, payload) VALUES (?, ?, ?, ?)`,
)

const existsAt = db.prepare(`
  SELECT 1 FROM candidate_job_analyses
  WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
    AND analysis_model = ? AND scoring_version = ?
`).pluck()

/* --------------------------------------------------------------- the run --- */

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

let done = 0
let written = 0
let skipped = 0
let failed = 0

for (const group of byJob.values()) {
  if (LIMIT !== null && done >= LIMIT) break

  const job = getJob(group.jobId)
  if (!job) {
    console.log(`  job ${group.jobId}: gone, so its analyses are unreachable. Skipped.`)
    skipped += group.rows.length
    continue
  }

  let take = group.rows
  if (LIMIT !== null) take = take.slice(0, LIMIT - done)

  /*
   * The ceiling is asked BEFORE the call, and a refusal stops the run rather
   * than falling through. Falling through is what analyseBatch does for a live
   * search, and it is right there: a recruiter gets keyword scores and is told.
   * Here it would write a keyword score into the cache under the model's name,
   * which is the exact defect the unpoison command exists to clean up after.
   */
  if (!withinDailyCeiling({ context: 'rubric-migration', companyId: null, wanted: take.length })) {
    console.log('  Daily analysis ceiling reached. Stopping here; re-run tomorrow and this')
    console.log('  picks up exactly where it left off.')
    break
  }

  const people = candidatesWithTextByIds(take.map((row) => row.candidate_id))
  const rows = take
    .map((row) => {
      const candidate = people.get(row.candidate_id)
      if (!candidate) return null
      return {
        candidate: { ...candidate, cv_text: candidate.cv_text },
        cvText: candidate.cv_text,
        profile: effectiveProfile(row.candidate_id),
      }
    })
    .filter(Boolean)

  if (rows.length === 0) {
    skipped += take.length
    continue
  }

  const matchProfile = await ensureJobMatchProfile(job)

  try {
    const out = await analyseBatch({
      job, matchProfile, rows, context: 'rubric-migration', companyId: job.company_id ?? null,
    })

    /* What actually landed, asked of the database rather than inferred from the
       return: a candidate the model refused is not in the cache and must not be
       recorded as this run's to undo. */
    for (const row of take) {
      if (existsAt.get(
        row.candidate_id, row.profile_version, row.job_id, row.jd_version,
        row.analysis_model, TARGET,
      )) {
        written += 1
        noteRow.run(runId, 'analysis_insert', JSON.stringify({
          candidate_id: row.candidate_id,
          profile_version: row.profile_version,
          job_id: row.job_id,
          jd_version: row.jd_version,
          analysis_model: row.analysis_model,
        }), null)
      } else {
        failed += 1
      }
    }

    done += take.length
    console.log(`  job ${group.jobId}: ${out.analysed} analysed, ${out.reused} already cached`)
  } catch (error) {
    failed += take.length
    console.log(`  job ${group.jobId}: ${error.message}`)
  }
}

db.prepare(`UPDATE score_migration_runs SET completed_at = ? WHERE id = ?`).run(now(), runId)

const left = db.prepare(`
  SELECT COUNT(*) AS n FROM candidate_job_analyses a
  WHERE a.scoring_version = ? AND a.source = 'claude'
    AND NOT EXISTS (
      SELECT 1 FROM candidate_job_analyses b
      WHERE b.candidate_id = a.candidate_id AND b.job_id = a.job_id
        AND b.jd_version = a.jd_version AND b.profile_version = a.profile_version
        AND b.analysis_model = a.analysis_model AND b.scoring_version = ?
    )
`).pluck().get(FROM, TARGET)

console.log('')
console.log('DONE')
console.log(`  written at version ${TARGET}   : ${written}`)
console.log(`  unreachable, skipped    : ${skipped}`)
console.log(`  not written             : ${failed}`)
console.log(`  still at version ${FROM}      : ${left}`)
console.log(`  ACTUAL COST             : $${spendSince(costMark).toFixed(4)}`)
console.log(`  manifest run id         : ${runId}   (npm run score:migrate -- --revert)`)
console.log('')
