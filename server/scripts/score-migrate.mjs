#!/usr/bin/env node
/**
 * Rescores every stored analysis under the new arithmetic, without calling a
 * model once.
 *
 *   npm run score:migrate                      what it would do, and nothing else
 *   npm run score:migrate -- --run             do it
 *   npm run score:migrate -- --job 42 --run    one job first, to look at
 *   npm run score:migrate -- --revert --run    put it back
 *   npm run score:migrate -- --force --run     run it again once it has run
 *   npm run score:migrate -- --refresh --run   re-apply a changed silence fraction
 *
 * The server also starts it in the background on boot (index.js), and it does
 * nothing on all but the first — see the gate below.
 *
 * ---
 *
 * WHY THIS EXISTS RATHER THAN A VERSION BUMP
 *
 * scoring_version is part of the primary key of candidate_job_analyses and
 * part of every WHERE clause that reads it. Bumping it to 3 would therefore
 * not "invalidate old scores" — it would make every stored analysis
 * invisible, and the next search would pay a model to work out what is
 * already on disk. That is the re-analysis wave, and it is the single most
 * expensive thing this change could accidentally do.
 *
 * It is avoidable because the verdicts were always stored. criteria_results
 * holds `verdicts`: one entry per requirement carrying its tier, its weight,
 * the model's status and the quote it read that status out of. Fit is a
 * function of exactly those. So the new number is arithmetic over data we
 * already have, and this script is that arithmetic.
 *
 * ---
 *
 * WHAT IT DOES, AND HOW IT COMES BACK
 *
 * Search — ADDITIVE, and never destructive. Every version-2 row gets a
 * version-3 row written beside it; the version-2 row is untouched. The insert
 * is ON CONFLICT DO NOTHING, so a version-3 row that already exists — written
 * by an ordinary search a second ago, or by an earlier pass of this same
 * migration — is left exactly as it is. This script fills gaps. It never
 * overwrites a judgement a model actually made.
 *
 * Triage — IN PLACE, because scoring_version there is a column rather than
 * part of a key, so there is no second row to write.
 *
 * Every run is RECORDED, row by row. score_migration_runs holds the run;
 * score_migration_rows holds the primary key of every row actually inserted
 * and the previous contents of every row overwritten. --revert undoes exactly
 * those and nothing else.
 *
 * There is no backup table, and that is deliberate. An earlier version copied
 * both tables whole before every write, which was three separate mistakes: it
 * ran on every invocation, so a restart loop filled the disk; the copies sat
 * outside deleteCandidateCompletely and outside the Triage retention sweep,
 * so a candidate who erased their account left the full text of their CV
 * behind in a table nothing would ever clean; and it was redundant, because
 * the manifest already holds the previous value of every row this touches and
 * the Search half overwrites nothing at all.
 *
 * ---
 *
 * WHAT CHANGES A NUMBER
 *
 * Silence is priced: no_evidence earns MATCH_SILENCE_FRACTION of its weight
 * instead of being struck from both halves of the fraction. That is the whole
 * change. A fully-evidenced analysis does not move.
 *
 * There is NO quote check here, on either half, and that is a refusal rather
 * than an omission. A stored quote can only honestly be checked against the
 * exact string the model was shown, and this script cannot reconstruct that
 * string for either table. dossier() strips the candidate's name, email and
 * phone before the model ever sees the text — and the phone pattern takes
 * date ranges with it, so "2016 - 2022" arrives as "[redacted]", in Triage
 * every bit as much as in Search. Checking against the raw text would
 * therefore downgrade correct verdicts wholesale, hardest on the rows with
 * the most evidence in them. Quotes are checked once, at analysis time, in
 * ai.js, where the string still exists — and even there the result only
 * flags a verdict, it does not move one.
 *
 * The location nudge survives exactly. It was added after the fit was
 * computed and never stored on its own, so it is recovered by subtraction:
 * the old fit recomputed from the same verdicts, subtracted from what is
 * stored. Exact except where the stored value hit the 0-100 clamp; those are
 * counted and reported.
 *
 * Rows with no verdicts are carried forward unchanged — they were scored
 * deterministically and the new arithmetic has nothing to say about them.
 */
import './env.mjs'
import process from 'node:process'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)

/*
 * A flag given a value that is not a number is an error, not a scope.
 *
 * `--job --run` took "--run" as the value, produced NaN, bound it as NULL,
 * matched no rows and reported "nothing to migrate" — a confident lie about
 * a typo, on the one command whose entire purpose is caution.
 */
