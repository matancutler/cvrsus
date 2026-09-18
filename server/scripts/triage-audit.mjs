/**
 * What is actually in the live database, before anything is migrated.
 *
 *   node server/scripts/triage-audit.mjs
 *
 * READ ONLY. It opens the database in SQLite's readonly mode, so it cannot
 * write even by accident — a stray UPDATE in here would throw rather than run.
 * It takes no arguments, deletes nothing, and changes nothing on disk.
 *
 * Run it on the machine that holds the live database. On Render that is the
 * shell on the service itself, where CKING_DATA_DIR points at the persistent
 * disk; a laptop copy of the repo has its own empty database and will tell you
 * nothing about production.
 *
 * Why it exists: the rolling-Triage migration has to decide what happens to
 * every Triage that already exists, and that decision depends on how many there
 * are, what state they are in, how many CVs they hold and how much disk those
 * CVs take. None of that is knowable from the code.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import Database from 'better-sqlite3'

/* The same two paths the server uses, resolved the same way, so this reads the
   database the product actually writes rather than a copy. */
const DATA_DIR = process.env.CKING_DATA_DIR ?? path.resolve(process.cwd(), 'server/data')
const UPLOAD_DIR = process.env.CKING_UPLOAD_DIR ?? path.resolve(process.cwd(), 'server/uploads')
const DB_PATH = path.join(DATA_DIR, 'cking.db')

if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}.`)
  console.error('Set CKING_DATA_DIR to the directory holding cking.db and run again.')
  process.exit(1)
}

/* readonly: true is the guarantee, not the comment. */
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

const rows = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const has = (table) => Boolean(one(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, table))

const mb = (bytes) => `${(Number(bytes ?? 0) / 1024 / 1024).toFixed(1)} MB`
const pad = (value, width) => String(value ?? '').padEnd(width)
const num = (value, width) => String(value ?? 0).padStart(width)

console.log(`\nCursus — Triage audit`)
console.log(`Database: ${DB_PATH}`)
console.log(`Uploads:  ${UPLOAD_DIR}`)
console.log(`Read at:  ${new Date().toISOString()}\n`)

/* ------------------------------------------------------- launched or not --- */

const totals = one(`
  SELECT COUNT(*) AS all_rows,
         SUM(CASE WHEN ledger_id IS NOT NULL THEN 1 ELSE 0 END) AS launched,
         SUM(CASE WHEN ledger_id IS NULL THEN 1 ELSE 0 END) AS drafts
  FROM triages
`)

console.log('SESSIONS')
console.log(`  launched (real, charged sessions) : ${totals.launched ?? 0}`)
console.log(`  drafts (never started)            : ${totals.drafts ?? 0}`)
console.log(`  total rows                        : ${totals.all_rows ?? 0}`)

console.log('\nLAUNCHED SESSIONS BY STATUS')
const byStatus = rows(`
  SELECT status,
         COUNT(*) AS sessions,
         COALESCE(SUM(total_files), 0) AS files,
         COALESCE(SUM(analysed_files), 0) AS analysed,
         COALESCE(SUM(charged_cvs), 0) AS charged,
         COALESCE(SUM(refunded_cvs), 0) AS refunded,
         MIN(created_at) AS oldest
  FROM triages WHERE ledger_id IS NOT NULL
  GROUP BY status ORDER BY sessions DESC
`)

if (byStatus.length === 0) {
  console.log('  none')
} else {
  console.log(`  ${pad('STATUS', 12)} ${num('SESSIONS', 8)} ${num('FILES', 8)} ${num('ANALYSED', 9)} ${num('CHARGED', 8)} ${num('REFUND', 7)}  OLDEST`)
  for (const row of byStatus) {
    console.log(
      `  ${pad(row.status, 12)} ${num(row.sessions, 8)} ${num(row.files, 8)} `
      + `${num(row.analysed, 9)} ${num(row.charged, 8)} ${num(row.refunded, 7)}  ${String(row.oldest ?? '').slice(0, 10)}`,
    )
  }
}

const drafts = one(`
  SELECT COUNT(*) AS n,
         SUM(CASE WHEN EXISTS (SELECT 1 FROM triage_applicants a WHERE a.triage_id = t.id) THEN 1 ELSE 0 END) AS with_files
  FROM triages t WHERE t.ledger_id IS NULL
