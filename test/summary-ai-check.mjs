/**
 * The generated professional summary is never longer than the cap.
 *
 * Deliberately a separate suite from summary-limit-check.mjs, which covers the
 * form and the API. This one touches no server and no database: it stubs the
 * model at the fetch layer and drives generateSummary directly, which is the
 * only way to prove the trim actually applies to what Claude returns rather
 * than merely being asked for in the prompt.
 */
import { createReporter } from './helpers.mjs'

const { check, section, finish } = createReporter()

/*
 * Installed before the SDK client is ever constructed, and reading a mutable
 * variable. Reassigning globalThis.fetch between calls does nothing — the
 * client captures fetch at construction, so a later swap is ignored and every
 * call keeps returning the first stub's answer.
 */
let modelSays = ''

const stubModel = (summary) => { modelSays = summary }

globalThis.fetch = async () => {
  const body = JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
    stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'text', text: JSON.stringify({ summary: modelSays }) }],
  })

  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(body),
    text: async () => body,
    clone() { return this },
  }
}

process.env.ANTHROPIC_API_KEY = 'test-key-not-real'

const { SUMMARY_MAX_CHARS, generateSummary, isConfigured, trimToLimit } =
  await import('../server/src/ai.js')

const CV = `Rina Katz, backend engineer. ${'Detailed background information. '.repeat(20)}`

section('Setup')
check('the AI path is active for this suite', isConfigured() === true)
check(`the cap is ${SUMMARY_MAX_CHARS}`, SUMMARY_MAX_CHARS === 500)

section('Trimming keeps whole words and whole sentences')
const long = 'I build payment systems. I led the checkout rebuild. I care about reliability above all else and have spent years on it.'
const cut = trimToLimit(long, 60)
check('respects the limit', cut.length <= 60, `${cut.length} chars`)
check('ends at a sentence', /[.!?]$/.test(cut), JSON.stringify(cut))
check('severs no word', long.startsWith(cut))

const runOn = `${'word '.repeat(40)}end.`
const wordCut = trimToLimit(runOn, 50)
check('a run-on sentence is cut at a word boundary', wordCut.length <= 50 && runOn.startsWith(wordCut))
check('short text is untouched', trimToLimit('I build things.', 500) === 'I build things.')
check('empty stays empty', trimToLimit('', 500) === '')
check('null does not throw', trimToLimit(null, 500) === '')
check('exactly at the limit is unchanged', trimToLimit('x'.repeat(500), 500).length === 500)
check('one over is trimmed', trimToLimit('x'.repeat(501), 500).length <= 500)

section('A draft is capped even when the model overruns')
const overrun = 'I build payment systems for high-traffic retail. '.repeat(30)
check('the stub really does overrun', overrun.length > SUMMARY_MAX_CHARS, `${overrun.length} chars`)

stubModel(overrun)
const capped = await generateSummary(CV)
check('a draft comes back', Boolean(capped?.summary))
check('never longer than the cap', capped.summary.length <= SUMMARY_MAX_CHARS, `${capped.summary.length} chars`)
check('and it reports being shortened', capped.truncated === true)
check('ending on a complete sentence', /[.!?]$/.test(capped.summary),
  JSON.stringify(capped.summary.slice(-40)))
check('severing no word', overrun.startsWith(capped.summary))

section('A draft already within the cap')
const fits = 'I build payment systems for high-traffic retail. I led the checkout rebuild.'
stubModel(fits)
const short = await generateSummary(CV)
check('is returned verbatim', short.summary === fits)
check('and is not reported as shortened', short.truncated === false)

section('Exactly at the boundary')
stubModel(`${'a'.repeat(SUMMARY_MAX_CHARS - 1)}.`)
const atCap = await generateSummary(CV)
check('survives whole', atCap.summary.length === SUMMARY_MAX_CHARS, `${atCap.summary.length} chars`)
check('and is not flagged as trimmed', atCap.truncated === false,
  'an off-by-one here would clip every long summary')

section('A refusal is not turned into a summary')
check('a CV too short to summarise returns nothing', await generateSummary('too short') === null)

finish()
