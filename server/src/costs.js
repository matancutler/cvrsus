/**
 * What the model calls cost, recorded as they happen and priced in one place.
 *
 * Three things needed this module and none of them could be done without it:
 *
 *   1. Nobody could say what a search cost. Triage wrote per-batch telemetry;
 *      Search and the public demo wrote nothing, so the only record of either
 *      was the invoice at the end of the month.
 *   2. Prompt caching makes a single `input_tokens` figure unpriceable — a
 *      cached read is a tenth of the base price and a cache write is 1.25x it,
 *      so the same token count can differ tenfold in money. The savings had to
 *      be provable, not asserted.
 *   3. A daily ceiling needs a running total to compare against, and the total
 *      has to survive a restart, which means it lives in the database.
 *
 * Prices are per million tokens, from the published Claude pricing on
 * 16 September 2026. They are stated here rather than fetched: a wrong price
 * shows up as a wrong report, which is recoverable, while a report that blocks
 * on a network call is a report nobody runs.
 */
import db from './db.js'

/** Per million tokens. `cacheWrite` is the 5-minute TTL; `cacheRead` the hit. */
export const PRICES = {
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  /* Fable and Mythos read cache at 2.5% rather than 10%. Here for completeness;
     nothing in the product uses them. */
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  /* The keyless path. Recorded like everything else so the reports show how
     much of the work never reached a model at all. */
  deterministic: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
}

/** An unknown model is priced as Opus, the most expensive thing we run. */
const FALLBACK = PRICES['claude-opus-5']

export function priceOf(model) {
  return PRICES[model] ?? (model === 'deterministic' ? PRICES.deterministic : FALLBACK)
}

/** Dollars for one usage record. */
export function costOf({ model, inputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0, outputTokens = 0 }) {
  const price = priceOf(model)
  return (
    (inputTokens * price.input)
    + (cacheWriteTokens * price.cacheWrite)
    + (cacheReadTokens * price.cacheRead)
    + (outputTokens * price.output)
  ) / 1_000_000
}

/**
 * Writes one line of the ledger.
 *
 * Swallows its own errors for the same reason the Triage telemetry does:
 * losing a cost row is a nuisance, losing a recruiter's search because a
 * telemetry insert failed is not a trade worth making.
 */
export function recordCost({
  context, stage, model, companyId = null, calls = 1, items = 0,
  inputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0, outputTokens = 0,
  durationMs = null,
}) {
  try {
    db.prepare(`
      INSERT INTO ai_cost_events (
        context, stage, model, company_id, calls, items,
        input_tokens, cache_write_tokens, cache_read_tokens, output_tokens,
        duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context, stage, model, companyId, calls, items,
      Math.round(inputTokens ?? 0), Math.round(cacheWriteTokens ?? 0),
      Math.round(cacheReadTokens ?? 0), Math.round(outputTokens ?? 0),
      durationMs, new Date().toISOString(),
    )
  } catch { /* telemetry is never worth failing the work it measures */ }
}

/** Adds up a set of per-call usages into the shape recordCost takes. */
export function sumUsage(usages) {
  const total = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0 }
  for (const usage of usages) {
    if (!usage) continue
    total.calls += 1
    total.inputTokens += usage.inputTokens ?? 0
    total.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    total.cacheReadTokens += usage.cacheReadTokens ?? 0
    total.outputTokens += usage.outputTokens ?? 0
  }
  return total
}

/**
 * A rolling window rather than a calendar day, deliberately.
 *
 * A calendar cap resets at a boundary somebody has to choose a timezone for,
 * and it lets a whole day's allowance be spent twice either side of midnight.
 * A rolling 24 hours has neither problem and needs no timezone at all.
 */
const DAY_MS = 24 * 60 * 60 * 1000

function since(ms) {
  return new Date(Date.now() - ms).toISOString()
}

/** How many items (CVs, candidates) one context has analysed in the window. */
export function itemsInWindow({ context, companyId = undefined, windowMs = DAY_MS }) {
  const where = ['created_at >= ?', 'context = ?']
  const args = [since(windowMs), context]

  if (companyId !== undefined) {
    where.push(companyId === null ? 'company_id IS NULL' : 'company_id = ?')
    if (companyId !== null) args.push(companyId)
  }

  return db.prepare(`
    SELECT COALESCE(SUM(items), 0) AS n FROM ai_cost_events WHERE ${where.join(' AND ')}
  `).get(...args).n
}

/** The same window, in money, for every context at once. */
export function spendInWindow({ windowMs = DAY_MS } = {}) {
  return db.prepare(`
    SELECT context, model,
           SUM(calls) AS calls, SUM(items) AS items,
           SUM(input_tokens) AS input_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens,
           SUM(output_tokens) AS output_tokens
    FROM ai_cost_events WHERE created_at >= ?
    GROUP BY context, model
  `).all(since(windowMs)).map((row) => ({
    ...row,
    cost: costOf({
      model: row.model,
      inputTokens: row.input_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      cacheReadTokens: row.cache_read_tokens,
      outputTokens: row.output_tokens,
    }),
  }))
}

/** The whole ledger, grouped, for the reporting script. */
export function costReport({ sinceIso = null, groupBy = 'context' } = {}) {
  const column = { context: 'context', stage: 'stage', model: 'model', day: 'substr(created_at, 1, 10)' }[groupBy]
  if (!column) throw new Error(`cannot group cost by ${groupBy}`)

  const rows = db.prepare(`
    SELECT ${column} AS bucket, model,
           SUM(calls) AS calls, SUM(items) AS items,
           SUM(input_tokens) AS input_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens,
           SUM(output_tokens) AS output_tokens,
           MIN(created_at) AS first_at, MAX(created_at) AS last_at
    FROM ai_cost_events
    ${sinceIso ? 'WHERE created_at >= ?' : ''}
    GROUP BY bucket, model
    ORDER BY bucket
  `).all(...(sinceIso ? [sinceIso] : []))

  return rows.map((row) => ({
    ...row,
    cost: costOf({
      model: row.model,
      inputTokens: row.input_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      cacheReadTokens: row.cache_read_tokens,
      outputTokens: row.output_tokens,
    }),
  }))
}
