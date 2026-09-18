/**
 * What a judgement costs, and the four things that were done to make it cost
 * less.
 *
 * The model is stubbed at the fetch layer, so nothing here measures Claude —
 * it measures the request we build and what we do with the answer, which is
 * where every one of these savings actually lives:
 *
 *   1. the shared half of the prompt is marked cacheable, and the candidate is
 *      outside it, because a cached prefix ends at the first byte that differs;
 *   2. one call goes first so the rest read that cache instead of each writing
 *      their own;
 *   3. strengths, gaps and evidence are derived from the verdicts rather than
 *      bought a second time;
 *   4. what was spent is written down, separated into the four token counts
 *      that have four different prices.
 *
 * A saving nobody can measure is a saving nobody can defend, so the ledger is
 * tested as carefully as the caching.
 */
import { createReporter } from './helpers.mjs'

const { check, section, finish } = createReporter()

/* ------------------------------------------------------------- the stub --- */

const requests = []
let reply = {}
let usage = { input_tokens: 100, output_tokens: 50 }
/* Resolves when the test lets it, so "did one call go first?" can be asked
   rather than assumed from timing. */
let gate = null

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body ?? '{}')
  requests.push(body)

  if (gate) await gate

  const text = JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
    stop_reason: 'end_turn', usage,
    content: [{ type: 'text', text: JSON.stringify(reply) }],
  })

  return {
    ok: true, status: 200, statusText: 'OK',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(text), text: async () => text,
    clone() { return this },
  }
}

process.env.ANTHROPIC_API_KEY = 'test-key-not-real'
/* The warm-up wait, made short. The production default is eight seconds and
   this suite would otherwise spend them doing nothing. */
process.env.MATCH_WARMUP_MS = '50'

const { analyseMatch, analyseMatches, explainVerdicts, isPaused } = await import('../server/src/ai.js')
const { costOf, PRICES, recordCost, sumUsage } = await import('../server/src/costs.js')
const { deriveHighlights, scoreAgainst } = await import('../server/src/matching/score.js')

const ROLE = 'Senior underwriter reviewing online transactions for a payments company.'
const CRITERIA = {
  title: 'Underwriter',
  requirements: [
    { id: 'R1', text: 'Underwriting experience', tier: 'must_have' },
    { id: 'R2', text: 'Fraud review', tier: 'must_have' },
    { id: 'R3', text: 'SQL', tier: 'preferred' },
  ],
  location: 'Tel Aviv',
}

reply = {
  criteria: [
    { requirement_id: 'R1', status: 'meets', quote: 'Underwrote card-not-present risk', reason: 'Three years underwriting payments risk' },
    { requirement_id: 'R2', status: 'no_evidence', quote: '', reason: '' },
    { requirement_id: 'R3', status: 'partial', quote: 'built reports', reason: 'Reporting work implies some SQL' },
  ],
  reasoning: 'Underwrites payments risk. Fraud review is not evidenced either way.',
  transferable: ['Chargeback analysis covers fraud review'],
  confidence: 'high',
  location_fit: { level: 'local', explanation: 'Same metro area.' },
  seniority_alignment: { level: 'matches', note: 'Scope fits the seat.' },
}

const candidate = (id) => ({
  candidate: { id, cv_text: `CV number ${id}. Underwrote card-not-present risk and built reports.`, location: 'Tel Aviv' },
  profile: null,
})

/* ------------------------------------------------ 1. the cacheable half --- */

requests.length = 0
await analyseMatch({ jobDescription: ROLE, criteria: CRITERIA, ...candidate(1) })
const one = requests[0]

section('The half that never changes is marked cacheable')
check('the instructions are sent as a block, not a string', Array.isArray(one.system))
check('and carry a cache breakpoint',
  one.system?.[0]?.cache_control?.type === 'ephemeral',
  'the system prompt is the largest fixed thing in the request')

const content = one.messages?.[0]?.content ?? []
check('the message is split in two', Array.isArray(content) && content.length === 2)
check('the job is in the first block', /Senior underwriter/.test(content[0]?.text ?? ''))
check('which is also marked cacheable', content[0]?.cache_control?.type === 'ephemeral')
check('the candidate is in the second', /CV number 1/.test(content[1]?.text ?? ''))
check('and the candidate block is NOT cached',
  content[1]?.cache_control === undefined,
  'a prefix ends at the first byte that differs, so the CV must sit outside it')

check('the requirements travel with the cached half',
  /R1/.test(content[0]?.text ?? '') && !/R1/.test(content[1]?.text ?? ''),
  'one list for the whole batch is what makes the prefix identical across CVs')

/* ------------------------------------------------------ 2. the warm-up --- */

section('One call goes first, so the rest read the cache')
requests.length = 0

