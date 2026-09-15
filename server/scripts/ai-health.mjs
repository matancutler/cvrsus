/**
 * Is the AI layer actually running?
 *
 * Written because the honest answer was "nobody knows". Every model call in
 * this product falls back when it fails — correctly, since a recruiter who
 * loses a shortlist to one timeout is worse off than one who gets a cruder
 * ranking — and for a long time each fallback was announced only in a log
 * line. The product could lose its whole reasoning layer and still look like it
 * was working: a plausible percentage, a small grey chip, no error.
 *
 * Three separate diagnoses of a failing Triage were attempted from the outside
 * and all three were wrong. This script is what should have existed instead.
 *
 *   node server/scripts/ai-health.mjs
 */
import db from '../src/db.js'
import { isConfigured as aiConfigured, MODEL } from '../src/ai.js'
import { isConfigured as embeddingsConfigured, EMBEDDING_MODEL } from '../src/embeddings.js'

const pct = (part, total) => (total === 0 ? '—' : `${Math.round((part / total) * 100)}%`)

const rule = (label) => {
  console.log('')
  console.log(`  ${label}`)
  console.log(`  ${'─'.repeat(Math.max(label.length, 48))}`)
}

/* ----------------------------------------------------------- configured -- */

rule('Keys')
console.log(`    ANTHROPIC_API_KEY  ${aiConfigured() ? `set — ${MODEL}` : 'NOT SET — every AI path falls back'}`)
console.log(`    VOYAGE_API_KEY     ${embeddingsConfigured() ? `set — ${EMBEDDING_MODEL}` : 'NOT SET — semantic retrieval is off'}`)

/* ------------------------------------------------- is the work being done -- */

rule('CV extraction — did Claude read the CV, or did the regex?')
const extraction = db.prepare(
  `SELECT source, COUNT(*) AS n FROM extracted_profiles GROUP BY source ORDER BY n DESC`,
).all()
const extractionTotal = extraction.reduce((sum, r) => sum + r.n, 0)
if (extractionTotal === 0) console.log('    no profiles extracted yet')
for (const row of extraction) {
  console.log(`    ${String(row.source).padEnd(16)} ${String(row.n).padStart(5)}  ${pct(row.n, extractionTotal)}`)
}

rule('Triage analysis — did the matcher run, or the keyword fallback?')
const triage = db.prepare(`
  SELECT COALESCE(analysis_source, 'not analysed') AS source, COUNT(*) AS n
  FROM triage_applicants GROUP BY source ORDER BY n DESC
`).all()
const triageTotal = triage.reduce((sum, r) => sum + r.n, 0)
if (triageTotal === 0) console.log('    no applicants analysed yet')
for (const row of triage) {
  console.log(`    ${String(row.source).padEnd(16)} ${String(row.n).padStart(5)}  ${pct(row.n, triageTotal)}`)
}

rule('Search analysis — same question, marketplace side')
const search = db.prepare(
  `SELECT source, COUNT(*) AS n FROM candidate_job_analyses GROUP BY source ORDER BY n DESC`,
).all()
const searchTotal = search.reduce((sum, r) => sum + r.n, 0)
if (searchTotal === 0) console.log('    no searches analysed yet')
for (const row of search) {
  console.log(`    ${String(row.source).padEnd(16)} ${String(row.n).padStart(5)}  ${pct(row.n, searchTotal)}`)
}

rule('Embeddings — how many candidates can be retrieved semantically?')
const candidates = db.prepare(`SELECT COUNT(*) AS n FROM candidates`).get().n
const embedded = db.prepare(`SELECT COUNT(*) AS n FROM embeddings`).get().n
console.log(`    ${String(embedded).padStart(5)} of ${candidates} candidates  ${pct(embedded, candidates)}`)

/* ------------------------------------------------------------- and why -- */

rule('Why calls failed')
const failures = db.prepare(`
  SELECT stage, status, type, message, occurrences, last_seen
  FROM ai_failures ORDER BY last_seen DESC LIMIT 15
`).all()

if (failures.length === 0) {
  console.log('    nothing recorded.')
  console.log('    If a fallback shows above but nothing here, those calls predate this table —')
  console.log('    run one Triage or Search and look again.')
}
for (const f of failures) {
  console.log(`    ${f.last_seen.slice(0, 16).replace('T', ' ')}  ${String(f.stage).padEnd(20)} ×${f.occurrences}`)
  console.log(`        ${f.status ?? '—'} ${f.type}`)
  console.log(`        ${f.message}`)
}

/* ---------------------------------------------------------- the verdict -- */

rule('Verdict')
const aiTriage = triage.find((r) => r.source === 'claude')?.n ?? 0
const aiSearch = search.find((r) => r.source === 'claude')?.n ?? 0
const analysed = triageTotal + searchTotal

if (!aiConfigured()) {
  console.log('    No Anthropic key. Everything is running on keyword matching.')
} else if (analysed === 0) {
  console.log('    Key is set, but nothing has been analysed yet. Run a Triage or a Search.')
} else if (aiTriage + aiSearch === 0) {
  console.log('    The key is set and NOT ONE analysis used it. Read the failures above —')
  console.log('    every score this product has shown came from keyword matching.')
} else {
  console.log(`    ${aiTriage + aiSearch} of ${analysed} analyses used ${MODEL} (${pct(aiTriage + aiSearch, analysed)}).`)
  if (aiTriage + aiSearch < analysed) console.log('    The remainder fell back — see above for why.')
}
console.log('')

db.close()
