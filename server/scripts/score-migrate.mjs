#!/usr/bin/env node
/**
 * Rescores every stored analysis under the new arithmetic, without calling a
 * model once.
 *
 *   npm run score:migrate                 what it would do, and nothing else
 *   npm run score:migrate -- --run        do it
 *   npm run score:migrate -- --revert     put it back
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
 * Search — ADDITIVE. Every v2 row gets a v3 row written beside it; the v2
 * row is untouched. Reverting is MATCH_V_SCORING=2 and a restart, and the
 * old numbers are found again immediately, because they never went away.
 * The table roughly doubles, which is the price of being able to change your
 * mind.
 *
 * Triage — IN PLACE, because scoring_version there is a column rather than
 * part of a key, so there is no second row to write. Reversibility comes
 * from the backup table this takes first and the --revert that reads it
 * back.
 *
 * Both tables are copied to a timestamped backup before anything is
 * written, whichever path is taken.
 *
 * ---
 *
 * WHAT CHANGES A NUMBER
 *
 *   1. Silence is priced. no_evidence earns MATCH_SILENCE_FRACTION of its
 *      weight instead of being struck from both halves of the fraction.
 *   2. Quotes are checked. A verdict whose quote is not in the CV becomes
 *      no_evidence, because a quotation that is not a quotation is not
 *      evidence of anything.
 *
 * The location nudge survives exactly. It was added after the fit was
 * computed and never stored on its own, so it is recovered by subtraction:
 * the old fit is recomputed from the same verdicts, and whatever the stored
 * number has on top of it is the nudge. That is exact except where the old
 * value hit the 0-100 clamp, and those are counted and reported rather than
 * waved through.
 *
 * Rows with no verdicts — anything scored deterministically, which is every
 * row on a machine with no API key — are carried forward unchanged. They
 * were never verdict-based and the new arithmetic has nothing to say about
 * them.
 */
import process from 'node:process'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)

const RUN = has('run')
const REVERT = has('revert')

const db = (await import('../src/db.js')).default
const { rescoreBreakdown, checkQuotes, silenceFraction } = await import('../src/matching/score.js')
const { VERSIONS } = await import('../src/matching/config.js')

const TARGET = String(VERSIONS.scoring)
const money = (n) => (Number.isFinite(n) ? n.toFixed(0) : '-')
const pad = (v, w) => String(v ?? '').padEnd(w)
const padL = (v, w) => String(v ?? '').padStart(w)

/* One stamp for both tables, so a revert can name a moment rather than a
   table. */
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

const backupName = (table) => `${table}_pre_v${TARGET}_${STAMP}`

