/**
 * What the AI has actually cost, from the ledger rather than from an estimate.
 *
 *   node server/scripts/ai-cost.mjs            # the last 30 days
 *   node server/scripts/ai-cost.mjs --days 1
 *   node server/scripts/ai-cost.mjs --by stage
 *
 * Read-only. Run it on the machine holding the live database — on Render, that
 * is the shell on the service, not this laptop, which has no API key and has
 * therefore never spent anything.
 *
 * The number that matters is the last column: dollars per item, where an item
 * is one CV read against one job description. Every plan to make this cheaper
 * is a plan to move that number, and before this script existed nobody could
 * say what it was.
 */
import process from 'node:process'

import { costOf, costReport } from '../src/costs.js'
import db from '../src/db.js'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}

const days = Number(flag('days', 30))
const groupBy = String(flag('by', 'context'))
const sinceIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

const money = (value) => `$${value.toFixed(value < 1 ? 4 : 2)}`
const pad = (value, width) => String(value ?? '').padEnd(width)
const padLeft = (value, width) => String(value ?? '').padStart(width)

console.log(`\nCursus — what the model calls cost, last ${days} day${days === 1 ? '' : 's'}`)
console.log(`Grouped by ${groupBy}. Prices from costs.js.\n`)

const rows = costReport({ sinceIso, groupBy })

if (rows.length === 0) {
  console.log('  Nothing recorded in this window.')
  console.log('  On a machine with no API key that is the correct answer: every')
  console.log('  analysis took the deterministic path and cost nothing.\n')
  process.exit(0)
}

const header = [
  pad('WHERE', 22), pad('MODEL', 22), padLeft('CALLS', 7), padLeft('ITEMS', 7),
  padLeft('IN', 11), padLeft('CACHED', 11), padLeft('OUT', 10),
  padLeft('COST', 11), padLeft('$/ITEM', 9),
].join(' ')

console.log(header)
console.log('-'.repeat(header.length))

let totalCost = 0
let totalItems = 0
let totalCacheRead = 0
let totalInput = 0

for (const row of rows) {
  totalCost += row.cost
  totalItems += row.items
  totalCacheRead += row.cache_read_tokens
  totalInput += row.input_tokens + row.cache_write_tokens + row.cache_read_tokens

  console.log([
    pad(row.bucket, 22),
    pad(row.model, 22),
    padLeft(row.calls, 7),
    padLeft(row.items, 7),
    padLeft((row.input_tokens + row.cache_write_tokens).toLocaleString(), 11),
    padLeft(row.cache_read_tokens.toLocaleString(), 11),
    padLeft(row.output_tokens.toLocaleString(), 10),
    padLeft(money(row.cost), 11),
    padLeft(row.items > 0 ? money(row.cost / row.items) : '-', 9),
  ].join(' '))
}

console.log('-'.repeat(header.length))
console.log([
  pad('TOTAL', 45),
  padLeft('', 7), padLeft(totalItems, 7),
  padLeft('', 11), padLeft('', 11), padLeft('', 10),
  padLeft(money(totalCost), 11),
  padLeft(totalItems > 0 ? money(totalCost / totalItems) : '-', 9),
].join(' '))

/*
 * How much of the reading was cached, which is the whole point of the caching
 * work and the one number an estimate cannot give you.
 */
if (totalInput > 0) {
  const share = Math.round((totalCacheRead / totalInput) * 100)
  console.log(`\nCache: ${share}% of everything read came from the cache at a tenth of the price.`)
  if (share < 30) {
    console.log('  Below about half is worth looking at: it usually means batches of one,')
    console.log('  or a prompt that changes between calls and so cannot be reused.')
  }
}

/*
 * What the model could not do, beside what it cost. A month where the spend
 * halved because every other call was failing is not a saving, and the two
 * numbers are only honest together.
 */
const failures = db.prepare(`
  SELECT stage, status, type, SUM(count) AS n, MAX(last_seen) AS last_seen
  FROM ai_failures WHERE last_seen >= ? GROUP BY stage, status, type ORDER BY n DESC LIMIT 8
`).all(sinceIso)

if (failures.length > 0) {
  console.log('\nFallbacks in the same window (see npm run ai:health for the full report):')
  for (const row of failures) {
    console.log(`  ${pad(row.stage, 22)} ${padLeft(row.n, 5)} × ${row.status ?? '-'} ${row.type}`)
  }
}

/*
 * The public demo, called out on its own.
 *
 * It is the only surface with no account behind it: anyone on the internet can
 * start one, and until the daily ceiling existed nothing bounded what that
 * could add up to. Worth seeing separately from the money recruiters spend.
 */
const demo = rows.filter((row) => row.bucket === 'demo' || row.stage === 'demo')
if (demo.length > 0 && groupBy === 'context') {
  const spend = demo.reduce((sum, row) => sum + row.cost, 0)
  const items = demo.reduce((sum, row) => sum + row.items, 0)
  console.log(`\nPublic demo: ${money(spend)} over ${items} analyses — strangers, not customers.`)
}

/*
 * What is not in this table.
 *
 * Nothing recorded a search before the ledger existed, so a window reaching
 * back further than that is not a complete account of what was spent — the
 * Console's usage page is. Said out loud rather than left for somebody to
 * discover from a suspiciously small number.
 */
const earliest = db.prepare(`SELECT MIN(created_at) AS at FROM ai_cost_events`).get()?.at
if (earliest && earliest > sinceIso) {
  console.log(`\nNote: this ledger starts at ${earliest}. Anything spent before that`)
  console.log('is only in the Console usage page — Search recorded nothing until then.')
}

console.log('')
