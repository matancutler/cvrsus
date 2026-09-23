#!/usr/bin/env node
/**
 * Finds cached analyses that are keyword guesses filed under a model's name.
 *
 *   npm run unpoison                    what is there, and what deleting costs
 *   npm run unpoison -- --since 2026-09-01   narrow to a window
 *   npm run unpoison -- --delete --all  actually delete them
 *   npm run unpoison -- --show          print a line per row
 *
 * `--delete` without `--all` or a `--job` is refused, for the same reason
 * triage-retention refuses it: the first run of anything destructive happens on
 * test data, and a missing flag should not be the difference between "nothing
 * here" and "every analysis this company ever paid for". There is no undo.
 *
 * ---
 *
 * THE DEFECT THIS CLEANS UP AFTER
 *
 * Until the fix on 22 September, a candidate the model never answered for -
 * aborted, timed out, rate-limited, refused, or reached while the Anthropic
 * balance was spent - had their keyword fallback score written into
 * candidate_job_analyses under the real model's name. The cache key is
 * (candidate, job, jd_version, analysis_model, scoring_version), so from then
 * on every search served that keyword guess back as the product's considered
 * judgement. Nothing expires it: there is no TTL, `refresh` is explicitly not a
 * re-analysis, and the migration inserts ON CONFLICT DO NOTHING.
 *
 * The fix stops new ones. It cannot heal old ones, and a later successful
 * analysis does not either - writeCached's ON CONFLICT DO UPDATE cannot change
 * the primary key, so a second, honest row lands beside the poisoned one rather
 * than over it.
 *
 * THE FINGERPRINT, AND WHY IT IS THIS ONE
 *
 *   source <> 'claude' AND analysis_model <> 'deterministic'
 *
 * analysisModel() returns the real model name whenever an API key is present
 * and the pause flag is off - it asks whether a model COULD have answered, not
 * whether one DID. `source` records whether one actually did. An exhausted
 * balance leaves the key present and valid, so the two disagree, and that
 * disagreement is the whole signature.
 *
 * Written as `<> 'deterministic'` rather than `= MATCH_MODEL` deliberately. The
 * public demo judges on Sonnet, and MATCH_MODEL is settable from the
 * environment, so an equality test would miss demo rows today and miss
 * everything after a model switch.
 *
 * Two further markers corroborate, and on a genuinely poisoned row all three
 * agree: the explanation is NULL, because the fallback writes none, while a
 * real answer always carries prose; and the criteria blob holds the
 * deterministic keyword shape - items and breakdown, with no verdicts,
 * coverage or locationNudge. Both are asserted on every row before anything is
 * deleted, and a row where they disagree is printed and kept.
 *
 * WHAT IS NOT IN SCOPE
 *
 * Triage cannot produce this row. It stores its analysis as columns rather than
 * behind a cache key, and both of its fallback paths write model:
 * 'deterministic' beside source: 'deterministic', so the two can never
 * disagree. It has a different problem, which this reports and does not touch:
 * an applicant scored by keywords is left at deep_status 'scored' for ever and
 * no path retries it.
 */
import './env.mjs'
import process from 'node:process'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const value = (f) => {
  const at = argv.indexOf(`--${f}`)
  return at > -1 ? argv[at + 1] : null
}

const DELETE = has('delete')
const ALL = has('all')
const SHOW = has('show')
const SINCE = value('since')
const UNTIL = value('until')
const JOB = value('job') === null ? null : Number(value('job'))

const db = (await import('../src/db.js')).default

/* ------------------------------------------------------------ the search --- */

/*
 * The window narrows; it never selects.
 *
 * created_at on this table means "last written", not "first written" - the
 * ON CONFLICT sets it from the incoming row - and the scoring migration
 * deliberately re-stamps every row it backfills with the time of the migration,
 * so a poisoned row from an outage can carry a date weeks later. The
 * fingerprint is the selector and the dates only ever cut it down.
 */
const where = [`source <> 'claude'`, `analysis_model <> 'deterministic'`]
const binds = []
if (SINCE) { where.push('created_at >= ?'); binds.push(SINCE) }
if (UNTIL) { where.push('created_at <= ?'); binds.push(UNTIL) }
if (JOB !== null) { where.push('job_id = ?'); binds.push(JOB) }

const rows = db.prepare(`
  SELECT candidate_id, profile_version, job_id, jd_version, analysis_model, scoring_version,
         absolute_fit, explanation, criteria_results, source, created_at
  FROM candidate_job_analyses
  WHERE ${where.join(' AND ')}
  ORDER BY created_at
`).all(...binds)

/* Every row is checked against the two corroborating markers. A row that does
   not carry all three is not confidently poison, and it is kept and shown
   rather than quietly swept up with the rest. */
const confident = []
const doubtful = []

for (const row of rows) {
  let blob = null
  try { blob = JSON.parse(row.criteria_results ?? 'null') } catch { blob = null }

  const noVerdicts = !Array.isArray(blob?.verdicts) || blob.verdicts.length === 0
  const noExplanation = row.explanation === null || String(row.explanation).trim() === ''

  const marks = { noVerdicts, noExplanation }
  if (noVerdicts && noExplanation) confident.push({ ...row, marks })
  else doubtful.push({ ...row, marks })
}

/* ------------------------------------------------- what a deletion costs --- */