`)
console.log(`\n  drafts holding at least one file: ${drafts.with_files ?? 0} of ${drafts.n ?? 0}`)

/* ------------------------------------------------------------- applicants --- */

const applicants = one(`
  SELECT COUNT(*) AS rows,
         COALESCE(SUM(file_size), 0) AS bytes,
         COALESCE(SUM(LENGTH(COALESCE(extracted_text, ''))), 0) AS text_chars,
         SUM(CASE WHEN deep_status = 'scored' THEN 1 ELSE 0 END) AS scored,
         SUM(CASE WHEN deep_status = 'failed' THEN 1 ELSE 0 END) AS failed_analysis,
         SUM(CASE WHEN parse_status IN ('unreadable', 'failed') THEN 1 ELSE 0 END) AS unreadable,
         SUM(CASE WHEN email IS NOT NULL AND TRIM(email) <> '' THEN 1 ELSE 0 END) AS with_email,
         MIN(created_at) AS oldest,
         MAX(created_at) AS newest
  FROM triage_applicants
`)

console.log('\nAPPLICANT CVs (rows in triage_applicants)')
console.log(`  rows                    : ${applicants.rows ?? 0}`)
console.log(`  stored bytes (recorded) : ${mb(applicants.bytes)}`)
console.log(`  extracted text          : ${((applicants.text_chars ?? 0) / 1_000_000).toFixed(1)} million characters`)
console.log(`  scored                  : ${applicants.scored ?? 0}`)
console.log(`  analysis failed         : ${applicants.failed_analysis ?? 0}`)
console.log(`  unreadable at parse     : ${applicants.unreadable ?? 0}`)
console.log(`  carry an email address  : ${applicants.with_email ?? 0}  (matters for the duplicate-person rule)`)
console.log(`  oldest upload           : ${String(applicants.oldest ?? '—').slice(0, 10)}`)
console.log(`  newest upload           : ${String(applicants.newest ?? '—').slice(0, 10)}`)

/*
 * Charged for and never read.
 *
 * The rule is that a recruiter pays per CV uploaded, so these are not refunds
 * owed — but the size of the number is worth knowing, because it is the gap
 * between what somebody bought and what the product actually did for them. A
 * CV counts here when its session was charged, the file was readable, and no
 * analysis was ever run on it.
 */
const neverRead = one(`
  SELECT COUNT(*) AS n FROM triage_applicants a
  JOIN triages t ON t.id = a.triage_id
  WHERE t.ledger_id IS NOT NULL
    AND a.parse_status = 'parsed'
    AND a.deep_status <> 'scored'
`).n

const neverReadSessions = one(`
  SELECT COUNT(DISTINCT a.triage_id) AS n FROM triage_applicants a
  JOIN triages t ON t.id = a.triage_id
  WHERE t.ledger_id IS NOT NULL
    AND a.parse_status = 'parsed'
    AND a.deep_status <> 'scored'
