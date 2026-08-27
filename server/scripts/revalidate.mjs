#!/usr/bin/env node
/**
 * §6.3 — the six-month profile freshness sweep, run by hand.
 *
 *   node server/scripts/revalidate.mjs              (dry run — shows the plan)
 *   node server/scripts/revalidate.mjs --run        (do it)
 *   node server/scripts/revalidate.mjs --run --limit 100
 *
 * Not on a timer. Rebuilding costs money on candidates' behalf, so turning it
 * into a nightly job should be a decision somebody makes, not a default they
 * inherit. When you do want that, call runRevalidation() from a scheduler —
 * it is idempotent and safe to run more often than the cycle.
 *
 * Dry run is the default for the same reason.
 */
import db from '../src/db.js'
import { MATCHING } from '../src/matching/config.js'
import { runRevalidation } from '../src/matching/revalidation.js'

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')).map((a) => a.slice(2)))
const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 500

const dryRun = !flags.has('run')
const result = runRevalidation({ limit, dryRun })

console.log(`\n  Six-month freshness cycle (${MATCHING.freshnessMonths} months)`)
console.log(`  ${result.due} profile(s) due.\n`)

if (result.due === 0) {
  console.log('  Nothing to do.\n')
} else if (dryRun) {
  console.log(`  Would rebuild ${result.wouldRebuild}, reset the clock on ${result.wouldTouch}.\n`)
  for (const plan of result.plans.slice(0, 25)) {
    console.log(`    ${String(plan.candidateId).padEnd(6)} ${plan.rebuild ? 'rebuild' : 'skip   '}  ${plan.reason}`)
  }
  if (result.plans.length > 25) console.log(`    … and ${result.plans.length - 25} more`)
  console.log('\n  Nothing was changed. Re-run with --run to apply.\n')
} else {
  console.log(`  Rebuilt ${result.rebuilt}, reset the clock on ${result.touched}.`)
  if (result.failures.length > 0) {
    console.log(`\n  ${result.failures.length} failed and will be retried next cycle:`)
    for (const failure of result.failures) console.log(`    ${failure.candidateId}: ${failure.error}`)
  }
  console.log('')
}

db.close()