/*
 * A folder card recovers its score by joining this table, newest row first. If
 * the row being deleted is the last one for that candidate and job, the card
 * loses its number and its reasoning permanently - nothing re-runs that search.
 * Those are the visible casualties and they are counted before anything moves.
 */
const casualties = confident.filter((row) => {
  const survivors = db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_job_analyses
    WHERE candidate_id = ? AND job_id = ? AND jd_version = ?
      AND NOT (source <> 'claude' AND analysis_model <> 'deterministic')
  `).get(row.candidate_id, row.job_id, row.jd_version)

  if (survivors.n > 0) return false

  const filed = db.prepare(`
    SELECT COUNT(*) AS n
    FROM folder_items fi
    JOIN folders f ON f.id = fi.folder_id
    JOIN search_chats sc ON sc.folder_id = f.id
    JOIN jobs j ON j.chat_id = sc.id AND j.id = ?
    WHERE fi.candidate_id = ?
  `).get(row.job_id, row.candidate_id)

  return filed.n > 0
})

/* -------------------------------------------------------- the Triage note --- */

const triageStuck = db.prepare(`
  SELECT COUNT(*) AS n FROM triage_applicants
  WHERE deep_status = 'scored' AND analysis_source = 'deterministic'
`).get().n

const triagePoisoned = db.prepare(`
  SELECT COUNT(*) AS n FROM triage_applicants
  WHERE analysis_source <> 'claude' AND analysis_model <> 'deterministic'
`).get().n

/* ------------------------------------------------------------- reporting --- */

const total = db.prepare(`SELECT COUNT(*) AS n FROM candidate_job_analyses`).get().n

console.log('')
console.log('Keyword scores filed under a model name')
console.log('')
console.log(`  Analyses on this database   : ${total}`)
console.log(`  Matching the fingerprint    : ${rows.length}`)
console.log(`    of those, all three marks : ${confident.length}`)
console.log(`    fingerprint only          : ${doubtful.length}`)
if (SINCE || UNTIL || JOB !== null) {
  console.log(`  Narrowed by                 : ${[
    SINCE && `since ${SINCE}`, UNTIL && `until ${UNTIL}`, JOB !== null && `job ${JOB}`,
  ].filter(Boolean).join(', ')}`)
}
console.log('')

if (SHOW) {
  for (const row of [...confident, ...doubtful]) {
    const marks = `${row.marks.noVerdicts ? 'no-verdicts' : 'HAS-VERDICTS'}`
      + `/${row.marks.noExplanation ? 'no-prose' : 'HAS-PROSE'}`
    console.log(`  candidate ${row.candidate_id} · job ${row.job_id} · v${row.scoring_version}`
      + ` · ${row.analysis_model} · fit ${row.absolute_fit} · ${marks} · ${row.created_at}`)
  }
  console.log('')
}

if (doubtful.length > 0) {
  console.log(`  ${doubtful.length} row(s) carry the model/source disagreement but NOT both`)
  console.log('  corroborating marks. They are never deleted here. Run with --show and')
  console.log('  read them: a row with real verdicts under a model name is more likely a')
  console.log('  genuine analysis whose source column is wrong than a keyword guess.')
  console.log('')
}

if (triagePoisoned > 0) {
  console.log(`  Triage: ${triagePoisoned} row(s) match the same fingerprint, which should be`)
  console.log('  structurally impossible. Investigate before deleting anything.')
  console.log('')
}

/*
 * Reported because it is the defect people will ask about next, and it is not
 * this one. Not touched: unsticking an applicant means clearing its analysis
 * AND lowering the Triage's analysis frontier below its rank in the same
 * transaction, because the frontier only ever moves forward - a deep_status
 * reset on its own is a no-op that looks like a fix.
 */
if (triageStuck > 0) {
  console.log(`  Triage, separately: ${triageStuck} applicant(s) were scored by keywords and`)
  console.log('  are marked scored for ever, because nothing retries a scored applicant.')
  console.log('  That is a different defect with a different fix and this command leaves')
  console.log('  it alone.')
  console.log('')
}

if (confident.length === 0) {
  console.log('  Nothing to delete.')
  console.log('')
  process.exit(0)
}

console.log(`  Deleting would remove ${confident.length} row(s).`)
console.log(`  Of those, ${casualties.length} are the last analysis for a candidate filed in a`)
console.log('  folder whose search produced it, so those cards lose their score and their')
console.log('  reasoning until somebody runs that search again.')
console.log('')
console.log('  Everyone else recovers on the next full search of the job they belong to:')
console.log('  a missing row is a cache miss, and a cache miss asks the model.')
console.log('')

if (!DELETE) {
  console.log('  Read-only. Add --delete --all to remove them. There is no undo.')
  console.log('')
  process.exit(0)
}

if (!ALL && JOB === null) {
  console.error('  --delete needs --all, or a --job to scope it. Refused.')
  console.error('')
  process.exit(1)
}

const remove = db.prepare(`
  DELETE FROM candidate_job_analyses
  WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
    AND analysis_model = ? AND scoring_version = ?
`)

const run = db.transaction((list) => {
  let gone = 0
  for (const row of list) {
    gone += remove.run(
      row.candidate_id, row.profile_version, row.job_id, row.jd_version,
      row.analysis_model, row.scoring_version,
    ).changes
  }
  return gone
})

const deleted = run(confident)

console.log(`  Deleted ${deleted} row(s).`)
console.log('  The next search of each job asks the model about those candidates again.')
console.log('')
