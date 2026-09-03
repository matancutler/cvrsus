/**
 * A consistent copy of everything that cannot be rebuilt.
 *
 * Two things, and they must be taken together: the database, and the uploads it
 * names. A backup of one without the other is a set of rows pointing at files
 * that are not in it, which is the failure this codebase has already had once —
 * so this writes both into a single timestamped directory, and refuses to
 * report success unless the pair is intact.
 *
 * The database is copied with SQLite's own online backup API rather than by
 * reading the file. The app runs in WAL mode, so at any instant the .db file is
 * missing whatever is still in .db-wal; `cp` would produce a file that opens
 * fine and is quietly a few transactions behind. `.backup()` takes a snapshot
 * the engine itself considers whole, with the server still serving.
 *
 *   node scripts/backup.mjs [destination]
 *
 * The destination defaults to ./backups, or CKING_BACKUP_DIR when set. Old
 * backups are never deleted — that is a decision about how much history is
 * worth keeping, and it is not one a script run by cron should make.
 */
import fs from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

/* Imported for the paths only, so this honours CKING_DATA_DIR and
   CKING_UPLOAD_DIR exactly as the server does — a backup that guessed where the
   data lives would be right on a laptop and wrong on the live disk. */
const { DATA_DIR, UPLOAD_DIR } = await import('../server/src/db.js')

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const root = process.argv[2] ?? process.env.CKING_BACKUP_DIR ?? path.join(process.cwd(), 'backups')
const out = path.join(root, stamp)

fs.mkdirSync(path.join(out, 'uploads'), { recursive: true })

/* ---------------------------------------------------------------- database */

const source = path.join(DATA_DIR, 'cking.db')
if (!fs.existsSync(source)) {
  console.error(`No database at ${source}. Is CKING_DATA_DIR set the way the server has it?`)
  process.exit(1)
}

const db = new Database(source, { readonly: true })
await db.backup(path.join(out, 'cking.db'))
db.close()

/* ----------------------------------------------------------------- uploads */

let copied = 0
for (const entry of fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })) {
  /* Files only: _swept/ holds what the startup sweep set aside, and a backup is
     for what the product is using. */
  if (!entry.isFile()) continue
  fs.copyFileSync(path.join(UPLOAD_DIR, entry.name), path.join(out, 'uploads', entry.name))
  copied += 1
}

/* ------------------------------------------------------------ and it checks */

/*
 * The point of taking both together is that they agree. This reads the copy —
 * not the live database — and asks whether every file it names is in the copy
 * beside it, which is the only question a restore will care about.
 */
const check = new Database(path.join(out, 'cking.db'), { readonly: true })
const inBackup = new Set(fs.readdirSync(path.join(out, 'uploads')))
const missing = []

for (const [table, column] of [
  ['candidates', 'stored_name'], ['candidates', 'photo_name'],
  ['documents', 'stored_name'], ['recruiters', 'photo_name'],
  ['companies', 'logo_name'], ['triage_applicants', 'stored_name'],
]) {
  const exists = check.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`,
  ).get(table)
  if (!exists) continue

  for (const row of check.prepare(
    `SELECT ${column} AS name FROM ${table} WHERE ${column} IS NOT NULL`,
  ).all()) {
    if (!inBackup.has(row.name)) missing.push(`${table}.${column} → ${row.name}`)
  }
}
check.close()

const size = (p) => fs.statSync(p).size
console.log(`  ${out}`)
console.log(`  database  ${(size(path.join(out, 'cking.db')) / 1e6).toFixed(1)} MB`)
console.log(`  uploads   ${copied} file(s)`)

if (missing.length > 0) {
  /*
   * Not fatal. The backup is still the best copy available and throwing it away
   * would be worse than keeping one with a known hole — but it must not report
   * a clean run, because "the backup succeeded" is the sentence people rely on.
   */
  console.log(`\n  WARNING — ${missing.length} row(s) name a file this backup does not contain:`)
  for (const line of missing.slice(0, 10)) console.log(`    ${line}`)
  if (missing.length > 10) console.log(`    …and ${missing.length - 10} more`)
  console.log('\n  These were already missing on the live disk; the backup did not lose them.')
  process.exit(2)
}

console.log('\n  Every file the database names is in this backup.')
