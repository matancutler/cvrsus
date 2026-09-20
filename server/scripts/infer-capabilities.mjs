#!/usr/bin/env node
/**
 * C2 backfill — adds an inferred-capabilities list to profiles extracted
 * before the field existed.
 *
 *   npm run infer:backfill                  what it would do, and what it costs
 *   npm run infer:backfill -- --run         do it
 *   npm run infer:backfill -- --limit 50    a first tranche, to read the output
 *   npm run infer:backfill -- --redo        include profiles that already have one
 *
 * ---
 *
 * WHY A SEPARATE SCRIPT RATHER THAN RE-EXTRACTION
 *
 * Re-running extraction would produce the field, and would cost about five
 * times as much for nothing: extraction reads the whole CV on Opus and
 * rewrites every field, of which one is new. This asks the cheapest model one
 * question about a CV it already has, which is what C2 specifies and what the
 * arithmetic supports.
 *
 * It also cannot lose a correction. Re-extraction overwrites the stored
 * fields, and a candidate who fixed their own job title would have the fix
 * silently replaced by whatever the model read this time. This merges one key
 * into the stored object and touches nothing else.
 *
 * ---
 *
 * WHAT AN INFERRED CAPABILITY IS FOR
 *
 * Retrieval, and only retrieval. A skills list is what somebody thought to
 * write down, and most people write down a handful; the work they describe
 * implies a great deal more. Somebody who ran a finance team's month-end close
 * for six years knows reconciliation and variance analysis and will not have
 * listed either, so a search for those words never reaches them.
 *
 * It is never evidence. The judgement prompt is told an inference is a
 * hypothesis to answer from the CV, that a quote must come from the document
 * and never from this list, and that an inference can never on its own carry a
 * requirement. These are stored under their own taxonomy-label type and at a
 * lower confidence than a stated skill, so they can surface somebody without
 * outranking a person who said the thing themselves.
 */
import 'dotenv/config'
import process from 'node:process'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(`--${f}`)
const numberFlag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = Number(argv[at + 1])
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`--${name} needs a whole number above zero\n`)
    process.exit(1)
  }
  return value
}

const RUN = has('run')
const REDO = has('redo')
const LIMIT = numberFlag('limit')

const db = (await import('../src/db.js')).default
const { getExtraction, saveExtraction } = await import('../src/profiles.js')
const { runIntelligence } = await import('../src/matching/intelligence.js')
const { priceOf } = await import('../src/costs.js')

/* The cheap model, per C2, and named here rather than read from the
   environment: this is a one-off whose cost was approved at this rate. */
const MODEL = process.env.INFER_MODEL ?? 'claude-haiku-4-5'

const SYSTEM = `You read a CV and name the capabilities its work implies but never states.

A skills list is what somebody thought to write down. The work they describe
implies more: somebody who owned a finance team's month-end close for six years
knows reconciliation, variance analysis and audit preparation whether or not
those words appear anywhere.

Return short, concrete, searchable noun phrases, lowercase. Twelve at most.

Rules, and they matter more than the list being long:
- Infer only from what the CV says the person DID. Never from a job title
  alone, never from an employer's industry, never from a degree subject.
- Do not repeat anything already in their stated skills. That is not an
  inference, it is a copy.
- Nothing about who the person is: not age, gender, ethnicity, nationality,
  religion, health, family, or anything that could stand in for one of those.
- No soft qualities. "Communication", "leadership" and "teamwork" describe
  everybody and retrieve everybody, which is the same as retrieving nobody.
- If the CV is too thin to infer anything honestly, return an empty list. An
  empty list is a correct answer and a padded one is a wrong one.`

function candidatesToDo() {
  const rows = db.prepare(`
    SELECT c.id, c.cv_text
    FROM candidates c
    JOIN extracted_profiles p ON p.candidate_id = c.id
    WHERE c.cv_text IS NOT NULL AND length(c.cv_text) > 200
    ORDER BY c.id
  `).all()

  const due = []
  for (const row of rows) {
    const profile = getExtraction(row.id)
    if (!profile) continue
    if (!REDO && Array.isArray(profile.inferredCapabilities)) continue
    due.push({ ...row, profile })
    if (LIMIT && due.length >= LIMIT) break
  }
  return due
}

