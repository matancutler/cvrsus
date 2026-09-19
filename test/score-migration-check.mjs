/**
 * The migration that rescores stored analyses without calling a model.
 *
 * Every row on a development machine is `deterministic` — there is no API
 * key, so nothing was ever verdict-scored — which means the interesting
 * path is the one a dry run on this laptop cannot reach. So this suite
 * writes rows that DO carry verdicts, in exactly the shape the analysis
 * pipeline stores them, runs the real script against them, and checks the
 * arithmetic, the nudge recovery, the quote downgrade and the revert.
 *
 * Everything it creates carries one marker and is removed on the way out,
 * including the backup tables the script takes. Nothing it did not create
 * is touched — the assertions are all scoped to its own candidate and job
 * ids, and the cleanup deletes by those ids and by marker, never by "what
 * the query returned".
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import { createReporter } from './helpers.mjs'

const { section, check, finish } = createReporter('Score migration')

const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))
const root = fileURLToPath(new URL('..', import.meta.url))

const RUN = Date.now().toString(36)
/* Far outside anything real, so a stray assertion cannot reach a live row. */
const JOB_ID = 900000 + (Date.now() % 90000)
const CAND_A = JOB_ID + 1
const CAND_B = JOB_ID + 2
const TRIAGE_ID = JOB_ID + 500

const CV_TEXT = 'Served in the personal bureau of senior commanders, managing high-priority '
  + 'schedules and sensitive information flow. Owned the dispute process end-to-end. '
  + 'Ran SQL against the transaction database daily.'

/* The shape analysis.js writes: one entry per requirement, each carrying its
   own tier and weight, which is what makes a rescore possible with no
   requirement list and no model. */
const verdicts = (overrides = {}) => ([
  {
    id: 'r1', requirement: 'card-not-present review', tier: 'must_have', weight: 30,
    status: 'meets', quote: 'managing high-priority schedules', reason: '',
  },
  {
    id: 'r2', requirement: 'chargebacks end to end', tier: 'must_have', weight: 30,
    status: overrides.r2 ?? 'no_evidence',
    quote: overrides.r2 === 'meets' ? 'Owned the dispute process end-to-end' : '',
    reason: '',
  },
  {
    id: 'r3', requirement: 'SQL', tier: 'must_have', weight: 30,
    status: 'meets', quote: 'Ran SQL against the transaction database daily', reason: '',
  },
  {
    /*
     * Contradicted on purpose, and this is the fixture's whole design.
     *
     * The clamp is at 100, and a candidate whose judged verdicts are all
     * `meets` scores exactly 100 before the location nudge is added — so the
     * nudge is clamped away and there is nothing left to test the recovery
     * against. One failed requirement pulls the old fit to 86, which leaves
     * room above it for the nudge to survive and be checked.
     */
    id: 'r4', requirement: 'fraud tooling', tier: 'preferred', weight: 10,
    status: overrides.r4 ?? 'contradicted', quote: overrides.r4quote ?? '', reason: '',
  },
])

/* The pre-change arithmetic, written out independently of the product so the
   fixture's stored fit is what the OLD code would genuinely have produced —
   deriving it from the new code would make the test agree with itself. */
function oldFit(breakdown) {
  const MULT = { meets: 1, partial: 0.6, contradicted: 0 }
  let known = 0
  let earned = 0
  for (const row of breakdown) {
    if (row.status === 'no_evidence') continue
    known += row.weight
    earned += (MULT[row.status] ?? 0) * row.weight
  }
  return known === 0 ? null : Math.round((earned / known) * 100)
}

const NUDGE = 4 // a location bonus, added after the fit and never stored alone