let release = null
gate = new Promise((resolve) => { release = resolve })

const batch = analyseMatches({
  jobDescription: ROLE,
  criteria: CRITERIA,
  candidates: [candidate(1), candidate(2), candidate(3), candidate(4), candidate(5)],
  concurrency: 4,
})

/* Inside the warm-up window, with nothing answered yet: whatever has been sent
   by now was sent without waiting for a cache to exist. */
await new Promise((resolve) => { setTimeout(resolve, 20) })
const duringWindow = requests.length

release()
gate = null
const results = await batch

check('only one call is in flight while the cache is being written',
  duringWindow === 1,
  `${duringWindow} request(s) went out together — four cache writes instead of one`)
check('and the rest follow once it is under way', requests.length === 5)
check('every candidate is still judged', results.size === 5)

/*
 * The other half of the design, and the reason it is a race rather than an
 * await: a first call that hangs must not hold up the batch behind it. A
 * recruiter waiting on a page of results would rather pay full price than wait.
 */
section('The wait is bounded')
requests.length = 0
let holdOpen = null
gate = new Promise((resolve) => { holdOpen = resolve })

const stubborn = analyseMatches({
  jobDescription: ROLE,
  criteria: CRITERIA,
  candidates: [candidate(6), candidate(7), candidate(8)],
  concurrency: 4,
})

/* Well past the warm-up window, still nothing answered. */
await new Promise((resolve) => { setTimeout(resolve, 120) })
const afterWindow = requests.length

holdOpen()
gate = null
await stubborn

check('a slow first call does not hold the batch',
  afterWindow === 3,
  `${afterWindow} of 3 had been sent once the window expired`)

/* ---------------------------------------- 3. derived rather than bought --- */

section('Strengths, gaps and evidence come from the verdicts')
const judged = scoreAgainst(CRITERIA.requirements, reply.criteria)
const derived = deriveHighlights(judged.breakdown)

check('a met requirement becomes a strength',
  derived.strengths.some((line) => /underwriting payments risk/i.test(line)))
check('a quote becomes evidence',
  derived.evidence.some((item) => item.quote === 'Underwrote card-not-present risk'))
check('an unmentioned must-have becomes a gap',
  derived.gaps.some((line) => /Fraud review/.test(line)))
check('and silence is not reported as failure',
  derived.gaps.every((line) => !/shows otherwise/.test(line)),
  'no_evidence means the CV did not say, which is not the same as cannot')

const contradicted = deriveHighlights(scoreAgainst(CRITERIA.requirements, [
  { requirement_id: 'R1', status: 'contradicted', quote: 'no underwriting experience', reason: 'States otherwise' },
]).breakdown)
check('a contradicted requirement is stated as one',
  contradicted.gaps.some((line) => /shows otherwise/.test(line)))

section('And are no longer asked of the model')
const asked = JSON.stringify(one.output_config?.format?.schema ?? {})
check('the schema does not ask for strengths', !/"strengths"/.test(asked))
check('nor gaps', !/"gaps"/.test(asked))
check('nor a second evidence list', !/"evidence"/.test(asked))
check('nor interview questions', !/"probes"/.test(asked))
check('but still asks for a verdict per requirement', /"requirement_id"/.test(asked))
check('and for transferable experience',
  /"transferable"/.test(asked),
  'the one claim here that no arithmetic over the verdicts could reconstruct')

/* ---------------------------------------------- 4. what it actually cost --- */

section('The four token counts are kept apart')
usage = {
  input_tokens: 1000,
  cache_creation_input_tokens: 7000,
  cache_read_input_tokens: 0,
  output_tokens: 2000,
}
const cold = await analyseMatch({ jobDescription: ROLE, criteria: CRITERIA, ...candidate(9) })

usage = {
  input_tokens: 1000,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 7000,
  output_tokens: 2000,
}
const warm = await analyseMatch({ jobDescription: ROLE, criteria: CRITERIA, ...candidate(10) })

check('a cache write is reported', cold.usage.cacheWriteTokens === 7000)
check('a cache read is reported', warm.usage.cacheReadTokens === 7000)

const coldCost = costOf({ model: 'claude-opus-5', ...cold.usage })
const warmCost = costOf({ model: 'claude-opus-5', ...warm.usage })

check('and the two are priced differently', warmCost < coldCost,
  `$${coldCost.toFixed(4)} cold against $${warmCost.toFixed(4)} warm`)
check('a cached read costs a tenth of a fresh one',
  Math.abs((PRICES['claude-opus-5'].cacheRead * 10) - PRICES['claude-opus-5'].input) < 0.001)
check('and a write costs a quarter more',
  Math.abs(PRICES['claude-opus-5'].cacheWrite - (PRICES['claude-opus-5'].input * 1.25)) < 0.001)

