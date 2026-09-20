#!/usr/bin/env node
/**
 * Creates candidate profiles from the CVs in eval-material/cvs, through the
 * same steps an upload runs.
 *
 *   npm run seed:candidates                 what it would create, and the cost
 *   npm run seed:candidates -- --run        do it
 *   npm run seed:candidates -- --remove     delete the ones it created
 *
 * ---
 *
 * WHY THIS EXISTS
 *
 * Retrieval cannot be tested against nothing. The recall test, the search
 * pipeline and the ranking all need candidates whose CVs are real documents —
 * a fixture carrying a hundred characters of placeholder produces a profile
 * with no skills, no history and no concepts, and every candidate then ranks
 * identically because there is nothing to tell them apart.
 *
 * THE DATA IS REAL, SO THIS IS LOCAL ONLY
 *
 * The CVs in eval-material carry real names, phone numbers and email
 * addresses. eval-material is gitignored and so is server/data, which is what
 * makes putting them in a development database acceptable. This script
 * refuses to run against the production data directory, because "seed some
 * candidates" is exactly the command somebody runs in the wrong shell.
 *
 * WHAT IT RUNS
 *
 * The real steps, in the real order: extraction on the configured model, then
 * the taxonomy intelligence that retrieval actually reads, then the
 * embedding. Not a hand-written row — a hand-written row would have no
 * concepts and no vector, so it would be invisible to two thirds of the
 * retrieval blend and the test built on it would measure the third that was
 * left.
 *
 * Everything it creates is marked, so --remove can take back exactly what it
 * added and nothing else.
 */
import './env.mjs'
import process from 'node:process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)

const RUN = has('run')
const REMOVE = has('remove')

const here = path.dirname(fileURLToPath(import.meta.url))
const CVS = path.join(here, '..', '..', 'eval-material', 'cvs')

/* The marker every seeded row carries. Contact details come from the CV, so
   this cannot live in the email — it lives in a column nothing else writes. */
const MARKER = 'seeded from eval-material'

/*
 * Refused against the production disk, whatever else is set.
 *
 * Render mounts its disk at /data and points CKING_DATA_DIR there. A seeding
 * script that put five named individuals into the live candidate table would
 * be visible to every recruiter on the platform, and no flag on this command
 * would have looked like it was about to do that.
 */
const dataDir = process.env.CKING_DATA_DIR ?? ''
if (/^\/data(\/|$)/.test(dataDir)) {
  console.error(`\nCKING_DATA_DIR is ${dataDir}, which is the production disk.`)
  console.error('This seeds real people into the candidate table and is for a laptop only.\n')
  process.exit(1)
}

const db = (await import('../src/db.js')).default
const { insertCandidate, getCandidate } = await import('../src/db.js')
const { extractProfileFields, isConfigured } = await import('../src/ai.js')
const { saveExtraction, effectiveProfile } = await import('../src/profiles.js')
const { buildIntelligence } = await import('../src/matching/intelligence.js')
const { priceOf } = await import('../src/costs.js')

if (REMOVE) {
  const rows = db.prepare(`SELECT id, name FROM candidates WHERE notes = ?`).all(MARKER)
  if (rows.length === 0) {
    console.log('\nNothing seeded by this script is in the database.\n')
    process.exit(0)
  }
  console.log('')
  for (const row of rows) console.log(`  would remove ${row.id}  ${row.name}`)
  if (!RUN) {
    console.log('\nDry run. Add --run to delete them.\n')
    process.exit(0)
  }
  const { deleteCandidateCompletely } = await import('../src/profiles.js')
  for (const row of rows) {
    deleteCandidateCompletely(row.id)
    console.log(`  removed ${row.id}`)
  }
  console.log('')
  process.exit(0)
}

if (!fs.existsSync(CVS)) {
  console.error(`\nNo CVs at ${CVS}.\n`)
  process.exit(1)
}

const files = fs.readdirSync(CVS).filter((n) => n.endsWith('.txt'))

/*
 * The contact block, read off the document rather than asked of a model.
 *
 * Extraction deliberately does not return a name, an email or a phone — the
 * schema has no field for them, because the model is shown a redacted
 * document. An upload gets them from the form the candidate filled in. There
 * is no form here, so they come from the CV, and a regex is the honest tool:
 * it either finds the string or it does not, and a wrong guess is visible
 * rather than plausible.
 */
