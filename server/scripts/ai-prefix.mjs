#!/usr/bin/env node
/**
 * How big the cached prefix actually is.
 *
 *   node server/scripts/ai-prefix.mjs
 *   node server/scripts/ai-prefix.mjs --jd eval-material/jobs/ops.txt --cv eval-material/cvs/x.txt
 *
 * The saving from prompt caching is a ratio: the cached prefix is written
 * once at 1.25x and read back at 0.1x for every candidate after the first,
 * while the candidate block is paid in full every time. So the prefix's share
 * of the request IS the saving, and nobody could state it — the estimates in
 * the cost review were derived from character counts, which are not tokens.
 *
 * This asks the provider. One countTokens call, which is free and does not
 * run the model, measured three ways:
 *
 *   the system block            — the instructions, identical for every call
 *   the system + job block      — everything before the candidate: the prefix
 *   the whole request           — plus one real candidate
 *
 * The difference between the second and third is what is paid per CV at full
 * price. Everything below it is paid once.
 *
 * Read-only, spends nothing, and needs ANTHROPIC_API_KEY only because
 * countTokens is an API call. On a machine without one it says so and stops.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\nNo ANTHROPIC_API_KEY. countTokens is an API call, so this cannot run here.')
  console.error('Run it in the Render shell on the cursus service.\n')
  process.exit(1)
}

const { default: Anthropic } = await import('@anthropic-ai/sdk')
const ai = await import('../src/ai.js')

const root = path.resolve(path.join(import.meta.dirname, '../..'))
const first = (dir, fallbackText) => {
  const at = path.join(root, dir)
  if (!fs.existsSync(at)) return { name: '(built-in sample)', text: fallbackText }
  const file = fs.readdirSync(at).find((n) => n.endsWith('.txt') || n.endsWith('.md'))
  return file
    ? { name: `${dir}/${file}`, text: fs.readFileSync(path.join(at, file), 'utf8') }
    : { name: '(built-in sample)', text: fallbackText }
}

const SAMPLE_JD = `Head of Operations & People

This role is the operational backbone of a venture capital fund: keeping the
internal stack, HR processes and external service providers running while
producing high-visibility portfolio and ecosystem events.

Requirements:
- 4+ years in operations, chief of staff or business management
- Owning repeatable processes: hiring, onboarding, budget tracking, vendors
- Running events end to end for senior external audiences
- Hebrew and English, written and spoken

Nice to have:
- Worked across multiple sites or jurisdictions
- Comfortable in a small team with little structure
`

const SAMPLE_CV = `A. Candidate
Tel Aviv | example@example.com

Operations Manager, 2020-2025
- Owned hiring and onboarding for a team of thirty across two countries.
- Tracked budget against forecast and managed a dozen external suppliers.
- Ran the company's annual customer conference for two hundred guests.
Languages: Hebrew (native), English (fluent)
`

const jdArg = flag('jd')
const cvArg = flag('cv')

const jd = jdArg
  ? { name: jdArg, text: fs.readFileSync(path.resolve(root, jdArg), 'utf8') }
  : first('eval-material/jobs', SAMPLE_JD)
const cv = cvArg
  ? { name: cvArg, text: fs.readFileSync(path.resolve(root, cvArg), 'utf8') }
  : first('eval-material/cvs', SAMPLE_CV)

const model = process.env.MATCH_MODEL ?? ai.MODEL

/*
 * The same three pieces analyseMatch assembles, in the same order.
 *
 * Reconstructed here rather than exported from ai.js, because what is being
 * measured is the SHAPE of the request and an exported helper would drift
 * from the real one without anything noticing. If this stops matching
 * analyseMatch, the number stops meaning anything — which is why the file it
 * mirrors is named in the output.
 */
const system = ai.MATCH_SYSTEM_TEXT ?? null
if (!system) {
  console.error('\nai.js does not export MATCH_SYSTEM_TEXT, so the system block cannot be')
  console.error('measured separately. Export it and run this again.\n')
  process.exit(1)
}

const shared = `Assess this candidate against the role.\n\n`
  + `<role>\n${jd.text}\n</role>\n\n`

const candidate = `<candidate>\n${cv.text}\n</candidate>`

const client = new Anthropic()

async function count(label, blocks, sys) {
  const result = await client.messages.countTokens({
    model,
    ...(sys ? { system: sys } : {}),
    messages: [{ role: 'user', content: blocks }],
  })
  return { label, tokens: result.input_tokens }
}

console.log('')
console.log('Cursus — how big the cached prefix is')
console.log(`Model : ${model}`)
console.log(`Job   : ${jd.name}`)
console.log(`CV    : ${cv.name}`)
console.log('Shape mirrors analyseMatch in server/src/ai.js — if that changes, change this.')
console.log('')

/* A request needs a message, so the system block is measured against the
   smallest possible one and that one token subtracted back out. */
const floor = await count('floor', [{ type: 'text', text: '.' }], undefined)
const sysOnly = await count('system', [{ type: 'text', text: '.' }], [{ type: 'text', text: system }])
const prefix = await count('prefix', [{ type: 'text', text: shared }], [{ type: 'text', text: system }])
const whole = await count('whole', [
  { type: 'text', text: shared },
  { type: 'text', text: candidate },
], [{ type: 'text', text: system }])

const systemTokens = sysOnly.tokens - floor.tokens
const jobTokens = prefix.tokens - sysOnly.tokens
const cvTokens = whole.tokens - prefix.tokens
const prefixTokens = prefix.tokens

const pad = (v, w) => String(v).padEnd(w)
const padL = (v, w) => String(v).padStart(w)

console.log(`  ${pad('instructions (system)', 28)}${padL(systemTokens.toLocaleString(), 9)} tokens`)
console.log(`  ${pad('job description block', 28)}${padL(jobTokens.toLocaleString(), 9)} tokens`)
console.log(`  ${'-'.repeat(37)}`)
console.log(`  ${pad('CACHED PREFIX', 28)}${padL(prefixTokens.toLocaleString(), 9)} tokens`)
console.log(`  ${pad('candidate (paid every call)', 28)}${padL(cvTokens.toLocaleString(), 9)} tokens`)
console.log(`  ${'-'.repeat(37)}`)
console.log(`  ${pad('whole request', 28)}${padL(whole.tokens.toLocaleString(), 9)} tokens`)
console.log('')

const share = Math.round((prefixTokens / whole.tokens) * 100)
console.log(`  The prefix is ${share}% of the request.`)

/*
 * What that is worth, at the real prices, over a batch.
 *
 * Written out rather than left as a ratio because the decision it informs —
 * whether caching is worth the complexity, and how much a bigger batch is
 * worth — is a decision about money.
 */
const { PRICES } = await import('../src/costs.js')
const price = PRICES[model] ?? PRICES['claude-opus-5']

for (const batch of [8, 25, 50]) {
  const uncached = batch * whole.tokens * price.input
  const cached = (prefixTokens * price.cacheWrite)
    + ((batch - 1) * prefixTokens * price.cacheRead)
    + (batch * cvTokens * price.input)
  const saved = Math.round(((uncached - cached) / uncached) * 100)
  console.log(`  A batch of ${String(batch).padStart(2)}: `
    + `$${(uncached / 1e6).toFixed(4)} uncached vs $${(cached / 1e6).toFixed(4)} cached `
    + `— ${saved}% off the input side`)
}

console.log('')
console.log('  Input only. Thinking and the answer are output tokens and are not')
console.log('  cacheable, so the saving on a whole call is smaller than these.')
console.log('')