function seedAnalysis(candidateId, breakdown) {
  const fit = Math.max(0, Math.min(100, oldFit(breakdown) + NUDGE))
  db.prepare(`
    INSERT INTO candidate_job_analyses (
      candidate_id, profile_version, job_id, jd_version, analysis_model,
      scoring_version, absolute_fit, criteria_results, explanation, source, created_at
    ) VALUES (?, 1, ?, 1, 'claude-opus-5', '2', ?, ?, ?, 'claude', ?)
  `).run(
    candidateId, JOB_ID, fit,
    JSON.stringify({ verdicts: breakdown, coverage: 50, confidence: 'high', items: [] }),
    `seeded by score-migration-check ${RUN}`,
    new Date().toISOString(),
  )
  return fit
}

function seedCandidate(id, name) {
  db.prepare(`
    INSERT INTO candidates (id, name, first_name, last_name, email, phone, location,
                            file_name, stored_name, file_size, cv_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Tel Aviv', ?, ?, 1, ?, ?)
  `).run(
    id, name, name.split(' ')[0], name.split(' ')[1],
    `migration.${id}.${RUN}@example.com`, `050-9${String(id).slice(-6)}`,
    `${RUN}-${id}.pdf`, `${RUN}-${id}.pdf`,
    CV_TEXT, new Date().toISOString(),
  )
}

/*
 * Scoped to this suite's own job, always.
 *
 * Without --job the script migrates every row on the machine, which is a
 * large blast radius for a test asserting about four of its own — and it
 * left other rows at a version its revert then had to undo. The scope flag
 * exists for this and for a cautious first run against production.
 */
function migrate(...flags) {
  return execFileSync(
    process.execPath,
    ['server/scripts/score-migrate.mjs', '--job', String(JOB_ID), ...flags],
    { cwd: root, encoding: 'utf8' },
  )
}

/* The Triage half, scoped the same way and for the same reason. */
function migrateTriage(...flags) {
  return execFileSync(
    process.execPath,
    ['server/scripts/score-migrate.mjs', '--triage', String(TRIAGE_ID), ...flags],
    { cwd: root, encoding: 'utf8' },
  )
}

/*
 * Which backup tables existed before this suite ran.
 *
 * A real migration leaves its own, and both the assertions and the cleanup
 * have to tell those apart from the ones this test causes — asserting on
 * "any backup exists" is wrong, and dropping every backup would destroy the
 * one thing standing between a bad migration and a restore.
 */
const backupsBefore = new Set(db.prepare(`
  SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_pre_v3_%'
`).all().map((r) => r.name))

const newBackups = () => db.prepare(`
  SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_pre_v3_%'
`).all().map((r) => r.name).filter((n) => !backupsBefore.has(n))

const v3 = (candidateId) => db.prepare(`
  SELECT absolute_fit AS fit, criteria_results AS criteria FROM candidate_job_analyses
  WHERE candidate_id = ? AND job_id = ? AND scoring_version = '3'
`).get(candidateId, JOB_ID)

// ------------------------------------------------------------- the fixture ---

section('Two analyses that differ only in whether the CV said something')

seedCandidate(CAND_A, `SilentA ${RUN}`)
seedCandidate(CAND_B, `EvidenceB ${RUN}`)

/* A: chargebacks unmentioned. B: the same CV with it evidenced. Under the old
   arithmetic A scored HIGHER, which is the bug the change exists to fix. */
/*
 * `partial`, not `meets`. Silence only beat evidence when the evidence was
 * partial: excluding the requirement kept the candidate's average, while
 * paying 0.6 of it dragged the average down. A `meets` would have raised it
 * and the old arithmetic would have been right by accident.
 */
const silentBreakdown = verdicts()
const evidencedBreakdown = verdicts({ r2: 'partial' })

const storedA = seedAnalysis(CAND_A, silentBreakdown)
const storedB = seedAnalysis(CAND_B, evidencedBreakdown)

check('the old arithmetic really did prefer silence', storedA > storedB,
  `silent ${storedA} vs evidenced ${storedB} — this is what is being corrected`)

// ------------------------------------------------------------ the dry run ---

section('A dry run writes nothing')

