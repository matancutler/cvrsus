/**
 * What the model is asked for, and what the backend does with the answer.
 *
 * These are prompt and wiring checks, not model checks: the API is stubbed at
 * the fetch layer, so what is under test is that each rule actually reaches
 * Claude and that each answer is carried somewhere useful. A rule nobody sends
 * is a comment, and a judgement nobody stores is a wasted call.
 */
import { createReporter } from './helpers.mjs'

const { check, section, finish } = createReporter()

let lastRequest = null
let reply = {}

globalThis.fetch = async (_url, init) => {
  lastRequest = JSON.parse(init?.body ?? '{}')
  const body = JSON.stringify({
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5',
    stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'text', text: JSON.stringify(reply) }],
  })
  return {
    ok: true, status: 200, statusText: 'OK',
    url: 'https://api.anthropic.com/v1/messages',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => JSON.parse(body), text: async () => body,
    clone() { return this },
  }
}

process.env.ANTHROPIC_API_KEY = 'test-key-not-real'

const { analyseMatch, extractProfileFields } = await import('../server/src/ai.js')
const { MATCHING } = await import('../server/src/matching/config.js')

/* ------------------------------------------------- the matching prompt --- */

reply = {
  score: 70, fit: 'good', reasoning: 'r', strengths: [], gaps: [], transferable: [],
  evidence: [], probes: [], confidence: 'high',
  location_fit: { level: 'commutable', explanation: 'x' },
  seniority_alignment: { level: 'matches', note: 'y' },
}

const analysis = await analyseMatch({
  jobDescription: 'Senior underwriter reviewing online transactions.',
  criteria: {
    title: 'Underwriter',
    requiredSkills: ['Decision making'],
    preferredSkills: [],
    location: 'Tel Aviv',
    workArrangement: 'hybrid',
  },
  candidate: { id: 1, cv_text: 'Risk analyst. Reviewed transactions.', location: 'Jerusalem' },
  profile: null,
})

const prompt = String(lastRequest?.system ?? '')
const sent = JSON.stringify(lastRequest?.messages ?? [])

section('The job says where it is')
check('the role block names the location', sent.includes('Job location: Tel Aviv'),
  'a model hunting for the city in prose finds the customer\u2019s, or the head office')
check('and the arrangement', sent.includes('Work arrangement: hybrid'),
  'three office days a week changes what distance costs')

section('Geography is asked for as friction, never as a number')
check('the ladder is given', /same_country_relocation/.test(prompt))
check('and framed as friction, not a fence', /friction, not a fence/i.test(prompt))
check('metro areas beat municipal borders', /metro areas, not municipal borders/i.test(prompt))
check('country norms are applied', /Israel is small/.test(prompt) && /United States relocates/.test(prompt))
check('relocation is never inferred', /ONLY if the candidate or their CV says so/.test(prompt))
check('and work authorisation is never guessed', /never guess at visas/i.test(prompt))

section('Overqualification is reported, not punished')
check('seniority alignment is asked for', /seniority_alignment/.test(prompt))
/* \s+ rather than a space: the prompt is wrapped prose, and a rule that
   happens to break across a line is still the rule. */
check('judged on scope rather than title',
  /not from\s+the words in their job title/.test(prompt))
check('and being above the role costs nothing',
  /must not reduce the score/.test(prompt),
  'a director applying down is information, not a fault')

section('A verbatim quote cannot hand over the identity')
check('quotes may not carry contact details',
  /NEVER quote a passage containing the candidate's name/.test(prompt),
  'evidence is the one field here that is copied out of the CV word for word')
check('and the top of a CV is named as the risk',
  /first lines/.test(prompt))

section('Both judgements come back')
check('location fit is returned', analysis.location_fit?.level === 'commutable')
check('seniority alignment is returned', analysis.seniority_alignment?.level === 'matches')

/* ---------------------------------------------- the extraction prompt --- */

reply = {
  first_name: null, middle_name: null, last_name: null, email: null, phone: null,
  city: null, current_title: null, seniority: null, skills: [], languages: [],
  education: [], employment_history: [], summary: null,
}
await extractProfileFields('x'.repeat(400))
const extraction = String(lastRequest?.system ?? '')

section('A CV is not read for who somebody is')
for (const forbidden of ['age', 'date of birth', 'gender', 'marital', 'pregnancy',
  'ethnicity', 'religion', 'disability', 'sexual orientation', 'political affiliation']) {
  check(`${forbidden} is ruled out`, extraction.toLowerCase().includes(forbidden))
}
check('a street address is refused but a city is kept',
  /home street address/.test(extraction) && /city someone lives in is kept/.test(extraction),
  'a job has a location; no hiring decision needs a doorstep')

section("A document's language is not a language skill")
check('stated evidence only', /THE LANGUAGE THE CV IS WRITTEN IN PROVES NOTHING/.test(extraction),
  'CVs are translated and rewritten constantly')

section('Careers that do not look like a career')
check('military service is employment', /military service is extracted as employment/.test(extraction))
check('and early-career work counts', /internships, academic projects and coursework/.test(extraction))
check('conflicts are kept, not resolved', /conflicting facts are kept/.test(extraction))

/* --------------------------------------------------- the ranking nudge --- */

section('Friction is priced by the backend, and bounded')
const bonus = MATCHING.locationBonus
check('being local helps', bonus.local > 0)
check('the far side of the world hurts a little', bonus.international_relocation < 0)
check('an unknown location is neutral', bonus.uncertain === 0,
  'a search with no geography must score exactly as it did before this existed')
check('and the whole span is small enough not to overturn fit',
  (bonus.local - bonus.international_relocation) <= 20,
  `${bonus.local - bonus.international_relocation} points across the entire ladder`)

finish()
