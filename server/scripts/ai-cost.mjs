/**
 * What the AI has actually cost, from the ledger rather than from an estimate.
 *
 *   node server/scripts/ai-cost.mjs            # the last 30 days
 *   node server/scripts/ai-cost.mjs --days 1
 *   node server/scripts/ai-cost.mjs --by stage
 *   node server/scripts/ai-cost.mjs --prefix     # measure the cached prefix
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

/*
 * An empty ledger is reported and everything below still runs.
 *
 * It used to exit here, which made the two sections that do not read this
 * table — the older Triage ledger, and the demo's spend over all of time —
 * unreachable on exactly the machine you would run this on to find out
 * whether anything had been spent at all.
 */
if (rows.length === 0) {
  console.log('  Nothing in ai_cost_events for this window.')
  console.log('  On a machine with no API key that is the correct answer: every')
  console.log('  analysis took the deterministic path and cost nothing.\n')
}

const header = [
  pad('WHERE', 22), pad('MODEL', 22), padLeft('CALLS', 7), padLeft('ITEMS', 7),
  padLeft('IN', 11), padLeft('CACHED', 11), padLeft('OUT', 10),
  padLeft('COST', 11), padLeft('$/ITEM', 9),
].join(' ')

if (rows.length > 0) {
  console.log(header)
  console.log('-'.repeat(header.length))
}

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

if (rows.length > 0) {
  console.log('-'.repeat(header.length))
  console.log([
    pad('TOTAL', 45),
    padLeft('', 7), padLeft(totalItems, 7),
    padLeft('', 11), padLeft('', 11), padLeft('', 10),
    padLeft(money(totalCost), 11),
    padLeft(totalItems > 0 ? money(totalCost / totalItems) : '-', 9),
  ].join(' '))
}

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
  SELECT stage, status, type, SUM(occurrences) AS n, MAX(last_seen) AS last_seen
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

/* ------------------------------------------------- the older Triage ledger --- */

/*
 * triage_cost_events predates ai_cost_events and is still written by the
 * queue, stage by stage. It has no cache split — it was designed before
 * caching existed — so its input figure is everything read, cached or not,
 * and the dollars here are an upper bound rather than a measurement.
 *
 * Kept and reported because it is the only record of what the parse and
 * preliminary stages cost, which ai_cost_events never sees: those stages read
 * a job description once per session rather than once per CV, and leaving
 * them out of the picture makes a Triage look cheaper than it is.
 */
const triageStages = db.prepare(`
  SELECT stage, COALESCE(model, '-') AS model,
         COUNT(*) AS batches,
         COALESCE(SUM(applicants), 0) AS applicants,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(retries), 0) AS retries
  FROM triage_cost_events
  WHERE created_at >= ?
  GROUP BY stage, COALESCE(model, '-')
  ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC
`).all(sinceIso)

if (triageStages.length > 0) {
  console.log('\nTRIAGE, STAGE BY STAGE (triage_cost_events — no cache split in this table)')
  const th = [
    pad('STAGE', 20), pad('MODEL', 20), padLeft('BATCHES', 8), padLeft('CVs', 7),
    padLeft('IN', 11), padLeft('OUT', 10), padLeft('COST', 11), padLeft('$/CV', 9),
  ].join(' ')
  console.log(th)
  console.log('-'.repeat(th.length))

  let triageCost = 0
  let triageCvs = 0

  for (const row of triageStages) {
    /* Priced as though nothing was cached, because this table cannot say
       otherwise. Stated rather than quietly assumed. */
    const cost = costOf({
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    })
    triageCost += cost
    if (row.stage.startsWith('deep')) triageCvs += row.applicants

    console.log([
      pad(row.stage, 20), pad(row.model, 20),
      padLeft(row.batches, 8), padLeft(row.applicants, 7),
      padLeft(row.input_tokens.toLocaleString(), 11),
      padLeft(row.output_tokens.toLocaleString(), 10),
      padLeft(money(cost), 11),
      padLeft(row.applicants > 0 ? money(cost / row.applicants) : '-', 9),
    ].join(' '))
  }

  console.log('-'.repeat(th.length))
  console.log(`  All stages together: ${money(triageCost)}`
    + (triageCvs > 0 ? ` over ${triageCvs} deeply analysed CV(s) — ${money(triageCost / triageCvs)} per CV`
      : ' — no deep analysis in this window'))
  console.log('  Per CV here includes the JD parse and the preliminary pass, which are')
  console.log('  paid once per session rather than once per CV. On a large pile they')
  console.log('  disappear into the average; on a pile of six they are most of it.')
}

/* -------------------------------------------------- the demo, all of time --- */

/*
 * The windowed figure above answers "what is it costing now". This answers
 * "what has it cost", which is the one that decides whether the demo pays for
 * itself — and it is the number nobody could state before.
 */
const demoEver = db.prepare(`
  SELECT COALESCE(model, '-') AS model, COUNT(*) AS calls,
         COALESCE(SUM(items), 0) AS items,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         MIN(created_at) AS first_seen
  FROM ai_cost_events WHERE context = 'demo' GROUP BY COALESCE(model, '-')
`).all()

if (demoEver.length > 0) {
  const spend = demoEver.reduce((sum, row) => sum + costOf({
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheReadTokens: row.cache_read_tokens,
  }), 0)
  const items = demoEver.reduce((sum, row) => sum + row.items, 0)
  const since = demoEver.reduce((at, row) => (at && at < row.first_seen ? at : row.first_seen), null)

  console.log(`\nPUBLIC DEMO, ALL OF TIME`)
  console.log(`  ${money(spend)} over ${items} analyses since ${String(since).slice(0, 10)}`
    + (items > 0 ? ` — ${money(spend / items)} each` : ''))
  for (const row of demoEver) {
    console.log(`    ${pad(row.model, 22)} ${padLeft(row.calls, 6)} call(s), ${row.items} analyses`)
  }
} else {
  console.log('\nPUBLIC DEMO, ALL OF TIME')
  console.log('  Nothing recorded. Either the demo has not run against a key, or it')
  console.log('  ran before the ledger existed.')
}

console.log('')
