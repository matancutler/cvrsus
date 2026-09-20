#!/usr/bin/env node
/**
 * C6 — how much of a job's final top 20 comes from below a given depth.
 *
 *   npm run recall:test                        the plan and the cost, spends nothing
 *   npm run recall:test -- --yes               run it
 *   npm run recall:test -- --band 200 --yes    how deep to look
 *   npm run recall:test -- --model claude-sonnet-5 --effort medium --yes
 *   npm run recall:test -- --from-db 5 --yes   use real jobs from the database
 *
 * ---
 *
 * THE QUESTION, AND WHY IT IS NOT THE SAME AS THE OTHER EVAL
 *
 * ai-eval measures judgement: given a candidate and a job, do two models
 * agree about the person. This measures retrieval: of the people a job should
 * have surfaced, how many did the pool reach at all.
 *
 * Deep analysis is capped, today at 100 per job. Anybody ranked below that cap
 * by retrieval is never read by a model, so they cannot appear in the results
 * however well they fit — and nothing on screen says so. The cap is
 * defensible only if the people it excludes would not have made the top of
 * the list anyway. That is a measurement, and this is it.
 *
 * Method: take the job's real retrieval ranking over the real pool, deeply
 * analyse the top `band` of it, sort those by the fit they actually earned,
 * and take the final top 20. Then, for each candidate depth, count how many
 * of that top 20 were ranked below it by retrieval. Those are the people that
 * depth would have lost.
 *
 * C3's rule: the right depth is the smallest one where fewer than 1 in 20 of
 * each job's final top 20 came from below it.
 *
 * THE BAND IS THE MEASUREMENT'S OWN CEILING. Somebody ranked below `band` is
 * invisible to this test too, so it can never prove a depth is safe — only
 * that it is unsafe. A clean result at band 200 means "nothing in the top 200
 * argues for going deeper", not "nothing below 200 matters". The report says
 * so, because reading it the other way is how a cap gets justified by the
 * evidence it excluded.
 *
 * The judging model is a parameter and Sonnet is a reasonable choice here:
 * the question is which candidates the pool REACHED, and a cheaper judge
 * changes the fine ordering of the top 20 far more than it changes which
 * twenty people are in it. It is still a caveat, and the report prints which
 * model produced the ranking.
 *
 * Writes analyses to the cache like any search, so a second run is nearly
 * free and the rows are the same rows production would have written.
 */
import './env.mjs'
import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}
const number = (name, fallback) => {
  const raw = flag(name, null)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`--${name} needs a whole number above zero\n`)
    process.exit(1)
  }
  return value
}

const BAND = number('band', 200)
const TOP = number('top', 20)
const MODEL = flag('model', 'claude-sonnet-5')
const EFFORT = flag('effort', 'medium')
const DEPTHS = String(flag('depths', '25,50,75,100,150,200'))
  .split(',').map((d) => Number(d.trim())).filter((d) => Number.isInteger(d) && d > 0)
  .filter((d) => d <= BAND)

const here = path.dirname(fileURLToPath(import.meta.url))
const JOBS_DIR = flag('jobs', path.join(here, '..', '..', 'eval-material', 'jobs'))

/*
 * Where the job descriptions come from, and on the server it is the database.
 *
 * eval-material is gitignored, so the .txt files on a laptop are not on
 * Render — and this test is only meaningful against a real candidate pool,
 * which is on Render. Reading the jobs table solves both halves at once and
 * is the better measurement anyway: these are postings recruiters actually
 * searched with, against the pool they actually searched, and their match
 * profiles and analyses are already cached, so the run costs only the band
 * beyond what has already been read.
 *
 * The file mode stays for a laptop with a seeded pool, and for trying a
 * posting nobody has run yet.
 */
const FROM_DB = number('from-db', null)

const fileJobs = () => (fs.existsSync(JOBS_DIR)
  ? fs.readdirSync(JOBS_DIR).filter((n) => n.endsWith('.txt'))
    .map((n) => ({ name: n.replace(/\.txt$/, ''), text: fs.readFileSync(path.join(JOBS_DIR, n), 'utf8') }))
  : [])

