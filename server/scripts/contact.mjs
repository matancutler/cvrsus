#!/usr/bin/env node
/**
 * Enquiries from the public contact page.
 *
 *   node server/scripts/contact.mjs                    the 20 most recent
 *   node server/scripts/contact.mjs list --limit 50
 *   node server/scripts/contact.mjs list --all         including test-suite noise
 *   node server/scripts/contact.mjs show <id>          one message in full
 *   node server/scripts/contact.mjs purge-tests --yes  delete the suite's rows
 *
 * Why this exists: the contact form stores every message and prints one line to
 * the server console. Nothing read them back. A console line scrolls away —
 * and `node --watch` wipes the terminal on every restart — so a real enquiry
 * could sit in the database for months with nobody aware it had arrived.
 *
 * Until a mail provider is wired into notify.js this is the inbox. Run it.
 */
import db from '../src/db.js'

const [command = 'list', ...rest] = process.argv.slice(2)
const flags = new Map()
const args = []

for (let i = 0; i < rest.length; i += 1) {
  if (rest[i].startsWith('--')) {
    const key = rest[i].slice(2)
    const next = rest[i + 1]
    if (next && !next.startsWith('--')) { flags.set(key, next); i += 1 } else flags.set(key, true)
  } else args.push(rest[i])
}

const fail = (message) => { console.error(`\n  ${message}\n`); process.exit(1) }

/*
 * The test suites post to /api/contact and their rows outnumber the real ones
 * by a hundred to one. Hidden by default rather than deleted: they are evidence
 * of what ran, and a reader that quietly drops rows is a reader you cannot
 * trust when a real message goes missing.
 */
const TEST_ROWS = `(email LIKE '%@example.com' OR email LIKE '%cking-%')`

function list() {
  const limit = Number(flags.get('limit') ?? 20)
  const where = flags.get('all') ? '' : `WHERE NOT ${TEST_ROWS}`

  const rows = db.prepare(`
    SELECT id, name, email, reason, message, created_at
    FROM contact_messages ${where}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(limit)

  const hidden = flags.get('all')
    ? 0
    : db.prepare(`SELECT COUNT(*) AS n FROM contact_messages WHERE ${TEST_ROWS}`).get().n

  if (rows.length === 0) {
    console.log('\n  No messages.\n')
    if (hidden) console.log(`  (${hidden} test-suite row(s) hidden — pass --all to include them.)\n`)
    return
  }

  console.log('')
  for (const row of rows) {
    const when = new Date(row.created_at).toLocaleString()
    console.log(`  #${row.id}  ${when}`)
    console.log(`  ${row.name} <${row.email}>${row.reason ? `  ·  ${row.reason}` : ''}`)
    // One line here; `show` prints the whole thing. A list that dumps five
    // thousand characters per row is not a list.
    const preview = row.message.replace(/\s+/g, ' ').trim()
    console.log(`  ${preview.length > 100 ? `${preview.slice(0, 100)}…` : preview}`)
    console.log('')
  }

  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM contact_messages ${where}`,
  ).get().n

  console.log(`  ${rows.length} of ${total} shown.`)
  if (hidden) console.log(`  ${hidden} test-suite row(s) hidden — pass --all to include them.`)
  console.log('')
}

function show() {
  const id = Number(args[0])
  if (!Number.isInteger(id)) fail('Which message? Pass an id from the list.')

  const row = db.prepare(`SELECT * FROM contact_messages WHERE id = ?`).get(id)
  if (!row) fail(`No message with id ${id}.`)

  console.log('')
  console.log(`  #${row.id}   ${new Date(row.created_at).toLocaleString()}`)
  console.log(`  From:   ${row.name} <${row.email}>`)
  if (row.reason) console.log(`  About:  ${row.reason}`)
  console.log('')
  console.log(row.message.split('\n').map((line) => `  ${line}`).join('\n'))
  console.log('')
  console.log(`  Reply to: ${row.email}`)
  console.log('')
}

/** The suites leave rows behind on every run. This is the broom. */
function purgeTests() {
  const doomed = db.prepare(`SELECT COUNT(*) AS n FROM contact_messages WHERE ${TEST_ROWS}`).get().n

  if (!flags.get('yes')) {
    console.log(`\n  Would delete ${doomed} test-suite message(s). Re-run with --yes to do it.\n`)
    return
  }

  db.prepare(`DELETE FROM contact_messages WHERE ${TEST_ROWS}`).run()
  console.log(`\n  Deleted ${doomed} test-suite message(s).\n`)
}

const commands = { list, show, 'purge-tests': purgeTests }
const run = commands[command]
if (!run) fail(`Unknown command "${command}". Try: list, show, purge-tests`)
run()