const due = candidatesToDo()

/* Measured from this machine's own CVs rather than assumed: the estimate is
   only worth printing if it is built from the documents it will actually
   read. 4 characters to a token is the usual English approximation. */
const inputTokens = due.reduce((sum, row) => sum + Math.ceil(row.cv_text.length / 4), 0)
  + due.length * Math.ceil(SYSTEM.length / 4)
const outputTokens = due.length * 150

const price = priceOf(MODEL)
const estimate = (inputTokens * price.input + outputTokens * price.output) / 1_000_000

console.log('')
console.log('C2 backfill - inferred capabilities')
console.log(`Model                  : ${MODEL}`)
console.log(`Profiles without one   : ${due.length}${REDO ? ' (--redo: including those that have one)' : ''}`)
console.log(`Estimated input tokens : ${inputTokens.toLocaleString()}`)
console.log(`Estimated output tokens: ${outputTokens.toLocaleString()}`)
console.log(`Estimated cost         : $${estimate.toFixed(4)}`)
console.log('')

if (due.length === 0) {
  console.log('Nothing to do.\n')
  process.exit(0)
}

if (!RUN) {
  console.log('Dry run - nothing was written and no model was called.')
  console.log('  npm run infer:backfill -- --run')
  console.log('')
  process.exit(0)
}

const { getClient } = await import('../src/ai.js')
const anthropic = getClient()
if (!anthropic) {
  console.error('No ANTHROPIC_API_KEY, so there is no cheap model to ask.')
  console.error('Run this where the key is set - on the server, or with the key in server/.env.\n')
  process.exit(1)
}

let done = 0
let empty = 0
let failed = 0
let spent = 0
let capabilities = 0

for (const row of due) {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['inferred_capabilities'],
            properties: {
              inferred_capabilities: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
      messages: [{
        role: 'user',
        /* The CV alone. The stored profile is not sent: the model would read
           its skills list and hand it back, which is the one thing the prompt
           forbids, and paying to be told what we already know is the failure
           mode this whole exercise is trying to avoid. */
        content: `<cv>\n${row.cv_text}\n</cv>`,
      }],
    })

    const text = response.content.find((block) => block.type === 'text')?.text ?? '{}'
    const answer = JSON.parse(text)

    const stated = new Set((row.profile.skills ?? []).map((s) => String(s).toLowerCase().trim()))
    const list = [...new Set(
      (answer.inferred_capabilities ?? [])
        .map((value) => String(value).trim().toLowerCase())
        .filter(Boolean)
        /* The prompt says not to repeat a stated skill; this is what makes
           that true rather than requested. */
        .filter((value) => !stated.has(value)),
    )].slice(0, 12)

    const usage = response.usage ?? {}
    spent += ((usage.input_tokens ?? 0) * price.input
      + (usage.output_tokens ?? 0) * price.output) / 1_000_000

    saveExtraction(row.id, {
      ...row.profile,
      inferredCapabilities: list,
      source: row.profile.source ?? 'claude',
      model_version: row.profile.model_version ?? null,
    })

    /* So the new list reaches retrieval rather than only storage: the taxonomy
       labels are what conceptSimilarity reads, and they are built from the
       profile at this point and not before. */
    runIntelligence(row.id)

    capabilities += list.length
    if (list.length === 0) empty += 1
    done += 1

    if (done % 25 === 0) console.log(`  ${done} of ${due.length}...`)
  } catch (error) {
    failed += 1
    console.warn(`  candidate ${row.id}: ${error.message}`)
  }
}

console.log('')
console.log('DONE')
console.log(`  profiles updated       : ${done}`)
console.log(`  of those, empty list   : ${empty}   (CV too thin to infer from honestly)`)
console.log(`  capabilities added     : ${capabilities}`)
console.log(`  average per profile    : ${done ? (capabilities / done).toFixed(1) : 0}`)
console.log(`  failed                 : ${failed}`)
console.log(`  ACTUAL COST            : $${spent.toFixed(4)}`)
console.log('')