`).n

console.log('\nCHARGED BUT NEVER ANALYSED')
console.log(`  CVs      : ${neverRead}`)
console.log(`  sessions : ${neverReadSessions}`)
console.log('  (readable CVs in a charged session that no analysis ever ran on —')
console.log('   the recruiter paid per CV uploaded, so nothing is owed back, but')
console.log('   this is the distance between what was bought and what was done)')

console.log('\nAGE OF STORED CVs (the retention rule bites here)')
for (const [label, days] of [['under 90 days', 90], ['90 days to 6 months', 182], ['6 to 12 months', 365]]) {
  const n = one(
    `SELECT COUNT(*) AS n FROM triage_applicants WHERE created_at >= datetime('now', ?)`,
    `-${days} days`,
  ).n
  console.log(`  ${pad(label, 22)}: ${n}`)
}
const overYear = one(
  `SELECT COUNT(*) AS n FROM triage_applicants WHERE created_at < datetime('now', '-365 days')`,
).n
console.log(`  ${pad('over 12 months', 22)}: ${overYear}   <-- would be deleted by the first retention run`)

/* ------------------------------------------------------------- the files --- */

console.log('\nFILES ON DISK')
let present = 0
let missing = 0
let bytesOnDisk = 0

const stored = rows(`SELECT stored_name FROM triage_applicants WHERE stored_name IS NOT NULL`)
for (const row of stored) {
  const at = path.join(UPLOAD_DIR, row.stored_name)
  try {
    bytesOnDisk += fs.statSync(at).size
    present += 1
  } catch {
    missing += 1
  }
}

console.log(`  files found            : ${present}`)
console.log(`  size on disk           : ${mb(bytesOnDisk)}`)
console.log(`  rows with NO file      : ${missing}${missing > 0 ? '   <-- see plan 4.3, the upload bug' : ''}`)

const sweptDir = path.join(UPLOAD_DIR, '_swept')
if (fs.existsSync(sweptDir)) {
  let sweptBytes = 0
  let sweptCount = 0
  for (const name of fs.readdirSync(sweptDir)) {
    try {
      sweptBytes += fs.statSync(path.join(sweptDir, name)).size
      sweptCount += 1
    } catch { /* a file that vanished between readdir and stat is not our problem */ }
  }
  console.log(`  quarantined in _swept  : ${sweptCount} files, ${mb(sweptBytes)}  (nothing ever empties this)`)
}

/* --------------------------------------------------------------- spread --- */

console.log('\nSPREAD ACROSS ORGANIZATIONS')
const perCompany = rows(`
  SELECT t.company_id, COUNT(*) AS sessions, COALESCE(SUM(t.total_files), 0) AS files
  FROM triages t WHERE t.ledger_id IS NOT NULL
  GROUP BY t.company_id ORDER BY sessions DESC LIMIT 10
`)

if (perCompany.length === 0) {
  console.log('  none')
} else {
  console.log(`  ${pad('COMPANY', 10)} ${num('SESSIONS', 9)} ${num('CVs', 8)}`)
  for (const row of perCompany) {
    console.log(`  ${pad(row.company_id, 10)} ${num(row.sessions, 9)} ${num(row.files, 8)}`)
  }
}

/* Deliveries, once rolling sessions exist. Skipped on a database that predates
   them, rather than failing — this script has to run on production as it is. */
if (has('triage_drops')) {
  const drops = one(`
    SELECT COUNT(*) AS n,
           COUNT(DISTINCT triage_id) AS sessions,
           MAX(seq) AS most
    FROM triage_drops
  `)
  console.log('\nDELIVERIES')
  console.log(`  drops recorded : ${drops.n ?? 0} across ${drops.sessions ?? 0} session(s)`)
  console.log(`  most in one    : ${drops.most ?? 0}`)
}

console.log('\nEDGE CASES FOR THE MIGRATION')
const failed = one(`SELECT COUNT(*) AS n FROM triages WHERE ledger_id IS NOT NULL AND status = 'failed'`).n
const unfinished = one(`
  SELECT COUNT(*) AS n FROM triages
  WHERE ledger_id IS NOT NULL AND status IN ('processing', 'ready')
`).n
const halfState = one(`
  SELECT COUNT(*) AS n FROM triages WHERE ledger_id IS NULL AND status = 'processing'
`).n

console.log(`  launched but failed        : ${failed}`)
console.log(`  launched and not finished  : ${unfinished}   (mid-analysis when the migration runs)`)
console.log(`  un-launched but processing : ${halfState}${halfState > 0 ? '   <-- the failed-launch bug, now fixed' : ''}`)

console.log('\nNothing was written. Send this output back and the migration will be written to it.\n')

db.close()