function contactFrom(text, fallbackName) {
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0] ?? null
  const phone = text.match(/\+?\d[\d\s().-]{8,}\d/)?.[0]?.trim() ?? null

  /* The name is the first line that is a name: CVs put it at the top, in
     capitals as often as not, and never with a digit or an at-sign in it. */
  const name = text.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 3 && line.length < 48
      && !/[@\d|]/.test(line) && /^[\p{L} .'-]+$/u.test(line))
    ?? fallbackName

  const location = text.match(/\b(Tel[- ]Aviv|Herzliya|Hertzeliya|Jerusalem|Haifa|Ramat Gan|Bnei[- ]Brak|Kiryat Gat)\b/i)?.[0]
    ?? null

  return {
    name: name.replace(/\s+/g, ' ').trim(),
    email,
    phone,
    location,
  }
}

const planned = files.map((file) => {
  const text = fs.readFileSync(path.join(CVS, file), 'utf8')
  const fallback = file.replace(/\.txt$/, '').split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
  return { file, text, ...contactFrom(text, fallback) }
})

const existing = new Set(
  db.prepare(`SELECT email FROM candidates WHERE email IS NOT NULL`).all().map((r) => String(r.email).toLowerCase()),
)
const todo = planned.filter((row) => !row.email || !existing.has(row.email.toLowerCase()))

const price = priceOf(process.env.MATCH_MODEL ?? 'claude-opus-5')
const tokens = planned.reduce((sum, row) => sum + Math.ceil(row.text.length / 4), 0)
const estimate = (tokens * price.input + todo.length * 900 * price.output) / 1_000_000

console.log('')
console.log('Seed candidates from eval-material/cvs')
console.log(`CVs found            : ${planned.length}`)
console.log(`Already in the table : ${planned.length - todo.length}`)
console.log(`Would create         : ${todo.length}`)
console.log(`Estimated cost       : $${estimate.toFixed(3)}   (extraction, plus an embedding each)`)
console.log('')

for (const row of planned) {
  console.log(`  ${row.file.padEnd(24)} ${String(row.name).padEnd(20)} ${String(row.location ?? '-').padEnd(12)} `
    + `${row.email ? 'email ok' : 'NO EMAIL'}  ${row.phone ? 'phone ok' : 'no phone'}`)
}
console.log('')

if (todo.length === 0) {
  console.log('Nothing to create.\n')
  process.exit(0)
}

if (!RUN) {
  console.log('Dry run - nothing was written and no model was called.')
  console.log('  npm run seed:candidates -- --run')
  console.log('')
  process.exit(0)
}

if (!isConfigured()) {
  console.error('No ANTHROPIC_API_KEY, so a CV cannot be read into a profile.\n')
  process.exit(1)
}

let made = 0
for (const row of todo) {
  const id = insertCandidate({
    name: row.name,
    first_name: null,
    middle_name: null,
    last_name: null,
    email: row.email,
    phone: row.phone,
    location: row.location,
    /* insertStmt binds every column by name, so each one has to be present
       even when it is null — a missing key is a RangeError, not a default. */
    years_experience: null,
    current_title: null,
    desired_role: null,
    photo_name: null,
    detected_years: null,
    availability: 'Immediately',
    /* The marker, in the one column nothing else in the product writes for a
       candidate created this way. */
    notes: MARKER,
    file_name: row.file.replace(/\.txt$/, '.pdf'),
    stored_name: `seed-${row.file}`,
    file_size: row.text.length,
    cv_text: row.text,
    skills: [],
    links: [],
    created_at: new Date().toISOString(),
  })

  const extraction = await extractProfileFields(row.text)
  saveExtraction(id, extraction)
  /* The taxonomy labels retrieval actually reads. index.js wraps this in
     runIntelligence() to swallow failures behind a warning; here a failure
     should stop the seed, because a candidate with no labels is invisible to
     the concept half of the blend and would quietly skew anything measured
     against them. */
  buildIntelligence(id)

  const candidate = getCandidate(id)
  const profile = effectiveProfile(id)
  console.log(`  ${String(id).padStart(6)}  ${row.name.padEnd(20)} `
    + `${String(profile?.current_title ?? '(no title)').slice(0, 28).padEnd(30)}`
    + `${(profile?.skills ?? []).length} skills, `
    + `${(profile?.inferredCapabilities ?? []).length} inferred, `
    + `${db.prepare(`SELECT COUNT(*) n FROM candidate_taxonomy_labels WHERE candidate_id = ?`).get(id).n} labels`)
  made += 1
  void candidate
}

console.log('')
console.log(`Created ${made} candidate(s). Remove them again with:`)
console.log('  npm run seed:candidates -- --remove --run')
console.log('')