function existingBackups(table) {
  return db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?
    ORDER BY name DESC
  `).all(`${table}_pre_v%`).map((r) => r.name)
}

console.log('')
console.log('Cursus — rescoring stored analyses under the new arithmetic')
console.log(`Target scoring version : ${TARGET}`)
console.log(`Silence fraction       : ${silenceFraction()}`)
console.log(`Mode                   : ${REVERT ? 'REVERT' : RUN ? 'WRITE' : 'dry run (nothing is written)'}`)
console.log('')

/* ------------------------------------------------------------- revert --- */

if (REVERT) {
  const analyses = existingBackups('candidate_job_analyses')
  const applicants = existingBackups('triage_applicants')

  if (analyses.length === 0 && applicants.length === 0) {
    console.error('No backup tables found. Nothing to revert to.\n')
    process.exit(1)
  }

  console.log('Restoring from:')
  if (analyses[0]) console.log(`  ${analyses[0]}`)
  if (applicants[0]) console.log(`  ${applicants[0]}`)
  console.log('')

  if (!RUN) {
    console.log('Dry run. Add --run alongside --revert to actually restore.\n')
    process.exit(0)
  }

  db.transaction(() => {
    if (analyses[0]) {
      /* Only the rows this migration added come out. The v2 rows were never
         touched, so restoring the whole table would be a bigger claim than
         the change made and would undo anything written since. */
      const removed = db.prepare(
        `DELETE FROM candidate_job_analyses WHERE scoring_version = ?`,
      ).run(TARGET).changes
      console.log(`  removed ${removed} version-${TARGET} row(s); the version-2 rows were never touched`)
    }
    if (applicants[0]) {
      /* Triage was changed in place, so this genuinely puts the old values
         back — and only the three columns the migration wrote. */
      const back = db.prepare(`
        UPDATE triage_applicants AS t
        SET absolute_fit = (SELECT b.absolute_fit FROM ${applicants[0]} b WHERE b.id = t.id),
            criteria     = (SELECT b.criteria     FROM ${applicants[0]} b WHERE b.id = t.id),
            scoring_version = (SELECT b.scoring_version FROM ${applicants[0]} b WHERE b.id = t.id)
        WHERE EXISTS (SELECT 1 FROM ${applicants[0]} b WHERE b.id = t.id)
      `).run().changes
      console.log(`  restored ${back} Triage applicant(s) to their stored values`)
    }
  })()

  console.log('')
  console.log('Reverted. Set MATCH_V_SCORING=2 and restart to read the old scores.\n')
  process.exit(0)
}

/* ------------------------------------------------------------- backup --- */

if (RUN) {
  for (const table of ['candidate_job_analyses', 'triage_applicants']) {
    const name = backupName(table)
    db.prepare(`CREATE TABLE IF NOT EXISTS ${name} AS SELECT * FROM ${table}`).run()
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n
    console.log(`  backed up ${pad(table, 24)} -> ${pad(name, 46)} ${padL(n, 7)} row(s)`)
  }
  console.log('')
}

/* ------------------------------------------- the one piece of arithmetic --- */

/**
 * Rescores one stored analysis. Returns null when there is nothing to do.
 *
 * `cvText` may be null — a Triage applicant whose extracted text has been
 * swept, or a candidate whose CV was replaced. The quote check is skipped
 * rather than failed in that case: downgrading every verdict because the
 * document is no longer on disk would be the migration inventing a problem.
 */
function rescoreOne({ criteria, storedFit, cvText }) {
  const verdicts = Array.isArray(criteria?.verdicts) ? criteria.verdicts : null
  if (!verdicts || verdicts.length === 0) return null

  /* The old number, from the same verdicts, so the difference between it and
     what is stored is the location nudge and nothing else. */
  const before = rescoreOldWay(verdicts)
  if (before.fit === null) return null

  const nudge = Math.round(storedFit) - before.fit
  const clamped = storedFit >= 100 || storedFit <= 0

  const quoted = cvText ? checkQuotes(verdicts, cvText) : { breakdown: verdicts, downgraded: 0, examples: [] }
  const after = rescoreBreakdown(quoted.breakdown)
  if (after.fit === null) return null

  return {
    before: before.fit,
    storedFit: Math.round(storedFit),
    nudge,
    clamped,
    after: Math.max(0, Math.min(100, after.fit + nudge)),
    coverage: after.coverage,
    downgraded: quoted.downgraded,
    examples: quoted.examples,
    verdicts: quoted.breakdown,
  }
}

/* The pre-change arithmetic, kept here and nowhere else: it exists only to
   recover the nudge by subtraction, and having it in the product would be
   two scorers one bug apart. */
function rescoreOldWay(breakdown) {
  const MULT = { meets: 1, partial: 0.6, contradicted: 0 }
  let known = 0
  let earned = 0
  for (const row of breakdown) {
    if (row.status === 'no_evidence') continue
    const weight = Number(row.weight) || 5
    known += weight
    earned += (MULT[row.status] ?? 0) * weight
  }
  return { fit: known === 0 ? null : Math.round((earned / known) * 100) }
}

/* ---------------------------------------------------------- the Search --- */

const analyses = db.prepare(`
  SELECT a.rowid AS rid, a.candidate_id, a.profile_version, a.job_id, a.jd_version,
         a.analysis_model, a.scoring_version, a.absolute_fit, a.criteria_results,
         a.explanation, a.source, a.created_at,
         c.cv_text AS cv_text
  FROM candidate_job_analyses a
  LEFT JOIN candidates c ON c.id = a.candidate_id
  WHERE a.scoring_version <> ?
`).all(TARGET)

const searchStats = {
  seen: analyses.length, rescored: 0, carried: 0, clamped: 0,
  downgraded: 0, moved: [], examples: [],
}

const writeRow = db.prepare(`
  INSERT INTO candidate_job_analyses (
    candidate_id, profile_version, job_id, jd_version, analysis_model,
    scoring_version, absolute_fit, criteria_results, explanation, source, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT DO UPDATE SET
    absolute_fit = excluded.absolute_fit,
    criteria_results = excluded.criteria_results,
    explanation = excluded.explanation,
    source = excluded.source,
    created_at = excluded.created_at
`)

const doSearch = db.transaction(() => {
  for (const row of analyses) {
    let criteria = null
    try {
      criteria = JSON.parse(row.criteria_results)
    } catch {
      criteria = null
    }

    const result = criteria
      ? rescoreOne({ criteria, storedFit: row.absolute_fit, cvText: row.cv_text })
      : null

    if (!result) {
      searchStats.carried += 1
      if (RUN) {
        writeRow.run(
          row.candidate_id, row.profile_version, row.job_id, row.jd_version,
          row.analysis_model, TARGET, row.absolute_fit, row.criteria_results,
          row.explanation, row.source, row.created_at,
        )
      }
      continue
    }

    searchStats.rescored += 1
    searchStats.downgraded += result.downgraded
    if (result.clamped) searchStats.clamped += 1
    if (searchStats.examples.length < 10) searchStats.examples.push(...result.examples.slice(0, 1))
    searchStats.moved.push(result.after - result.storedFit)

    if (RUN) {
      const next = {
        ...criteria,
        verdicts: result.verdicts,
        coverage: result.coverage,
        needsReview: result.coverage < 50,
      }
      writeRow.run(
        row.candidate_id, row.profile_version, row.job_id, row.jd_version,
        row.analysis_model, TARGET, result.after, JSON.stringify(next),
        row.explanation, row.source, row.created_at,
      )
    }
  }
})

doSearch()

/* ---------------------------------------------------------- the Triage --- */

const applicants = db.prepare(`
  SELECT id, absolute_fit, criteria, scoring_version, extracted_text
  FROM triage_applicants
  WHERE criteria IS NOT NULL AND (scoring_version IS NULL OR scoring_version <> ?)
`).all(TARGET)

const triageStats = {
  seen: applicants.length, rescored: 0, carried: 0, clamped: 0,
  downgraded: 0, moved: [],
}

const writeApplicant = db.prepare(`
  UPDATE triage_applicants SET absolute_fit = ?, criteria = ?, scoring_version = ? WHERE id = ?
`)

const doTriage = db.transaction(() => {
  for (const row of applicants) {
    let criteria = null
    try {
      criteria = JSON.parse(row.criteria)
    } catch {
      criteria = null
    }

    const result = criteria
      ? rescoreOne({ criteria, storedFit: row.absolute_fit, cvText: row.extracted_text })
      : null

    if (!result) {
      triageStats.carried += 1
      /* The version still moves: the row is now under the current scoring
         version even though its number did not change, because the number
         it has is the one this version would produce for it. */
      if (RUN) writeApplicant.run(row.absolute_fit, row.criteria, TARGET, row.id)
      continue
    }

    triageStats.rescored += 1
    triageStats.downgraded += result.downgraded
    if (result.clamped) triageStats.clamped += 1
    triageStats.moved.push(result.after - result.storedFit)

    if (RUN) {
      const next = {
        ...criteria,
        verdicts: result.verdicts,
        coverage: result.coverage,
        needsReview: result.coverage < 50,
      }
      writeApplicant.run(result.after, JSON.stringify(next), TARGET, row.id)
    }
  }
})

doTriage()

/* ------------------------------------------------------------ the report --- */

function movement(moved) {
  if (moved.length === 0) return 'nothing moved'
  const sorted = [...moved].sort((a, b) => a - b)
  const mean = moved.reduce((s, n) => s + n, 0) / moved.length
  return `median ${money(sorted[Math.floor(sorted.length / 2)])}, `
    + `mean ${mean.toFixed(1)}, `
    + `worst ${money(sorted[0])} to ${money(sorted[sorted.length - 1])}`
}

for (const [name, st] of [['SEARCH (candidate_job_analyses)', searchStats], ['TRIAGE (triage_applicants)', triageStats]]) {
  console.log(name)
  console.log(`  rows needing the new version : ${st.seen}`)
  console.log(`  rescored from verdicts       : ${st.rescored}`)
  console.log(`  carried forward unchanged    : ${st.carried}   (no verdicts — scored deterministically)`)
  console.log(`  verdicts downgraded on quote : ${st.downgraded}`)
  if (st.clamped > 0) {
    console.log(`  location nudge approximate   : ${st.clamped}   (the stored value was at 0 or 100, so the nudge could not be recovered exactly)`)
  }
  console.log(`  score movement               : ${movement(st.moved)}`)
  console.log('')
}

if (searchStats.examples.length > 0) {
  console.log('QUOTES THAT WERE NOT IN THE CV (up to ten)')
  for (const ex of searchStats.examples.slice(0, 10)) {
    console.log(`  ${pad(String(ex.requirement).slice(0, 34), 36)} was ${pad(ex.was, 12)} "${String(ex.quote).slice(0, 70)}"`)
  }
  console.log('')
}

if (!RUN) {
  console.log('Dry run — nothing was written and no backup was taken.')
  console.log('  npm run score:migrate -- --run')
  console.log('')
  process.exit(0)
}

const after = db.prepare(
  `SELECT scoring_version AS v, COUNT(*) AS n FROM candidate_job_analyses GROUP BY scoring_version`,
).all()

console.log('ROW COUNTS AFTER')
for (const row of after) {
  console.log(`  candidate_job_analyses v${pad(row.v, 3)} ${padL(row.n, 8)} row(s)`)
}
console.log(`  triage_applicants v${TARGET}        ${padL(
  db.prepare(`SELECT COUNT(*) AS n FROM triage_applicants WHERE scoring_version = ?`).get(TARGET).n, 8,
)} row(s)`)
console.log('')
console.log('To undo: npm run score:migrate -- --revert --run')
console.log('Then set MATCH_V_SCORING=2 and restart.')
console.log('')
