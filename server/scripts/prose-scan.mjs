#!/usr/bin/env node
/**
 * Finds model-written text already in storage that is not language.
 *
 *   npm run prose:scan              what is corrupt, and where
 *   npm run prose:scan -- --repair  replace it with a visible placeholder
 *   npm run prose:scan -- --show    print the offending text (it is not PII,
 *                                   but it is verbose)
 *
 * ---
 *
 * A verdict was stored with its reason set to the word "ok" repeated
 * twenty-one times. The check that would have caught it now runs before
 * anything is written (see matching/prose.js and analyseMatch), but that only
 * protects rows written from now on. Every analysis already on disk was
 * written without it, and a corrupt reason sits on a candidate card until
 * somebody happens to read that row.
 *
 * So this looks at what is there. Read-only by default, because a scan that
 * writes by accident is worse than the problem it was looking for.
 *
 * WHAT IT REPAIRS, AND WHAT IT CANNOT
 *
 * A corrupt reason is replaced by a placeholder that reads as a placeholder.
 * The verdict, the quote and the score are untouched: they were produced by
 * the same call, but they are structured values that either parse or do not,
 * and there is no evidence the arithmetic was affected by prose degenerating.
 * Re-analysing the row would be the thorough answer and costs a model call per
 * candidate per job; that is a decision with a bill attached, so it is not
 * made here. --repair makes the row honest, and re-analysis remains available
 * to anybody who wants to pay for it.
 *
 * strengths and gaps are DERIVED from reason (see deriveHighlights), so a
 * corrupt reason has already been copied into them. Those are recomputed from
 * the repaired verdicts rather than patched, which is what the migration does
 * for the same reason.
 */
import './env.mjs'
import process from 'node:process'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)

const REPAIR = has('repair')
const SHOW = has('show')

const db = (await import('../src/db.js')).default
const { proseProblem, PLACEHOLDER } = await import('../src/matching/prose.js')
const { deriveHighlights } = await import('../src/matching/score.js')

/* Anything that is not language, EXCEPT absence: a verdict with nothing to say
   is not corrupt, and rewriting every silent one would put a line of apology
   on rows that never had a problem. */
const broken = (value, kind) => {
  const problem = proseProblem(value, { kind })
  return problem === null || problem === 'empty' ? null : problem
}

const found = []
const counts = new Map()
const tally = (what) => counts.set(what, (counts.get(what) ?? 0) + 1)

/**
 * One stored analysis blob, checked and optionally repaired.
 *
 * Returns the repaired object when something changed and null when nothing
 * did, so a caller can tell a rewrite from a no-op without comparing JSON.
 */
function inspect({ table, id, blobText, explanation, label }) {
  let blob = null
  try {
    blob = JSON.parse(blobText ?? 'null')
  } catch {
    found.push({ table, id, label, field: 'criteria', problem: 'unparseable JSON', text: '' })
    tally('unparseable JSON')
    return null
  }

  let changed = false

  const explanationProblem = broken(explanation, 'explanation')
  if (explanationProblem) {
    found.push({ table, id, label, field: 'explanation', problem: explanationProblem, text: String(explanation) })
    tally(explanationProblem)
    changed = true
  }

  const verdicts = Array.isArray(blob?.verdicts) ? blob.verdicts : []
  const repairedVerdicts = verdicts.map((row) => {
    const problem = broken(row?.reason, 'reason')
    if (!problem) return row
    found.push({
      table, id, label, field: `verdict ${row?.id ?? '?'} reason`, problem, text: String(row.reason),
    })
    tally(problem)
    changed = true
    return { ...row, reason: PLACEHOLDER.reason }
  })

  if (!changed) return null

  return {
    blob: {
      ...blob,
      verdicts: repairedVerdicts,
      /* Recomputed, not patched: strengths and gaps are derived from reason,
         so a corrupt reason is already inside them. */
      ...(verdicts.length > 0 ? deriveHighlights(repairedVerdicts) : {}),
    },
    explanation: explanationProblem ? PLACEHOLDER.explanation : explanation,
  }
}

console.log('')
console.log('Scanning stored model prose')
console.log('')

/* ------------------------------------------------------------- Search --- */

const searchRows = db.prepare(`
  SELECT candidate_id, profile_version, job_id, jd_version, analysis_model, scoring_version,
         criteria_results, explanation
  FROM candidate_job_analyses
`).all()

const writeSearch = db.prepare(`
  UPDATE candidate_job_analyses SET criteria_results = ?, explanation = ?
  WHERE candidate_id = ? AND profile_version = ? AND job_id = ? AND jd_version = ?
    AND analysis_model = ? AND scoring_version = ?
`)

let searchRepaired = 0
for (const row of searchRows) {
  const fixed = inspect({
    table: 'candidate_job_analyses',
    id: `${row.candidate_id}/${row.job_id}/v${row.scoring_version}`,
    blobText: row.criteria_results,
    explanation: row.explanation,
    label: `candidate ${row.candidate_id}, job ${row.job_id}`,
  })
  if (fixed && REPAIR) {
    writeSearch.run(
      JSON.stringify(fixed.blob), fixed.explanation,
      row.candidate_id, row.profile_version, row.job_id, row.jd_version,
      row.analysis_model, row.scoring_version,
    )
    searchRepaired += 1
  }
}

/* ------------------------------------------------------------- Triage --- */

const triageRows = db.prepare(`
  SELECT id, triage_id, criteria, explanation FROM triage_applicants WHERE criteria IS NOT NULL
`).all()

const writeTriage = db.prepare(
  `UPDATE triage_applicants SET criteria = ?, explanation = ? WHERE id = ?`,
)

let triageRepaired = 0
for (const row of triageRows) {
  const fixed = inspect({
    table: 'triage_applicants',
    id: String(row.id),
    blobText: row.criteria,
    explanation: row.explanation,
    label: `applicant ${row.id}, triage ${row.triage_id}`,
  })
  if (fixed && REPAIR) {
    writeTriage.run(JSON.stringify(fixed.blob), fixed.explanation, row.id)
    triageRepaired += 1
  }
}

/* ------------------------------------------------------------ report --- */

console.log(`Rows read              : ${searchRows.length} Search, ${triageRows.length} Triage`)
console.log(`Corrupt fields found   : ${found.length}`)
console.log('')

if (found.length > 0) {
  console.log('BY KIND')
  for (const [what, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${what}`)
  }
  console.log('')

  console.log('WHERE')
  for (const row of found.slice(0, 40)) {
    console.log(`  ${row.table.padEnd(24)} ${row.label.padEnd(30)} ${row.field.padEnd(26)} ${row.problem}`)
    if (SHOW) console.log(`      ${row.text.slice(0, 140)}`)
  }
  if (found.length > 40) console.log(`  ...and ${found.length - 40} more`)
  console.log('')
}

if (!REPAIR) {
  console.log(found.length === 0
    ? 'Nothing to repair.'
    : 'Read-only. Add --repair to replace these with a visible placeholder.')
  console.log('')
  process.exit(0)
}

console.log(`Repaired ${searchRepaired} Search row(s) and ${triageRepaired} Triage row(s).`)
console.log('The verdict, the quote and the score were not touched - only the prose.')
console.log('Strengths and gaps were recomputed, since they are derived from reason.')
console.log('')