function numberFlag(name) {
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return null
  const raw = argv[at + 1]
  const value = Number(raw)
  if (raw === undefined || raw.startsWith('--') || !Number.isInteger(value)) {
    console.error(`--${name} needs a whole number, got ${raw === undefined ? '(nothing)' : raw}\n`)
    process.exit(1)
  }
  return value
}

const RUN = has('run')
const REVERT = has('revert')
const FORCE = has('force')
const REFRESH = has('refresh')
const ONLY_JOB = numberFlag('job')
const ONLY_TRIAGE = numberFlag('triage')
const SCOPED = ONLY_JOB !== null || ONLY_TRIAGE !== null

/* Which half each scope flag allows. Naming neither runs both; naming both
   runs both, which is what the help text has always implied and what the
   gate used to disagree with the loops about. */
const DO_SEARCH = ONLY_TRIAGE === null || ONLY_JOB !== null
const DO_TRIAGE = ONLY_JOB === null || ONLY_TRIAGE !== null

const db = (await import('../src/db.js')).default
const {
  rescoreBreakdown, silenceFraction, needsReview, deriveHighlights,
} = await import('../src/matching/score.js')
const { VERSIONS } = await import('../src/matching/config.js')
const { profileVersion } = await import('../src/matching/intelligence.js')

/* The version rows are migrated FROM. Only 2 — version 1 is the era of the
   model-invented 0-100 that the version-2 bump existed to retire, and
   sweeping those into 3 would resurrect them into the same ranking. */
const FROM = '2'
const TARGET = String(VERSIONS.scoring)

const pad = (v, w) => String(v ?? '').padEnd(w)
const padL = (v, w) => String(v ?? '').padStart(w)
const now = () => new Date().toISOString()

/* Shared by the forward pass and by --refresh, so declared before both. */
const PAGE = 500
const KEY_SQL = `(a.candidate_id || ':' || a.job_id || ':' || a.jd_version || ':' `
  + `|| a.profile_version || ':' || a.analysis_model)`

db.exec(`
  CREATE TABLE IF NOT EXISTS score_migration_runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    stamp      TEXT NOT NULL,
    from_version TEXT NOT NULL,
    to_version   TEXT NOT NULL,
    silence    REAL NOT NULL,
    scope      TEXT,
    reverted_at TEXT,
    created_at TEXT NOT NULL
  );

  /* One row per row this migration touched. payload is what was there
     before, for the in-place half; the insert half needs only the key. */
  CREATE TABLE IF NOT EXISTS score_migration_rows (
    run_id     INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    key_json   TEXT NOT NULL,
    payload    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_migration_rows ON score_migration_rows(run_id);
`)

/*
 * completed_at, added after the fact, and the gate depends on it.
 *
 * The run row used to be written before any work and never updated, so a
 * migration killed after its first page left a record saying it had run. The
 * next boot saw that record, said "nothing to do", and the remaining rows sat
 * at version 2 permanently — every one of them a cache miss and a paid model
 * call, which is the exact outcome this script exists to prevent, reached
 * silently.
 */
if (!db.prepare(`SELECT 1 FROM pragma_table_info('score_migration_runs') WHERE name = 'completed_at'`).get()) {
  db.exec(`ALTER TABLE score_migration_runs ADD COLUMN completed_at TEXT`)
  /* Anything already recorded ran to completion under the old code or did
     not; assuming it did is the same assumption the old gate made, so this
     changes nothing for an existing database and makes the column honest
     from here on. */
  db.exec(`UPDATE score_migration_runs SET completed_at = created_at WHERE completed_at IS NULL`)
}

console.log('')
console.log('Cursus — rescoring stored analyses under the new arithmetic')
console.log(`From version           : ${FROM}`)
console.log(`Target version         : ${TARGET}`)
console.log(`Silence fraction       : ${silenceFraction()}`)
console.log(`Mode                   : ${REVERT ? 'REVERT' : RUN ? 'WRITE' : 'dry run (nothing is written)'}`)
console.log(`Scope                  : ${
  [ONLY_JOB !== null ? `job ${ONLY_JOB}` : null, ONLY_TRIAGE !== null ? `triage ${ONLY_TRIAGE}` : null]
    .filter(Boolean).join(', ') || 'every row'}`)
console.log('')

if (!REVERT && TARGET === FROM) {
  /*
   * Not an error. An operator who reverted and then set MATCH_V_SCORING back
   * to 2, exactly as the revert told them to, is in a correct and deliberate
   * state — and exiting nonzero here made the server print a six-line
   * MIGRATION FAILED banner on every boot from then on, telling them to run
   * a migration they had just chosen to undo.
   */
  console.log(`Target version is ${TARGET}, which is what rows are migrated FROM.`)
  console.log('MATCH_V_SCORING is set to the old value, so there is nothing to migrate.')
  console.log('SCORE_MIGRATE_IDLE\n')
  process.exit(0)
}