const before = db.prepare(`SELECT COUNT(*) AS n FROM candidate_job_analyses`).get().n
const dry = migrate()

check('it reports the rows it would rescore', /rescored from verdicts\s*:\s*[1-9]/.test(dry),
  dry.split('\n').find((l) => l.includes('rescored from verdicts'))?.trim())
check('and nothing was written',
  db.prepare(`SELECT COUNT(*) AS n FROM candidate_job_analyses`).get().n === before)
check('and no backup was taken', newBackups().length === 0,
  'a dry run that left tables behind would not be a dry run')

// --------------------------------------------------------------- the run ---

section('The migration')

const out = migrate('--run')

check('a backup was taken of both tables',
  newBackups().some((n) => n.startsWith('candidate_job_analyses_pre_v3_'))
  && newBackups().some((n) => n.startsWith('triage_applicants_pre_v3_')),
  newBackups().join(', ') || 'none created by this run')

check('the version-2 rows are untouched',
  db.prepare(`
    SELECT absolute_fit AS fit FROM candidate_job_analyses
    WHERE candidate_id = ? AND job_id = ? AND scoring_version = '2'
  `).get(CAND_A, JOB_ID).fit === storedA,
  'additive, so reverting is a setting rather than a restore')

const a3 = v3(CAND_A)
const b3 = v3(CAND_B)

check('both got a version-3 row', Boolean(a3) && Boolean(b3))

check('evidence now beats silence', b3.fit > a3.fit,
  `silent ${a3.fit} vs evidenced ${b3.fit} — it was ${storedA} vs ${storedB}`)

/*
 * The nudge is the whole of the difference between the stored number and
 * what the verdicts alone produce. If it were dropped, every migrated score
 * would be wrong by it — silently, and in the same direction.
 */
/*
 * The nudge recovery, which is the part that silently breaks everything if
 * it is wrong: the location bonus was added after the fit and never stored
 * on its own, so it is recovered by subtracting the old fit from the stored
 * number. Drop it and every migrated score is wrong by it, in the same
 * direction, with nothing on screen to say so.
 */
const newFitOf = (breakdown) => {
  const SILENCE = 0.35
  const MULT = { meets: 1, partial: 0.6, contradicted: 0 }
  let total = 0
  let earned = 0
  for (const row of breakdown) {
    total += row.weight
    earned += (row.status === 'no_evidence' ? SILENCE : (MULT[row.status] ?? 0)) * row.weight
  }
  return Math.round((earned / total) * 100)
}

check('the fixture sits clear of the clamp, so there is a nudge to recover',
  storedA < 100 && storedB < 100, `${storedA} and ${storedB}`)

check('the new number is the new arithmetic plus the original nudge',
  a3.fit === newFitOf(silentBreakdown) + NUDGE,
  `expected ${newFitOf(silentBreakdown)} + ${NUDGE}, got ${a3.fit}`)
check('and the same for the evidenced one',
  b3.fit === newFitOf(evidencedBreakdown) + NUDGE,
  `expected ${newFitOf(evidencedBreakdown)} + ${NUDGE}, got ${b3.fit}`)

check('coverage was recomputed and stored',
  Number.isFinite(JSON.parse(a3.criteria).coverage),
  String(JSON.parse(a3.criteria).coverage))

// ------------------------------------------------ Search is NOT checked ---

section('A Search quote is deliberately left alone')

/*
 * This is a refusal, not an omission, and it is the most damaging thing the
 * adversarial review caught.
 *
 * The model was not shown candidates.cv_text. It was shown a redacted
 * dossier: the CV with the candidate's name, email and phone replaced by
 * [redacted], and their profile summary and employment history pasted on
 * the front. Checking a stored quote against cv_text therefore fails for
 * reasons that have nothing to do with whether the model invented anything.
 * A candidate called Lee has every "Leeds" in their CV rewritten to
 * "[redacted]ds" in the text they were quoted from; the quote is honest and
 * the lookup still misses. Run over the whole table that downgrades correct
 * verdicts wholesale, and it damages hardest the rows with the most
 * evidence in them.
 *
 * So Search quotes are checked at ANALYSIS time, in ai.js, against the
 * exact string the model was handed - and the migration, which no longer
 * has that string, does not guess.
 */

