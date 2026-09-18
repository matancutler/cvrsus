#!/usr/bin/env node
/**
 * What is sitting in uploads/_swept, and how to empty it.
 *
 * The boot-time orphan sweep never deletes anything. A file in the uploads
 * directory that no row points at is renamed into _swept/ and left there, on
 * the reasoning that a wrongly-identified orphan is somebody's CV and a wrong
 * guess should cost disk rather than data. That is the right call and it has
 * one consequence nobody has dealt with: nothing ever empties the folder, so
 * it grows forever on a 5 GB disk.
 *
 *   node server/scripts/sweep-quarantine.mjs                what is in there
 *   node server/scripts/sweep-quarantine.mjs --older 30     only the old ones
 *   node server/scripts/sweep-quarantine.mjs --older 30 --run    delete them
 *
 * Dry by default. `--run` requires `--older`, because "everything in the
 * folder" includes whatever the sweep quarantined ten minutes ago, which is
 * exactly the file most likely to have been quarantined by mistake.
 *
 * These files are not referenced by anything — that is what put them here —
 * so deleting them loses no row. But a file the sweep misjudged is a real
 * CV, and once it is gone it is gone.
 */
import fs from 'node:fs'
import path from 'node:path'

const { UPLOAD_DIR } = await import('../src/db.js')

const QUARANTINE = path.join(UPLOAD_DIR, '_swept')

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag) => {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : null
}

const olderDays = valueOf('--older') === null ? null : Number(valueOf('--older'))
const wantsRun = has('--run')

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

console.log('')
console.log('Cursus — quarantined uploads')
console.log(`Folder: ${QUARANTINE}`)
console.log('')

if (!fs.existsSync(QUARANTINE)) {
  console.log('The folder does not exist. Nothing has ever been quarantined.\n')
  process.exit(0)
}

const now = Date.now()
const entries = fs.readdirSync(QUARANTINE)
  .map((name) => {
    const at = path.join(QUARANTINE, name)
    try {
      const stat = fs.statSync(at)
      return stat.isFile() ? { name, at, bytes: stat.size, mtime: stat.mtimeMs } : null
    } catch {
      return null
    }
  })
  .filter(Boolean)

if (entries.length === 0) {
  console.log('The folder is empty.\n')
  process.exit(0)
}

const total = entries.reduce((sum, row) => sum + row.bytes, 0)
console.log(`${entries.length} file(s), ${mb(total)} in total.`)

const oldest = Math.min(...entries.map((row) => row.mtime))
console.log(`Oldest: ${new Date(oldest).toISOString().slice(0, 10)}`)
console.log('')

for (const [label, days] of [['under 30 days', 30], ['30 to 90 days', 90], ['90 days to a year', 365]]) {
  const n = entries.filter((row) => now - row.mtime < days * 86400000).length
  console.log(`  ${String(label).padEnd(20)}: ${n}`)
}
console.log(`  ${'over a year'.padEnd(20)}: ${entries.filter((row) => now - row.mtime >= 365 * 86400000).length}`)
console.log('')

if (olderDays === null) {
  console.log('Nothing was deleted. Add --older <days> to pick a cut-off, then --run to act.')
  console.log('  node server/scripts/sweep-quarantine.mjs --older 90 --run')
  console.log('')
  process.exit(0)
}

const doomed = entries.filter((row) => now - row.mtime >= olderDays * 86400000)
console.log(`${doomed.length} file(s) are older than ${olderDays} days `
  + `(${mb(doomed.reduce((sum, row) => sum + row.bytes, 0))}).`)

if (!wantsRun) {
  console.log('')
  console.log('Nothing was deleted. Add --run to delete those.')
  console.log('')
  process.exit(0)
}

let removed = 0
let freed = 0
for (const row of doomed) {
  try {
    fs.unlinkSync(row.at)
    removed += 1
    freed += row.bytes
  } catch (error) {
    console.warn(`  could not remove ${row.name}: ${error.message}`)
  }
}

console.log('')
console.log(`Deleted ${removed} file(s), ${mb(freed)} freed.`)
console.log('')