/* ------------------------------------------------------------- revert --- */

if (REVERT) {
  const run = db.prepare(`
    SELECT * FROM score_migration_runs WHERE reverted_at IS NULL ORDER BY id DESC LIMIT 1
  `).get()

  if (!run) {
    console.error('No un-reverted migration recorded. Nothing to undo.\n')
    process.exit(1)
  }

  const rows = db.prepare(`SELECT * FROM score_migration_rows WHERE run_id = ?`).all(run.id)
  const inserted = rows.filter((r) => r.kind === 'analysis_insert')
  const rewritten = rows.filter((r) => r.kind === 'analysis_update')
  const updated = rows.filter((r) => r.kind === 'applicant_update')

  console.log(`Undoing run ${run.id} of ${run.created_at} (${run.from_version} -> ${run.to_version})`)
  console.log(`  ${inserted.length} analysis row(s) to remove`)
  console.log(`  ${rewritten.length} analysis row(s) to put back`)
  console.log(`  ${updated.length} Triage applicant(s) to put back`)
  console.log('')

  if (!RUN) {
    console.log('Dry run. Add --run alongside --revert to actually restore.\n')
    process.exit(0)
  }

  db.transaction(() => {
    const drop = db.prepare(`
      DELETE FROM candidate_job_analyses
      WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
        AND analysis_model = ? AND scoring_version = ?
    `)
    /* Only rows this run actually inserted are recorded, so this can only
       remove rows that would not exist but for the migration. */
    for (const row of inserted) {
      const k = JSON.parse(row.key_json)
      drop.run(k.candidate_id, k.profile_version, k.job_id, k.jd_version, k.analysis_model, run.to_version)
    }

    /* A refresh rewrites rows in place rather than inserting them, so its
       manifest carries the previous contents and the undo is a restore. */
    const restore = db.prepare(`
      UPDATE candidate_job_analyses SET absolute_fit = ?, criteria_results = ?
      WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
        AND analysis_model = ? AND scoring_version = ?
    `)
    for (const row of rewritten) {
      const k = JSON.parse(row.key_json)
      const was = JSON.parse(row.payload)
      restore.run(
        was.absolute_fit, was.criteria_results,
        k.candidate_id, k.profile_version, k.job_id, k.jd_version, k.analysis_model, run.to_version,
      )
    }

    const put = db.prepare(`
      UPDATE triage_applicants SET absolute_fit = ?, criteria = ?, scoring_version = ? WHERE id = ?
    `)
    for (const row of updated) {
      const before = JSON.parse(row.payload)
      put.run(before.absolute_fit, before.criteria, before.scoring_version, JSON.parse(row.key_json).id)
    }

    db.prepare(`UPDATE score_migration_runs SET reverted_at = ? WHERE id = ?`).run(now(), run.id)
  })()

  console.log(`Removed ${inserted.length} row(s), put back ${rewritten.length} analysis row(s) `
    + `and ${updated.length} applicant(s).`)
  console.log('Only what that run wrote was touched; anything written since is untouched.')
  console.log('')
  console.log('IF YOU WANT THIS TO STICK, set SCORE_MIGRATE_ON_BOOT=off as well.')
  console.log(`Otherwise the next restart migrates again. Setting MATCH_V_SCORING=${FROM}`)
  console.log('also stops it, and makes the server read the old scores.')
  console.log('')
  process.exit(0)
}

/* ------------------------------------------------------------ refresh --- */

/*
 * Re-apply the CURRENT silence fraction to rows that are already on the
 * current scoring version.
 *
 * Without this the tuning dial is half a dial. MATCH_SILENCE_FRACTION is
 * read at module load and applies to analyses written after the change, so
 * turning it moves nothing a recruiter is looking at: the folder they open
 * is full of rows scored at the old fraction, the search they re-run serves
 * them from cache, and the only way to see the new value is to find a
 * candidate nobody has ever scored against that job. Somebody tuning by
 * feel would conclude the setting does not work.
 *
 * This is arithmetic, not a migration, and it makes no model call either.
 * Fit is rescored from the stored verdicts at whatever fraction is set now,
 * and the stored locationNudge is added back.
 *
 * It requires that nudge to be stored, which is why it is written down at
 * analysis time. A row without it is skipped and counted rather than
 * guessed at: the nudge used to be recoverable by subtracting the OLD
 * arithmetic from the stored total, and that works exactly once — on a row
 * already rescored, the same subtraction returns the gap between two
 * different arithmetics, which is not a nudge and would be added to the
 * score as though it were.
 *
 * In place, and recorded, so --revert puts it back.
 */