const CAND_C = JOB_ID + 3
seedCandidate(CAND_C, `Invented ${RUN}`)
const invented = verdicts({ r4: 'meets', r4quote: 'led a team of forty engineers in Berlin' })
const storedC = seedAnalysis(CAND_C, invented)

migrate('--run')
const c3 = v3(CAND_C)
const cVerdicts = JSON.parse(c3.criteria).verdicts

check('the invented quote survives the migration untouched',
  cVerdicts.find((row) => row.id === 'r4').status === 'meets',
  'not because the quote is real, but because this script cannot tell')
check('and nothing was flagged on the way past',
  cVerdicts.every((row) => row.quoteUnverified === undefined))

const migrateSource = readFileSync(
  fileURLToPath(new URL('../server/scripts/score-migrate.mjs', import.meta.url)), 'utf8')
const aiSource = readFileSync(
  fileURLToPath(new URL('../server/src/ai.js', import.meta.url)), 'utf8')

check('the Search half says so out loud', /checkTheQuotes: false/.test(migrateSource))
check('and names the reason, so nobody turns it on again',
  /redacted dossier/.test(migrateSource))
check('while the live path checks against what the model was actually shown',
  /const shown = dossier\(/.test(aiSource)
  && /checkQuotes\(answer\.criteria, shown\)/.test(aiSource),
  'ai.js is the only place that still holds that string')

check('the score still moved, on the silence rule rather than the quote',
  c3.fit < storedC, `${storedC} -> ${c3.fit}`)

// ------------------------------------------------------------- the revert ---

section('Reverting')

migrate('--revert', '--run')

check('the version-3 rows are gone',
  !v3(CAND_A) && !v3(CAND_B) && !v3(CAND_C))
check('and the version-2 rows are exactly as they were',
  db.prepare(`
    SELECT absolute_fit AS fit FROM candidate_job_analyses
    WHERE candidate_id = ? AND job_id = ? AND scoring_version = '2'
  `).get(CAND_A, JOB_ID).fit === storedA,
  'they were never touched, which is the point of doing it additively')

// -------------------------------------------------- Triage IS checked ---

section('A Triage quote that is not in the CV is downgraded')

/*
 * Triage is checked, because triageQueue passes the applicant as
 * { id, display_name, location, cv_text: extracted_text } with no name,
 * email or phone for the dossier to redact - so the string the model quoted
 * from is, character for character, the string this reads back.
 *
 * Placed after the revert on purpose: --revert undoes the most recent
 * un-reverted run whatever its scope, so a Triage run started before the
 * Search revert would be the one that revert undid.
 */
const stamp = new Date().toISOString()

db.prepare(`
  INSERT INTO triages (id, company_id, recruiter_id, title, raw_jd, status,
                       lifecycle, ledger_id, charged_cvs, created_at, updated_at)
  VALUES (?, ?, NULL, ?, 'seeded', 'completed', 'closed', NULL, 1, ?, ?)
`).run(TRIAGE_ID, TRIAGE_ID, `score-migration-check ${RUN}`, stamp, stamp)

const triageVerdicts = verdicts({ r4: 'meets', r4quote: 'led a team of forty engineers in Berlin' })
const triageStored = oldFit(triageVerdicts)

const applicantId = Number(db.prepare(`
  INSERT INTO triage_applicants (
    triage_id, file_name, stored_name, parse_status, deep_status,
    absolute_fit, criteria, scoring_version, extracted_text, created_at
  ) VALUES (?, ?, ?, 'parsed', 'scored', ?, ?, '2', ?, ?)
`).run(
  TRIAGE_ID, `${RUN}-triage.pdf`, `${RUN}-triage.pdf`, triageStored,
  JSON.stringify({ verdicts: triageVerdicts, coverage: 50, confidence: 'high', items: [] }),
  CV_TEXT, stamp,
).lastInsertRowid)

const triageOut = migrateTriage('--run')

check('the migration reports the downgrade',
  /verdicts downgraded on quote\s*:\s*[1-9]/.test(triageOut),
  triageOut.split('\n').filter((l) => l.includes('downgraded on quote')).join(' / ').trim())

const applicant = () => db.prepare(
  `SELECT absolute_fit AS fit, criteria, scoring_version AS v FROM triage_applicants WHERE id = ?`,
).get(applicantId)

const afterRow = applicant()
const afterCriteria = JSON.parse(afterRow.criteria)
const r4 = afterCriteria.verdicts.find((row) => row.id === 'r4')

check('the unsupported verdict became no_evidence', r4.status === 'no_evidence',
  `${r4.status} - "led a team of forty engineers in Berlin" is nowhere in the CV`)
check('and it kept the quote, flagged, so somebody can look at it',
  r4.quoteUnverified === true && r4.quote.length > 0)
check('while the supported verdicts were left alone',
  afterCriteria.verdicts.find((row) => row.id === 'r3').status === 'meets',
  'the CV really does say "Ran SQL against the transaction database daily"')
check('so the score is lower than it was', afterRow.fit < triageStored,
  `${triageStored} -> ${afterRow.fit}`)
check('the row moved to the new version', afterRow.v === '3')
check('and the highlights were recomputed, not carried',
  Array.isArray(afterCriteria.strengths)
  && !afterCriteria.strengths.some((line) => /fraud tooling/i.test(line)),
  'carrying them would leave a requirement under Strengths whose only evidence '
  + 'this same run had just thrown out')

section('Reverting the Triage run')

migrateTriage('--revert', '--run')

const restored = applicant()
check('the applicant is back at version 2', restored.v === '2')
check('with its original score', restored.fit === triageStored,
  `${restored.fit} vs ${triageStored}`)
check('and its original verdicts, invented quote and all',
  JSON.parse(restored.criteria).verdicts.find((row) => row.id === 'r4').status === 'meets',
  'a revert that improved the data would not be a revert')

// ---------------------------------------------------------------- cleanup ---

section('Cleanup')

db.prepare(`DELETE FROM candidate_job_analyses WHERE job_id = ?`).run(JOB_ID)
db.prepare(`DELETE FROM triage_applicants WHERE triage_id = ?`).run(TRIAGE_ID)
db.prepare(`DELETE FROM triages WHERE id = ?`).run(TRIAGE_ID)
for (const id of [CAND_A, CAND_B, CAND_C]) {
  db.prepare(`DELETE FROM candidates WHERE id = ? AND email LIKE ?`).run(id, `%${RUN}@example.com`)
}

/*
 * Only the backups this run caused.
 *
 * Dropping every table matching the pattern would destroy the backup a real
 * migration took — the one thing standing between a bad migration and a
 * restore — because a test cleaning up is not a reason to delete somebody
 * else's safety net.
 */
for (const name of newBackups()) {
  db.prepare(`DROP TABLE IF EXISTS ${name}`).run()
}

check('test data removed',
  db.prepare(`SELECT COUNT(*) AS n FROM candidate_job_analyses WHERE job_id = ?`).get(JOB_ID).n === 0
  && db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE email LIKE ?`)
    .get(`%${RUN}@example.com`).n === 0
  && db.prepare(`SELECT COUNT(*) AS n FROM triages WHERE id = ?`).get(TRIAGE_ID).n === 0
  && db.prepare(`SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ?`)
    .get(TRIAGE_ID).n === 0
  && newBackups().length === 0)

db.close()
finish()