const dbModule = await import('../src/db.js')
const db = dbModule.default
const { listCandidatesWithText } = dbModule
const { isConfigured } = await import('../src/ai.js')
const {
  findOrCreateJob, getJob, jobConceptIds, ensureJobMatchProfile,
} = await import('../src/matching/jobProfile.js')
const { hardFilter, rankAndPool } = await import('../src/matching/retrieval.js')
const { analyseBatch } = await import('../src/matching/analysis.js')
const { activityStatus } = await import('../src/profiles.js')

/*
 * Real jobs, newest first, and only those a model has already profiled: a
 * job with no match profile has never been searched, so it has no retrieval
 * ranking to measure and asking for one would parse a JD nobody ran.
 */
const dbJobs = FROM_DB === null ? [] : db.prepare(`
  SELECT j.id, j.title, j.raw_jd
  FROM jobs j
  JOIN job_match_profiles p ON p.job_id = j.id AND p.jd_version = j.jd_version
  ORDER BY j.updated_at DESC
  LIMIT ?
`).all(FROM_DB).map((row) => ({
  name: `#${row.id} ${String(row.title ?? '').slice(0, 40) || '(untitled)'}`,
  text: row.raw_jd,
  jobId: row.id,
}))

const jobs = FROM_DB === null ? fileJobs() : dbJobs

if (jobs.length === 0) {
  console.error(FROM_DB === null
    ? `\nNo job descriptions in ${JOBS_DIR}. Put real postings there as .txt,`
      + ' or use --from-db to read the ones recruiters have run.\n'
    : '\nNo jobs in the database have a match profile yet, so none has ever been'
      + ' searched and none has a retrieval ranking to measure.\n')
  process.exit(1)
}

const pool = listCandidatesWithText()

console.log('')
console.log('C6 recall test - what a depth cap would lose')
console.log(`Jobs                 : ${jobs.length} (${FROM_DB === null ? 'from ' + JOBS_DIR : 'real, from the database'})`)
console.log(`Candidates with text : ${pool.length}`)
console.log(`Band (analysed/job)  : ${Math.min(BAND, pool.length)}`)
console.log(`Final list measured  : top ${TOP}`)
console.log(`Judging model        : ${MODEL} at effort ${EFFORT}`)
console.log(`Depths tested        : ${DEPTHS.join(', ')}`)

const perAnalysis = 0.02
const estimate = jobs.length * Math.min(BAND, pool.length) * perAnalysis
console.log(`Rough cost           : $${estimate.toFixed(2)} before caching, less in practice`)
console.log('')

if (pool.length < BAND) {
  console.log(`NOTE: the pool is smaller than the band, so every candidate is analysed for`)
  console.log(`every job and no depth above ${pool.length} can be distinguished from any other.`)
  console.log('')
}

if (pool.length < TOP * 3) {
  console.log('WARNING: with a pool this small a "top 20" is most of it, and the answer')
  console.log('this produces is about arithmetic rather than about retrieval.')
  console.log('')
}

if (!has('yes')) {
  console.log('This spends real money. Re-run with --yes when you mean it.\n')
  process.exit(0)
}

if (!isConfigured()) {
  console.error('No ANTHROPIC_API_KEY (or AI_PAUSED is set). Nothing to run.\n')
  process.exit(1)
}

/* A recruiter id that owns the throwaway jobs this creates. Negative so it
   cannot collide with a real recruiter and cannot move an AUTOINCREMENT
   sequence — see the note in score-migration-check. */
const EVAL_RECRUITER = -424242

const rows = []

