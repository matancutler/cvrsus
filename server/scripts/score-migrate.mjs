#!/usr/bin/env node
/**
 * Rescores every stored analysis under the new arithmetic, without calling a
 * model once.
 *
 *   npm run score:migrate                      what it would do, and nothing else
 *   npm run score:migrate -- --run             do it
 *   npm run score:migrate -- --job 42 --run    one job first, to look at
 *   npm run score:migrate -- --revert --run    put it back
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
 * Search — ADDITIVE. Every version-2 row gets a version-3 row written beside
 * it; the version-2 row is untouched.
 *
 * Triage — IN PLACE, because scoring_version there is a column rather than
 * part of a key, so there is no second row to write.
 *
 * Every run is RECORDED. score_migration_runs holds the run; score_migration_rows
 * holds the primary key of every row it inserted and the previous value of
 * every row it overwrote. --revert undoes exactly those and nothing else.
 *
 * That matters more than it sounds. The first version of this reverted with
 * `DELETE FROM candidate_job_analyses WHERE scoring_version = ?`, which
 * would also have deleted every analysis written by ordinary use since the
 * migration — new candidates, new jobs, bumped profile versions — none of
 * which has a version-2 row to fall back to. And because the target version
 * came from the environment, an operator who set MATCH_V_SCORING=2 before
 * reverting, which is the instinctive order, would have deleted every
 * pristine original instead. The revert now reads its target from the run it
 * is undoing, so the environment cannot aim it at the wrong rows.
 *
 * Both tables are copied to a timestamped backup before anything is written,
 * on the forward path AND on the revert.
 *
 * ---
 *
 * WHAT CHANGES A NUMBER
 *
 * Silence is priced: no_evidence earns MATCH_SILENCE_FRACTION of its weight
 * instead of being struck from both halves of the fraction.
 *
 * The quote check is NOT applied retroactively to Search rows, and that is a
 * deliberate refusal rather than an omission. The model was shown dossier()
 * — the CV text with the candidate's name, email and phone replaced by
 * [redacted], plus their profile summary and employment history, none of
 * which is in candidates.cv_text. Checking a stored quote against cv_text
 * would therefore downgrade correct verdicts wholesale: a candidate called
 * Lee has "Leeds" rewritten to "[redacted]ds" in the text the model quoted
 * from, and the quote will never be found in the original. Quotes are
 * checked at analysis time instead, against the exact string the model was
 * given. Triage IS checked here, because triageQueue passes extracted_text
 * with no name redaction and that is the same string this reads.
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
import 'dotenv/config'
import process from 'node:process'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const valueOf = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? null : argv[at + 1]
}

const RUN = has('run')
const REVERT = has('revert')
const ONLY_JOB = valueOf('job') === null ? null : Number(valueOf('job'))
const ONLY_TRIAGE = valueOf('triage') === null ? null : Number(valueOf('triage'))

const db = (await import('../src/db.js')).default
const {
  rescoreBreakdown, checkQuotes, silenceFraction, needsReview, deriveHighlights,
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

const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const backupName = (table) => `${table}_pre_v${TARGET}_${STAMP}`

function backup(label) {
  for (const table of ['candidate_job_analyses', 'triage_applicants']) {
    const name = `${backupName(table)}${label}`
    if (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name)) {
      console.log(`  backup ${name} already exists — not overwriting it`)
      continue
    }
    db.prepare(`CREATE TABLE ${name} AS SELECT * FROM ${table}`).run()
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n
    console.log(`  backed up ${pad(table, 24)} -> ${pad(name, 50)} ${padL(n, 7)} row(s)`)
  }
  console.log('')
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
  console.error(`Target version is ${TARGET}, which is what rows are migrated FROM.`)
  console.error('MATCH_V_SCORING is probably still set to the old value. Nothing to do.\n')
  process.exit(1)
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
  const updated = rows.filter((r) => r.kind === 'applicant_update')

  console.log(`Undoing run ${run.id} of ${run.created_at} (${run.from_version} -> ${run.to_version})`)
  console.log(`  ${inserted.length} analysis row(s) to remove`)
  console.log(`  ${updated.length} Triage applicant(s) to put back`)
  console.log('')

  if (!RUN) {
    console.log('Dry run. Add --run alongside --revert to actually restore.\n')
    process.exit(0)
  }

  /* A revert is a write like any other and gets the same safety net. The
     first version of this took no backup on the way back, which made a
     mistaken revert unrecoverable. */
  backup('_pre_revert')

  db.transaction(() => {
    const drop = db.prepare(`
      DELETE FROM candidate_job_analyses
      WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
        AND analysis_model = ? AND scoring_version = ?
    `)
    for (const row of inserted) {
      const k = JSON.parse(row.key_json)
      drop.run(k.candidate_id, k.profile_version, k.job_id, k.jd_version, k.analysis_model, run.to_version)
    }

    const put = db.prepare(`
      UPDATE triage_applicants SET absolute_fit = ?, criteria = ?, scoring_version = ? WHERE id = ?
    `)
    for (const row of updated) {
      const before = JSON.parse(row.payload)
      put.run(before.absolute_fit, before.criteria, before.scoring_version, JSON.parse(row.key_json).id)
    }

    db.prepare(`UPDATE score_migration_runs SET reverted_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), run.id)
  })()

  console.log(`Removed ${inserted.length} row(s) and restored ${updated.length} applicant(s).`)
  console.log('Only what that run wrote was touched; anything written since is untouched.')
  console.log(`Set MATCH_V_SCORING=${run.from_version} and restart to read the old scores.\n`)
  process.exit(0)
}

/* ------------------------------------------- the one piece of arithmetic --- */

/* The pre-change arithmetic, kept here and nowhere else: it exists only to
   recover the location nudge by subtraction, and having it in the product
   would be two scorers one bug apart. */
function oldFitOf(breakdown) {
  const MULT = { meets: 1, partial: 0.6, contradicted: 0 }
  let known = 0
  let earned = 0
  for (const row of breakdown) {
    if (row.status === 'no_evidence') continue
    const weight = Number(row.weight) || 5
    known += weight
    earned += (MULT[row.status] ?? 0) * weight
  }
  return known === 0 ? null : Math.round((earned / known) * 100)
}

/** The largest the location nudge can be, used only to spot a clamped row. */
const MAX_NUDGE = 8

function rescoreOne({ criteria, storedFit, cvText, checkTheQuotes }) {
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

  const quoted = checkTheQuotes && cvText
    ? checkQuotes(verdicts, cvText)
    : { breakdown: verdicts, downgraded: 0, examples: [] }

  const after = rescoreBreakdown(quoted.breakdown)

  /*
   * Every verdict was downgraded, so there is nothing left to score from.
   *
   * This is the single strongest signal an analysis is untrustworthy, and
   * the first version of this treated it as "nothing to do" and wrote the
   * row through with its OLD score and its UN-downgraded verdicts — so the
   * most suspect rows in the database were the ones that came out unchanged.
   */
  if (after.fit === null) {
    return {
      skip: 'all-verdicts-unverified',
      verdicts: quoted.breakdown,
      downgraded: quoted.downgraded,
      examples: quoted.examples,
      coverage: 0,
    }
  }

  return {
    before,
    stored,
    nudge,
    clamped,
    after: Math.max(0, Math.min(100, after.fit + nudge)),
    coverage: after.coverage,
    downgraded: quoted.downgraded,
    examples: quoted.examples,
    verdicts: quoted.breakdown,
  }
}

const blank = () => ({
  seen: 0, rescored: 0, carried: 0, unverified: 0, stale: 0,
  clamped: 0, downgraded: 0, moved: [], examples: [],
})
const searchStats = blank()
const triageStats = blank()

if (RUN) backup('')

const recordRun = RUN
  ? db.prepare(`
    INSERT INTO score_migration_runs (stamp, from_version, to_version, silence, scope, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    STAMP, FROM, TARGET, silenceFraction(),
    JSON.stringify({ job: ONLY_JOB, triage: ONLY_TRIAGE }),
    new Date().toISOString(),
  ).lastInsertRowid
  : null

const noteRow = RUN
  ? db.prepare(`INSERT INTO score_migration_rows (run_id, kind, key_json, payload) VALUES (?, ?, ?, ?)`)
  : null

/* ---------------------------------------------------------- the Search --- */

const writeRow = db.prepare(`
  INSERT INTO candidate_job_analyses (
    candidate_id, profile_version, job_id, jd_version, analysis_model,
    scoring_version, absolute_fit, criteria_results, explanation, source, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO UPDATE SET
    absolute_fit = excluded.absolute_fit,
    criteria_results = excluded.criteria_results,
    source = excluded.source,
    created_at = excluded.created_at
`)

/*
 * Read in pages, not all at once.
 *
 * The first version did `.all()` over the whole table with each candidate's
 * CV text joined on, then wrapped every write in one transaction. At a few
 * tens of thousands of analyses that is gigabytes of resident strings and a
 * write lock held for the duration — every concurrent search hitting a cache
 * miss would get SQLITE_BUSY. This is billed as safe to run against a live
 * database, so it has to be.
 */
const PAGE = 500
let lastKey = ''

for (;;) {
  const page = db.prepare(`
    SELECT a.candidate_id, a.profile_version, a.job_id, a.jd_version, a.analysis_model,
           a.absolute_fit, a.criteria_results, a.explanation, a.source,
           (a.candidate_id || ':' || a.job_id || ':' || a.jd_version || ':' || a.profile_version) AS k
    FROM candidate_job_analyses a
    WHERE a.scoring_version = ?
      ${ONLY_JOB === null ? '' : 'AND a.job_id = ?'}
      ${ONLY_TRIAGE !== null && ONLY_JOB === null ? 'AND 0' : ''}
      AND (a.candidate_id || ':' || a.job_id || ':' || a.jd_version || ':' || a.profile_version) > ?
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
       * unreachable, and quote-checking it would compare against a CV that
       * is not the one it was written about.
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

      const result = criteria
        ? rescoreOne({
          criteria,
          storedFit: row.absolute_fit,
          /* Not checked here — see the note at the top of this file. The
             model was shown a redacted dossier, not this text. */
          checkTheQuotes: false,
        })
        : { skip: 'unreadable' }

      const key = {
        candidate_id: row.candidate_id,
        profile_version: row.profile_version,
        job_id: row.job_id,
        jd_version: row.jd_version,
        analysis_model: row.analysis_model,
      }

      if (result.skip) {
        if (result.skip === 'all-verdicts-unverified') searchStats.unverified += 1
        else searchStats.carried += 1

        if (RUN) {
          /* A fresh timestamp, not the original. workspace.js picks a folder
             row's score with ORDER BY created_at DESC and no version filter,
             so copying the old stamp left two rows tied and the score shown
             was a coin flip between the two arithmetics. */
          writeRow.run(
            row.candidate_id, row.profile_version, row.job_id, row.jd_version,
            row.analysis_model, TARGET, row.absolute_fit, row.criteria_results,
            row.explanation, row.source, new Date().toISOString(),
          )
          noteRow.run(recordRun, 'analysis_insert', JSON.stringify(key), null)
        }
        continue
      }

      searchStats.rescored += 1
      searchStats.downgraded += result.downgraded
      if (result.clamped) searchStats.clamped += 1
      searchStats.moved.push(result.after - result.stored)

      if (RUN) {
        /*
         * The derived lists are recomputed, not carried.
         *
         * strengths, gaps and evidence are derived from the verdicts at
         * write time and read straight back by the UI. Overwriting the
         * verdicts and leaving them would put a requirement under Strengths
         * quoting evidence the same migration had just rejected, directly
         * above the verdict list contradicting it.
         *
         * `explain` goes for the same reason: the explainer is instructed
         * never to contradict a status, and after a rescore the stored one
         * may. It is regenerated on open, cheaply, by the model that wrote it.
         */
        const { explain, ...rest } = criteria
        const next = {
          ...rest,
          verdicts: result.verdicts,
          coverage: result.coverage,
          needsReview: needsReview(result.coverage),
          ...deriveHighlights(result.verdicts),
        }
        writeRow.run(
          row.candidate_id, row.profile_version, row.job_id, row.jd_version,
          row.analysis_model, TARGET, result.after, JSON.stringify(next),
          row.explanation, row.source, new Date().toISOString(),
        )
        noteRow.run(recordRun, 'analysis_insert', JSON.stringify(key), null)
      }
    }
  })

  work()
}

/* ---------------------------------------------------------- the Triage --- */

const writeApplicant = db.prepare(`
  UPDATE triage_applicants SET absolute_fit = ?, criteria = ?, scoring_version = ? WHERE id = ?
`)

let lastId = 0
for (;;) {
  const page = db.prepare(`
    SELECT id, triage_id, absolute_fit, criteria, scoring_version, extracted_text
    FROM triage_applicants
    WHERE criteria IS NOT NULL AND (scoring_version IS NULL OR scoring_version = ?)
      ${ONLY_TRIAGE === null ? '' : 'AND triage_id = ?'}
      ${ONLY_JOB !== null && ONLY_TRIAGE === null ? 'AND 0' : ''}
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

      const result = criteria
        ? rescoreOne({
          criteria,
          storedFit: row.absolute_fit,
          cvText: row.extracted_text,
          /*
           * Checked here, unlike Search. triageQueue passes the applicant as
           * { id, display_name, location, cv_text: extracted_text } with no
           * name, email or phone — so dossier() redacts nothing, and the
           * string the model quoted from is the string this reads.
           */
          checkTheQuotes: true,
        })
        : { skip: 'unreadable' }

      const before = JSON.stringify({
        absolute_fit: row.absolute_fit, criteria: row.criteria,
        scoring_version: row.scoring_version,
      })

      if (result.skip) {
        if (result.skip === 'all-verdicts-unverified') triageStats.unverified += 1
        else triageStats.carried += 1
        if (RUN) {
          writeApplicant.run(row.absolute_fit, row.criteria, TARGET, row.id)
          noteRow.run(recordRun, 'applicant_update', JSON.stringify({ id: row.id }), before)
        }
        continue
      }

      triageStats.rescored += 1
      triageStats.downgraded += result.downgraded
      if (result.clamped) triageStats.clamped += 1
      if (triageStats.examples.length < 10) triageStats.examples.push(...result.examples.slice(0, 1))
      triageStats.moved.push(result.after - result.stored)

      if (RUN) {
        const { explain, ...rest } = criteria
        const next = {
          ...rest,
          verdicts: result.verdicts,
          coverage: result.coverage,
          needsReview: needsReview(result.coverage),
          ...deriveHighlights(result.verdicts),
        }
        writeApplicant.run(result.after, JSON.stringify(next), TARGET, row.id)
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

for (const [name, st] of [
  ['SEARCH (candidate_job_analyses)', searchStats],
  ['TRIAGE (triage_applicants)', triageStats],
]) {
  console.log(name)
  console.log(`  version-${FROM} rows seen           : ${st.seen}`)
  console.log(`  rescored from verdicts       : ${st.rescored}`)
  console.log(`  carried forward, no verdicts : ${st.carried}   (scored deterministically)`)
  if (st.unverified > 0) {
    console.log(`  every verdict unverified     : ${st.unverified}   <-- quotes not found in the CV; carried at the old score and worth looking at`)
  }
  if (st.stale > 0) {
    console.log(`  skipped, profile has moved   : ${st.stale}   (unreachable by the cache either way)`)
  }
  console.log(`  verdicts downgraded on quote : ${st.downgraded}`)
  if (st.clamped > 0) {
    console.log(`  location nudge approximate   : ${st.clamped}   (stored value was on the clamp; error bounded by ${MAX_NUDGE} points)`)
  }
  console.log(`  score movement               : ${movement(st.moved)}`)
  console.log('')
}

if (triageStats.examples.length > 0) {
  console.log('QUOTES NOT FOUND IN THE CV (Triage, up to ten)')
  for (const ex of triageStats.examples.slice(0, 10)) {
    console.log(`  ${pad(String(ex.requirement).slice(0, 34), 36)} was ${pad(ex.was, 12)} "${String(ex.quote).slice(0, 66)}"`)
  }
  console.log('')
}

if (!RUN) {
  console.log('Dry run — nothing was written and no backup was taken.')
  console.log('  npm run score:migrate -- --run')
  console.log('')
  process.exit(0)
}

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
console.log(`Recorded as run ${recordRun}. To undo exactly this run and nothing else:`)
console.log('  npm run score:migrate -- --revert --run')
console.log(`Then set MATCH_V_SCORING=${FROM} and restart.`)
console.log('')