const totals = sumUsage([cold.usage, warm.usage])
check('usages add up across a batch',
  totals.calls === 2 && totals.cacheReadTokens === 7000 && totals.cacheWriteTokens === 7000)

section('The ledger records it')
const { default: db } = await import('../server/src/db.js')
const MARK = `cking-cost-${Date.now().toString(36)}`

recordCost({
  context: MARK, stage: 'match', model: 'claude-opus-5', calls: 2, items: 2,
  inputTokens: 2000, cacheWriteTokens: 7000, cacheReadTokens: 7000, outputTokens: 4000,
})

const row = db.prepare(`SELECT * FROM ai_cost_events WHERE context = ?`).get(MARK)
check('a row is written', Boolean(row))
check('with the cache columns separate',
  row?.cache_write_tokens === 7000 && row?.cache_read_tokens === 7000,
  'one input number cannot be priced once caching is on')
check('and the items it was about',
  row?.items === 2,
  'cost per call and cost per CV are different numbers; the second is the one that matters')

db.prepare(`DELETE FROM ai_cost_events WHERE context = ?`).run(MARK)
check('test row removed', !db.prepare(`SELECT id FROM ai_cost_events WHERE context = ?`).get(MARK))

/* ------------------------------------------- explaining, when asked for --- */

section('The written half is a separate, cheaper call')
requests.length = 0
reply = {
  summary: 'Underwrites payments risk in a metro-local role.',
  probes: [
    { requirement_id: 'R2', question: 'What fraud review have you owned end to end?' },
    { requirement_id: 'R1', question: 'This one is already evidenced.' },
    { requirement_id: 'R9', question: 'This requirement does not exist.' },
  ],
}

const explained = await explainVerdicts({ role: ROLE, verdicts: judged.breakdown, coverage: 70 })
const explainRequest = requests[0]

check('it runs on the writer model, not the judging one',
  explainRequest.model === 'claude-sonnet-5',
  'explaining a settled decision is a writing task')
check('at the lowest effort', explainRequest.output_config?.effort === 'low')
check('with no thinking at all', explainRequest.thinking === undefined)
check('and reads the verdicts rather than the CV',
  /R1/.test(JSON.stringify(explainRequest.messages))
  && !/CV number/.test(JSON.stringify(explainRequest.messages)),
  'a few hundred tokens instead of a whole document')

check('a question about an evidenced requirement is dropped',
  !explained.probes.some((q) => /already evidenced/.test(q)),
  'it wastes the interview it is meant to improve')
check('a question about an invented requirement is dropped',
  !explained.probes.some((q) => /does not exist/.test(q)))
check('the open one survives',
  explained.probes.some((q) => /fraud review/i.test(q)))

reply = { summary: 'A strong 85% match overall.', probes: [] }
const scored = await explainVerdicts({ role: ROLE, verdicts: judged.breakdown })
check('an explanation that invents a score is discarded',
  scored.summary === '',
  'the platform computes the number, and it is already on screen beside this')

/* -------------------------------------------------------- the switches --- */

section('The switches that stop the spending')
process.env.AI_PAUSED = '1'
check('AI_PAUSED turns every model call off', isPaused())
const { isConfigured } = await import('../server/src/ai.js')
check('and makes the product report itself as unconfigured',
  !isConfigured(),
  'which is the path a missing key already takes, so it is exercised constantly')
delete process.env.AI_PAUSED
check('and unsetting it brings the model back', isConfigured())

const { MATCHING } = await import('../server/src/matching/config.js')
check('a company has a daily ceiling', MATCHING.companyDailyAnalyses > 0)
check('the public demo has a much lower one',
  MATCHING.demoDailyAnalyses < MATCHING.companyDailyAnalyses,
  'nobody behind it is paying, and there is no limit on how many browsers exist')

const { PUBLIC_DEMO } = await import('../server/src/publicDemo.js')
check('the demo judges with the cheaper model',
  PUBLIC_DEMO.model === 'claude-sonnet-5',
  'the one surface with no account behind it and no limit on how many people start one')

const { analysisModel } = await import('../server/src/matching/analysis.js')
check('and that model travels into the analysis cache key',
  analysisModel(PUBLIC_DEMO.model) !== analysisModel('claude-opus-5'),
  'otherwise a demo would read a recruiter’s assessment, or write over one')

check('and the demo reads only what it shows',
  PUBLIC_DEMO.deepAnalyse <= PUBLIC_DEMO.maxResults + 4
  && PUBLIC_DEMO.deepAnalyse < MATCHING.deepAnalysisBatch,
  `${PUBLIC_DEMO.deepAnalyse} analysed to show ${PUBLIC_DEMO.maxResults}`)

finish()