for (const spec of jobs) {
  /* A real job is used as it stands — same id, same jd_version, so the
     analyses this writes are the analyses production would read back, and
     nothing new is created in the jobs table. */
  const job = spec.jobId ? getJob(spec.jobId) : findOrCreateJob({
    recruiterId: EVAL_RECRUITER,
    companyId: null,
    chatId: null,
    title: `recall-test ${spec.name}`,
    rawJd: spec.text,
    instruction: null,
  }).job

  const matchProfile = await ensureJobMatchProfile(job)
  const jobConcepts = jobConceptIds(matchProfile)

  const { eligible } = hardFilter({
    candidates: pool,
    matchProfile,
    jobConcepts,
    activityFor: activityStatus,
    blocked: new Set(),
  })

  const { ranked } = rankAndPool({ eligible, matchProfile, jobConcepts, poolSize: BAND })
  const band = ranked.slice(0, BAND)

  /* Retrieval rank, one-based, captured before anything is judged: this is
     the number the whole test is about. */
  const rankOf = new Map(band.map((row, index) => [row.candidate.id, index + 1]))

  const { results, analysed, reused } = await analyseBatch({
    job, matchProfile, rows: band, context: 'eval', model: MODEL,
  })

  const judged = band
    .map((row) => ({
      id: row.candidate.id,
      retrievalRank: rankOf.get(row.candidate.id),
      fit: results.get(row.candidate.id)?.absoluteFit ?? null,
    }))
    .filter((row) => Number.isFinite(row.fit))
    .sort((a, b) => b.fit - a.fit || a.id - b.id)

  const top = judged.slice(0, TOP)

  rows.push({ job: spec.name, analysed, reused, judged: judged.length, top })
  console.log(`  ${spec.name}: ${band.length} in band, ${analysed} analysed, ${reused} from cache`)
}

console.log('')
console.log(`LEAKAGE - of each job's final top ${TOP}, how many retrieval ranked below the depth`)
console.log('')
console.log('job'.padEnd(46) + DEPTHS.map((d) => String(d).padStart(7)).join(''))
console.log('-'.repeat(46 + DEPTHS.length * 7))

const worst = new Map(DEPTHS.map((d) => [d, 0]))

for (const row of rows) {
  const cells = DEPTHS.map((depth) => {
    const lost = row.top.filter((c) => c.retrievalRank > depth).length
    const share = row.top.length ? lost / row.top.length : 0
    worst.set(depth, Math.max(worst.get(depth), share))
    return `${lost}/${row.top.length}`.padStart(7)
  })
  console.log(row.job.slice(0, 44).padEnd(46) + cells.join(''))
}

console.log('-'.repeat(46 + DEPTHS.length * 7))
console.log('worst job'.padEnd(46)
  + DEPTHS.map((d) => `${Math.round(worst.get(d) * 100)}%`.padStart(7)).join(''))
console.log('')

/* C3's rule, applied rather than described: the smallest depth at which no
   single job loses 1 in 20 of its own top list. Per job, not averaged — an
   average hides the one job the cap fails. */
const THRESHOLD = 1 / TOP
const safe = DEPTHS.filter((d) => worst.get(d) < THRESHOLD)
const recommended = safe.length ? Math.min(...safe) : null

console.log('C3 RULE: the smallest depth where no job loses 1 in 20 of its own top list.')
if (recommended === null) {
  console.log(`  No depth up to ${BAND} satisfies it. The worst job still loses`)
  console.log(`  ${Math.round(worst.get(Math.max(...DEPTHS)) * 100)}% at the deepest depth tested, which`)
  console.log('  argues for a larger band before it argues for a larger default.')
} else {
  console.log(`  ${recommended}`)
}
console.log('')
console.log(`Measured with ${MODEL} at effort ${EFFORT}, band ${BAND}, over ${pool.length} candidates.`)
console.log(`Anybody retrieval ranked below ${BAND} is invisible to this test as well, so this`)
console.log('can show a depth is too shallow and can never show one is deep enough.')
console.log('')

/* The throwaway jobs, removed. They were created only to get a real match
   profile and a real retrieval ranking; leaving them would put five
   recruiter-less jobs in the product's own tables. The analyses stay:
   they are cached work against a real job description and a second run
   should not pay for them again. */
if (!has('keep')) {
  /* Scoped to the throwaway recruiter, so a --from-db run, which creates no
     jobs at all, can never delete the real ones it just measured. */
  const removed = db.prepare(`DELETE FROM jobs WHERE recruiter_id = ?`).run(EVAL_RECRUITER).changes
  if (removed > 0) {
    console.log(`Removed ${removed} throwaway job row(s). --keep leaves them for inspection.`)
    console.log('')
  }
}