if (REFRESH) {
  if (!RUN) console.log('Dry run — add --run to write.\n')

  const refreshRun = RUN ? db.prepare(`
    INSERT INTO score_migration_runs (stamp, from_version, to_version, silence, scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
    TARGET, TARGET, silenceFraction(),
    JSON.stringify({ job: ONLY_JOB, triage: ONLY_TRIAGE, refresh: true }),
    now(),
  ).lastInsertRowid : null

  const note = RUN
    ? db.prepare(`INSERT INTO score_migration_rows (run_id, kind, key_json, payload) VALUES (?, ?, ?, ?)`)
    : null

  const stats = { seen: 0, moved: [], noNudge: 0, noVerdicts: 0 }

  const rescoreStored = (blob, storedFit) => {
    let criteria = null
    try {
      criteria = JSON.parse(blob)
    } catch {
      return null
    }
    if (!Array.isArray(criteria?.verdicts) || criteria.verdicts.length === 0) {
      stats.noVerdicts += 1
      return null
    }
    if (!Number.isFinite(criteria.locationNudge)) {
      stats.noNudge += 1
      return null
    }
    const scored = rescoreBreakdown(criteria.verdicts)
    if (scored.fit === null) return null

    const { explain, ...rest } = criteria
    return {
      fit: Math.max(0, Math.min(100, scored.fit + criteria.locationNudge)),
      was: Math.round(storedFit),
      blob: JSON.stringify({
        ...rest,
        coverage: scored.coverage,
        needsReview: needsReview(scored.coverage),
        ...deriveHighlights(criteria.verdicts),
      }),
    }
  }

  if (DO_SEARCH) {
    const rewrite = db.prepare(`
      UPDATE candidate_job_analyses SET absolute_fit = ?, criteria_results = ?
      WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
        AND analysis_model = ? AND scoring_version = ?
    `)
    let key = ''
    for (;;) {
      const page = db.prepare(`
        SELECT a.candidate_id, a.profile_version, a.job_id, a.jd_version, a.analysis_model,
               a.absolute_fit, a.criteria_results, ${KEY_SQL} AS k
        FROM candidate_job_analyses a
        WHERE a.scoring_version = ?
          ${ONLY_JOB === null ? '' : 'AND a.job_id = ?'}
          AND ${KEY_SQL} > ?
        ORDER BY k LIMIT ?
      `).all(...(ONLY_JOB === null ? [TARGET, key, PAGE] : [TARGET, ONLY_JOB, key, PAGE]))
      if (page.length === 0) break
      key = page[page.length - 1].k

      db.transaction(() => {
        for (const row of page) {
          stats.seen += 1
          const next = rescoreStored(row.criteria_results, row.absolute_fit)
          if (!next) continue
          stats.moved.push(next.fit - next.was)
          if (!RUN) continue
          note.run(refreshRun, 'analysis_update', JSON.stringify({
            candidate_id: row.candidate_id, profile_version: row.profile_version,
            job_id: row.job_id, jd_version: row.jd_version, analysis_model: row.analysis_model,
          }), JSON.stringify({
            absolute_fit: row.absolute_fit, criteria_results: row.criteria_results,
          }))
          rewrite.run(
            next.fit, next.blob, row.candidate_id, row.profile_version,
            row.job_id, row.jd_version, row.analysis_model, TARGET,
          )
        }
      })()
    }
  }

  if (DO_TRIAGE) {
    const rewrite = db.prepare(
      `UPDATE triage_applicants SET absolute_fit = ?, criteria = ? WHERE id = ?`,
    )
    let id = 0
    for (;;) {
      const page = db.prepare(`
        SELECT id, absolute_fit, criteria, scoring_version FROM triage_applicants
        WHERE criteria IS NOT NULL AND scoring_version = ?
          ${ONLY_TRIAGE === null ? '' : 'AND triage_id = ?'}
          AND id > ? ORDER BY id LIMIT ?
      `).all(...(ONLY_TRIAGE === null ? [TARGET, id, PAGE] : [TARGET, ONLY_TRIAGE, id, PAGE]))
      if (page.length === 0) break
      id = page[page.length - 1].id

      db.transaction(() => {
        for (const row of page) {
          stats.seen += 1
          const next = rescoreStored(row.criteria, row.absolute_fit)
          if (!next) continue
          stats.moved.push(next.fit - next.was)
          if (!RUN) continue
          note.run(refreshRun, 'applicant_update', JSON.stringify({ id: row.id }), JSON.stringify({
            absolute_fit: row.absolute_fit, criteria: row.criteria,
            scoring_version: row.scoring_version,
          }))
          rewrite.run(next.fit, next.blob, row.id)
        }
      })()
    }
  }

  console.log(`REFRESH at silence fraction ${silenceFraction()}`)
  console.log(`  version-${TARGET} rows seen           : ${stats.seen}`)
  console.log(`  rescored                     : ${stats.moved.length}`)
  console.log(`  no verdicts, left alone      : ${stats.noVerdicts}`)
  if (stats.noNudge > 0) {
    console.log(`  no stored location nudge     : ${stats.noNudge}   <-- written before the nudge was recorded; cannot be refreshed without guessing`)
  }
  console.log(`  score movement               : ${movement(stats.moved)}`)
  console.log('')

  if (RUN) {
    db.prepare(`UPDATE score_migration_runs SET completed_at = ? WHERE id = ?`).run(now(), refreshRun)
    console.log(`Recorded as run ${refreshRun}. To undo exactly this run:`)
    console.log('  npm run score:migrate -- --revert --run')
    console.log('')
  }
  process.exit(0)
}

/* ------------------------------------------- the one piece of arithmetic --- */

/* The pre-change arithmetic, kept here and nowhere else: it exists only to
   recover the location nudge by subtraction, and having it in the product
   would be two scorers one bug apart. */
const MULT = { meets: 1, partial: 0.6, contradicted: 0 }
const TIER_FALLBACK = { must_have: 30, preferred: 10, contextual: 5 }

function oldFitOf(breakdown) {
  let known = 0
  let earned = 0
  for (const row of breakdown) {
    if (row.status === 'no_evidence') continue
    /* The same fallback rescoreBreakdown uses. They disagreed — 5 here, the
       tier's weight there — so for a stored verdict carrying a tier but no
       weight the recovered nudge was wrong by the whole difference, and that
       error went straight into the migrated score. */
    const weight = Number(row.weight) || TIER_FALLBACK[row.tier] || 5
    known += weight
    earned += (MULT[row.status] ?? 0) * weight
  }
  return known === 0 ? null : Math.round((earned / known) * 100)
}

/** The largest the location nudge can be, used only to spot a clamped row. */
const MAX_NUDGE = 8

function rescoreOne({ criteria, storedFit }) {
  const verdicts = Array.isArray(criteria?.verdicts) ? criteria.verdicts : null
  if (!verdicts || verdicts.length === 0) return { skip: 'no-verdicts' }

  const before = oldFitOf(verdicts)
  if (before === null) return { skip: 'nothing-was-judged' }

  const stored = Math.round(storedFit)
  const nudge = stored - before
  /* Approximate only where the clamp could actually have bitten: a row that
     landed on 100 with a nudge of 0 is exact, and reporting it as
     approximate would inflate the count that matters. */
  const clamped = (stored >= 100 && before + MAX_NUDGE > 100)
    || (stored <= 0 && before - MAX_NUDGE < 0)

  const after = rescoreBreakdown(verdicts)

  /* Every verdict was no_evidence, so oldFitOf already returned null above
     and we never reach here. Belt and braces: a fit of null must never be
     written into a NOT NULL column as NaN or 0. */
  if (after.fit === null) return { skip: 'nothing-was-judged' }

  return {
    before,
    stored,
    nudge,
    clamped,
    after: Math.max(0, Math.min(100, after.fit + nudge)),
    coverage: after.coverage,
    verdicts,
  }
}

const blank = () => ({
  seen: 0, rescored: 0, carried: 0, preVersion: 0, stale: 0, skipped: 0,
  clamped: 0, moved: [],
})
const searchStats = blank()
const triageStats = blank()

/*
 * Having already finished is the ordinary case, and it has to cost nothing.
 *
 * This is started on every boot, and almost every boot has no work: the rows
 * moved on the deploy that raised the version and stayed moved. Falling
 * through would rewrite every migrated row's created_at, which workspace.js
 * orders a folder's scores by.
 *
 * The gate is a COMPLETED recorded run, not a count of what is left at the
 * old version. Counting looks like the obvious test and is wrong: the Search
 * half is additive, so its version-2 rows are still there afterwards and
 * always will be — that is what makes the revert a setting rather than a
 * restore. A count would say "116 to do" forever and re-migrate on every
 * boot. Nor can the count be fixed by looking for rows with no version-3
 * twin, because the loop deliberately skips rows whose candidate has been
 * re-profiled since, and those never get one.
 *
 * Once the app writes version 3 it never writes another version-2 row, so
 * the migration is a once-per-bump event and "has it finished" is exactly
 * the right question. A run that died half way has no completed_at and is
 * picked up again; ON CONFLICT DO NOTHING makes resuming free.
 */
const alreadyRun = SCOPED || FORCE ? null : db.prepare(`
  SELECT id, created_at FROM score_migration_runs
  WHERE from_version = ? AND to_version = ? AND reverted_at IS NULL
    AND completed_at IS NOT NULL AND scope = ?
  ORDER BY id DESC LIMIT 1
`).get(FROM, TARGET, JSON.stringify({ job: null, triage: null }))

if (alreadyRun) {
  console.log(`Run ${alreadyRun.id} already moved ${FROM} -> ${TARGET} on ${alreadyRun.created_at}.`)
  console.log('Nothing to do. --force runs it again; --revert --run undoes it.')
  console.log('SCORE_MIGRATE_IDLE\n')
  process.exit(0)
}

/* And a database with nothing at the old version at all — a fresh install,
   or one that was never on version 2 — needs no run recorded to skip. */
const pending = (DO_SEARCH ? db.prepare(`
  SELECT COUNT(*) AS n FROM candidate_job_analyses
  WHERE scoring_version = ? ${ONLY_JOB === null ? '' : 'AND job_id = ?'}
`).get(...(ONLY_JOB === null ? [FROM] : [FROM, ONLY_JOB])).n : 0)
  + (DO_TRIAGE ? db.prepare(`
    SELECT COUNT(*) AS n FROM triage_applicants
    WHERE criteria IS NOT NULL AND (scoring_version IS NULL OR scoring_version = ?)
      ${ONLY_TRIAGE === null ? '' : 'AND triage_id = ?'}
  `).get(...(ONLY_TRIAGE === null ? [FROM] : [FROM, ONLY_TRIAGE])).n : 0)

if (pending === 0) {
  console.log(`Nothing at version ${FROM} to migrate.`)
  console.log('SCORE_MIGRATE_IDLE\n')
  process.exit(0)
}

const recordRun = RUN
  ? db.prepare(`
    INSERT INTO score_migration_runs (stamp, from_version, to_version, silence, scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
    FROM, TARGET, silenceFraction(),
    JSON.stringify({ job: ONLY_JOB, triage: ONLY_TRIAGE }),
    now(),
  ).lastInsertRowid
  : null

const noteRow = RUN
  ? db.prepare(`INSERT INTO score_migration_rows (run_id, kind, key_json, payload) VALUES (?, ?, ?, ?)`)
  : null

/* ---------------------------------------------------------- the Search --- */

/*
 * DO NOTHING, not DO UPDATE.
 *
 * With DO UPDATE this script could overwrite a version-3 row a model had
 * genuinely just produced — the window is real, because it now runs in the
 * background while the server takes requests — and it recorded every write
 * as an insert, so the revert would then DELETE a row the migration had
 * merely trampled. Filling gaps is the whole job. `changes` tells us whether
 * a row was actually created, and only then is it recorded as ours to undo.
 */
const alreadyThere = db.prepare(`
  SELECT 1 FROM candidate_job_analyses
  WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
    AND analysis_model = ? AND scoring_version = ?
`).pluck()

const writeRow = db.prepare(`
  INSERT INTO candidate_job_analyses (
    candidate_id, profile_version, job_id, jd_version, analysis_model,
    scoring_version, absolute_fit, criteria_results, explanation, source, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO NOTHING
`)

/*
 * Read in pages, and page on the WHOLE primary key.
 *
 * The key used to be candidate_id:job_id:jd_version:profile_version, which
 * leaves out analysis_model — so two rows for the same candidate and job
 * analysed under different models (a MATCH_MODEL change, or a period with no
 * API key, when the model is recorded as "deterministic") shared a key, and
 * `WHERE key > lastKey` excluded BOTH of them at the page boundary. Rows
 * were silently skipped, stayed at version 2, and the completed-run gate
 * then made sure nobody ever came back for them.
 */
let lastKey = ''
while (DO_SEARCH) {
  const page = db.prepare(`
    SELECT a.candidate_id, a.profile_version, a.job_id, a.jd_version, a.analysis_model,
           a.absolute_fit, a.criteria_results, a.explanation, a.source,
           ${KEY_SQL} AS k
    FROM candidate_job_analyses a
    WHERE a.scoring_version = ?
      ${ONLY_JOB === null ? '' : 'AND a.job_id = ?'}
      AND ${KEY_SQL} > ?
    ORDER BY k
    LIMIT ?
  `).all(...(ONLY_JOB === null ? [FROM, lastKey, PAGE] : [FROM, ONLY_JOB, lastKey, PAGE]))

  if (page.length === 0) break
  lastKey = page[page.length - 1].k

  const work = db.transaction(() => {
    for (const row of page) {
      searchStats.seen += 1

      /*
       * A row whose candidate has edited their profile since is dead: the
       * cache is read at the CURRENT profile_version, so nothing will ever
       * look this up again. Migrating it writes a v3 twin that is equally
       * unreachable.
       */
      if (profileVersion(row.candidate_id) !== row.profile_version) {
        searchStats.stale += 1
        continue
      }

      let criteria = null
      try {
        criteria = JSON.parse(row.criteria_results)
      } catch {
        criteria = null
      }

      const result = criteria ? rescoreOne({
        criteria,
        storedFit: row.absolute_fit,
      }) : { skip: 'unreadable' }

      const key = {
        candidate_id: row.candidate_id,
        profile_version: row.profile_version,
        job_id: row.job_id,
        jd_version: row.jd_version,
        analysis_model: row.analysis_model,
      }

      const write = (fit, blob) => {
        /* A dry run has to answer the question a forced run is asked: how
           many of these already have a version-3 twin? Counted rather than
           inferred from `changes`, because there is no write to count. */
        if (!RUN) {
          if (alreadyThere.get(
            row.candidate_id, row.profile_version, row.job_id, row.jd_version,
            row.analysis_model, TARGET,
          )) searchStats.skipped += 1
          return
        }
        /* A fresh timestamp, not the original. workspace.js picks a folder
           row's score with ORDER BY created_at DESC and no version filter,
           so copying the old stamp left two rows tied and the score shown
           was a coin flip between the two arithmetics. */
        const { changes } = writeRow.run(
          row.candidate_id, row.profile_version, row.job_id, row.jd_version,
          row.analysis_model, TARGET, fit, blob, row.explanation, row.source, now(),
        )
        if (changes === 1) noteRow.run(recordRun, 'analysis_insert', JSON.stringify(key), null)
        else searchStats.skipped += 1
      }

      if (result.skip) {
        searchStats.carried += 1
        write(row.absolute_fit, row.criteria_results)
        continue
      }

      searchStats.rescored += 1
      if (result.clamped) searchStats.clamped += 1
      searchStats.moved.push(result.after - result.stored)

      /*
       * The derived lists are recomputed, not carried.
       *
       * strengths, gaps and evidence are derived from the verdicts at write
       * time and read straight back by the UI. Leaving the old ones beside
       * recomputed coverage would show a recruiter two readings of one CV.
       *
       * `explain` goes for the same reason: the explainer is instructed
       * never to contradict a status, and after a rescore the stored one
       * may. It is regenerated on open by the model that wrote it — which is
       * a real cost on first open, and the one model call this migration
       * causes even though it makes none itself.
       */
      const { explain, ...rest } = criteria
      write(result.after, JSON.stringify({
        ...rest,
        verdicts: result.verdicts,
        coverage: result.coverage,
        needsReview: needsReview(result.coverage),
        /* Recovered by subtraction here, and written down so it never has
           to be recovered again. See --refresh. */
        locationNudge: result.nudge,
        ...deriveHighlights(result.verdicts),
      }))
    }
  })

  work()
}

/* ---------------------------------------------------------- the Triage --- */

const writeApplicant = db.prepare(`
  UPDATE triage_applicants SET absolute_fit = ?, criteria = ?, scoring_version = ? WHERE id = ?
`)

let lastId = 0
while (DO_TRIAGE) {
  const page = db.prepare(`
    SELECT id, triage_id, absolute_fit, criteria, scoring_version
    FROM triage_applicants
    WHERE criteria IS NOT NULL AND (scoring_version IS NULL OR scoring_version = ?)
      ${ONLY_TRIAGE === null ? '' : 'AND triage_id = ?'}
      AND id > ?
    ORDER BY id LIMIT ?
  `).all(...(ONLY_TRIAGE === null ? [FROM, lastId, PAGE] : [FROM, ONLY_TRIAGE, lastId, PAGE]))

  if (page.length === 0) break
  lastId = page[page.length - 1].id

  const work = db.transaction(() => {
    for (const row of page) {
      triageStats.seen += 1

      let criteria = null
      try {
        criteria = JSON.parse(row.criteria)
      } catch {
        criteria = null
      }

      /*
       * A row with no scoring_version predates the column, which puts it in
       * the version-1 era the Search half refuses to touch: its stored
       * number may be one the model invented rather than one the verdicts
       * produce. Subtracting the verdict arithmetic from that is not
       * recovering a location nudge, it is recovering an arbitrary gap and
       * adding it to the new score.
       *
       * So a pre-version row is stamped and otherwise left alone. It has to
       * be stamped, because triage.js ranks without filtering on version and
       * would otherwise leave it mixed in unlabelled forever.
       */
      const preVersion = row.scoring_version === null
      const result = criteria && !preVersion
        ? rescoreOne({ criteria, storedFit: row.absolute_fit })
        : { skip: preVersion ? 'pre-version' : 'unreadable' }

      const before = JSON.stringify({
        absolute_fit: row.absolute_fit, criteria: row.criteria,
        scoring_version: row.scoring_version,
      })

      if (result.skip) {
        if (result.skip === 'pre-version') triageStats.preVersion += 1
        else triageStats.carried += 1
        if (RUN) {
          writeApplicant.run(row.absolute_fit, row.criteria, TARGET, row.id)
          noteRow.run(recordRun, 'applicant_update', JSON.stringify({ id: row.id }), before)
        }
        continue
      }

      triageStats.rescored += 1
      if (result.clamped) triageStats.clamped += 1
      triageStats.moved.push(result.after - result.stored)

      if (RUN) {
        const { explain, ...rest } = criteria
        writeApplicant.run(result.after, JSON.stringify({
          ...rest,
          verdicts: result.verdicts,
          coverage: result.coverage,
          needsReview: needsReview(result.coverage),
          locationNudge: result.nudge,
          ...deriveHighlights(result.verdicts),
        }), TARGET, row.id)
        noteRow.run(recordRun, 'applicant_update', JSON.stringify({ id: row.id }), before)
      }
    }
  })

  work()
}

/* ------------------------------------------------------------ the report --- */

function movement(moved) {
  if (moved.length === 0) return 'nothing moved'
  const sorted = [...moved].sort((a, b) => a - b)
  const mean = moved.reduce((s, n) => s + n, 0) / moved.length
  return `median ${sorted[Math.floor(sorted.length / 2)]}, mean ${mean.toFixed(1)}, `
    + `range ${sorted[0]} to ${sorted[sorted.length - 1]}`
}

for (const [name, st, ran] of [
  ['SEARCH (candidate_job_analyses)', searchStats, DO_SEARCH],
  ['TRIAGE (triage_applicants)', triageStats, DO_TRIAGE],
]) {
  if (!ran) continue
  console.log(name)
  console.log(`  version-${FROM} rows seen           : ${st.seen}`)
  console.log(`  rescored from verdicts       : ${st.rescored}`)
  console.log(`  carried forward, no verdicts : ${st.carried}   (scored deterministically)`)
  if (st.preVersion > 0) {
    console.log(`  stamped, pre-version         : ${st.preVersion}   (no scoring_version; score left as it was)`)
  }
  if (st.stale > 0) {
    console.log(`  skipped, profile has moved   : ${st.stale}   (unreachable by the cache either way)`)
  }
  if (st.skipped > 0) {
    console.log(`  already at version ${TARGET}         : ${st.skipped}   (left exactly as they were)`)
  }
  if (st.clamped > 0) {
    console.log(`  location nudge approximate   : ${st.clamped}   (stored value was on the clamp; error bounded by ${MAX_NUDGE} points)`)
  }
  console.log(`  score movement               : ${movement(st.moved)}`)
  console.log('')
}

if (!RUN) {
  console.log('Dry run — nothing was written.')
  console.log('  npm run score:migrate -- --run')
  console.log('')
  process.exit(0)
}

db.prepare(`UPDATE score_migration_runs SET completed_at = ? WHERE id = ?`).run(now(), recordRun)

console.log('ROW COUNTS AFTER')
for (const row of db.prepare(
  `SELECT scoring_version AS v, COUNT(*) AS n FROM candidate_job_analyses GROUP BY scoring_version ORDER BY v`,
).all()) {
  console.log(`  candidate_job_analyses v${pad(row.v, 4)} ${padL(row.n, 8)} row(s)`)
}
for (const row of db.prepare(
  `SELECT COALESCE(scoring_version, '(none)') AS v, COUNT(*) AS n FROM triage_applicants
   WHERE criteria IS NOT NULL GROUP BY scoring_version ORDER BY v`,
).all()) {
  console.log(`  triage_applicants      v${pad(row.v, 4)} ${padL(row.n, 8)} row(s)`)
}

console.log('')
console.log(`Recorded as run ${recordRun}, completed. To undo exactly this run and nothing else:`)
console.log('  npm run score:migrate -- --revert --run')
console.log('')
