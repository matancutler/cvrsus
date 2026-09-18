#!/usr/bin/env node
/**
 * The retention rule, run by hand.
 *
 * Dry by default, and dry is the whole point: it prints every CV whose time
 * is up, which session it belongs to and which clock says so, and stops. You
 * read that list, and only then decide whether it is right.
 *
 *   node server/scripts/triage-retention.mjs                 what would go
 *   node server/scripts/triage-retention.mjs --triage 42     just that session
 *   node server/scripts/triage-retention.mjs --triage 42 --run   actually delete
 *
 * `--run` without `--triage` is refused. Not because a whole-database run is
 * wrong in principle, but because the first time this is used it will be on
 * test data, and a missing flag should not be the difference between "seven
 * made-up CVs" and "every CV past its date on the production disk". Pass
 * `--all --run` to mean the whole database, deliberately.
 *
 * There is no undo. Nothing here is recoverable from a backup, because there
 * is no backup.
 */
const { TRIAGE } = await import('../src/triage.js')
const { dueForDeletion, runRetention } = await import('../src/retention.js')

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag) => {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : null
}

const triageId = valueOf('--triage') === null ? null : Number(valueOf('--triage'))
const wantsRun = has('--run')
const wantsAll = has('--all')

const pad = (text, width) => String(text).padEnd(width)

console.log('')
console.log('Cursus — Triage retention')
console.log(`Rule    : ${TRIAGE.retainAfterCloseDays} days after a session closes, `
  + `or ${TRIAGE.retainMaxDays} days after each CV was uploaded, whichever comes first`)
console.log(`Daily   : ${TRIAGE.retentionDeletes ? 'DELETING' : 'log only'} `
  + `(TRIAGE_RETENTION_DELETES=${TRIAGE.retentionDeletes ? '1' : '0'})`)
console.log(`Scope   : ${triageId === null ? 'every session' : `Triage ${triageId}`}`)
console.log('')

const all = dueForDeletion({})
const due = triageId === null ? all : all.filter((row) => row.triageId === triageId)

if (due.length === 0) {
  console.log('Nothing is past its date.\n')
  process.exit(0)
}

console.log(`${due.length} CV(s) are past their date:\n`)
console.log(`  ${pad('CV', 8)}${pad('session', 9)}${pad('uploaded', 12)}${pad('name', 26)}why`)
console.log(`  ${'-'.repeat(76)}`)

for (const row of due.slice(0, 200)) {
  console.log(`  ${pad(`#${row.id}`, 8)}${pad(`#${row.triageId}`, 9)}`
    + `${pad(String(row.uploadedAt ?? '').slice(0, 10), 12)}`
    + `${pad(String(row.name ?? '—').slice(0, 24), 26)}${row.because}`)
}
if (due.length > 200) console.log(`  … and ${due.length - 200} more`)

const sessions = [...new Set(due.map((row) => row.triageId))]
console.log('')
console.log(`Across ${sessions.length} session(s): ${sessions.slice(0, 30).join(', ')}`
  + (sessions.length > 30 ? ` and ${sessions.length - 30} more` : ''))
console.log('')

if (!wantsRun) {
  console.log('Nothing was deleted. Add --run to delete the list above.')
  console.log(`  node server/scripts/triage-retention.mjs${triageId === null ? ' --all' : ` --triage ${triageId}`} --run`)
  console.log('')
  process.exit(0)
}

if (triageId === null && !wantsAll) {
  console.error('Refusing --run over every session without --all.')
  console.error('Scope it with --triage <id>, or say --all --run if you mean the whole database.')
  console.error('')
  process.exit(1)
}

const result = runRetention({ deletes: true, triageId })

console.log(`Deleted ${result.deleted} CV(s) and ${result.filesRemoved} file(s).`)
console.log('The sessions, their counters and their billing lines are untouched.')
console.log('')

/* Counters on the sessions that lost rows, so the workspace does not go on
   reporting CVs that are gone. */
const { recount } = await import('../src/triage.js')
for (const id of result.sessions) recount(id)

console.log(`Recounted ${result.sessions.length} session(s).`)
console.log('')
