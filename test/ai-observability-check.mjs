/**
 * A model call that falls back says why, and the matcher never learns who the
 * candidate is.
 *
 * Both of these were believed to be true and neither was. Every AI path in the
 * product falls back when the model is unreachable — correct behaviour — but
 * each fallback was announced with one console.warn and nothing else, so the
 * product could lose its entire reasoning layer and still look like it was
 * working. An entire 26-applicant Triage was scored by keyword matching and the
 * only evidence was a small grey chip in a screenshot.
 *
 * And `dossier()` carried a comment stating the candidate's name was
 * "deliberately withheld" while appending twelve thousand characters of raw CV,
 * which begins with the name on every CV ever written.
 */
import { createReporter } from './helpers.mjs'

const { check, section, finish } = createReporter()

/*
 * Stubbed before the SDK client is constructed — it captures fetch on
 * construction, so a later swap is ignored.
 *
 * It returns a refusal RESPONSE rather than throwing. A thrown fetch is a dead
 * socket, which the SDK wraps as a connection error and which carries no HTTP
 * status — so a test that throws proves only that something went wrong, not
 * that the status survived. 400 rather than 429 because the SDK retries a 429
 * twice with backoff, and a deterministic test should not spend that time.
 */
const body = JSON.stringify({
  type: 'error',
  error: { type: 'invalid_request_error', message: 'a request this code builds wrongly' },
})

globalThis.fetch = async () => new Response(body, {
  status: 400,
  headers: { 'content-type': 'application/json' },
})

process.env.ANTHROPIC_API_KEY = 'test-key-not-real'

const ai = await import('../server/src/ai.js')

section('A failure reports itself')
const seen = []
ai.onModelFailure((detail) => seen.push(detail))

/* Long enough to get past the short-input guards. */
const analysis = await ai.analyseMatch({
  jobDescription: 'Senior underwriter reviewing online transactions in real time.',
  criteria: { title: 'Underwriter', requiredSkills: ['Decision making'], preferredSkills: [] },
  candidate: { id: 1, cv_text: 'Risk analyst. '.repeat(40) },
  profile: null,
})

check('the caller still gets null, so nobody loses their place',
  analysis === null,
  'falling back must never cost a candidate their row')
check('but the failure was reported', seen.length > 0,
  'this is the whole point: the reason used to be thrown away')

const failure = seen[0] ?? {}
check('with the stage that failed', failure.stage === 'match-analysis', failure.stage)
check('and the HTTP status', failure.status === 400,
  `${failure.status} — a 429 is a quota to raise, a 400 is a request we build wrongly, and \`error.message\` alone cannot tell them apart`)
check('and the API error type', failure.type === 'invalid_request_error', failure.type)
check('and a message', String(failure.message ?? '').length > 0, failure.message)

section('Every AI path reports, not just the matcher')
seen.length = 0
await ai.extractProfileFields('x'.repeat(400))
check('CV extraction reports too', seen.some((f) => f.stage === 'cv-extraction'),
  'a silently degraded extraction makes every downstream score meaningless')

seen.length = 0
await ai.generateSummary('x'.repeat(400))
check('summary drafting reports too', seen.some((f) => f.stage === 'summary-drafting'))

section('The matcher is not told who the candidate is')
const cv = [
  'MATAN CUTLER',
  'Hertzeliya, Israel | +972-52-959-2503 | matanyacutler@gmail.com | https://linkedin.com/in/matan-c/',
  'Executive Staff NCO, Intelligence Corps. Managed unit logistics and readiness.',
  'Referee: Dana Levi, dana@example.com, 054-111-2222',
].join('\n')

const clean = ai.withoutIdentity(cv, {
  first_name: 'Matan', last_name: 'Cutler',
  email: 'matanyacutler@gmail.com', phone: '+972-52-959-2503',
})

check('their name is gone', !/matan|cutler/i.test(clean), clean.slice(0, 60))
check('no email address survives', !/@/.test(clean),
  'including the referee\u2019s, which is somebody else\u2019s personal data')
check('no phone number survives', !/\d{3}[- ]\d{3}/.test(clean))
check('no profile link survives', !/linkedin|https?:/i.test(clean))

/* The redaction is worthless if it also removes what the score is made of. */
check('the job title survives', /Executive Staff NCO/.test(clean))
check('the employer survives', /Intelligence Corps/.test(clean))
check('the achievement survives', /Managed unit logistics/.test(clean))

section('Order matters, and it is the easy half to get wrong')
/* Redacting the name first tears the address apart from the inside —
   "[redacted]ya[redacted]@gmail.com" no longer matches an email pattern, so the
   domain survives and the redaction leaks the thing it exists to remove. */
const leaky = ai.withoutIdentity('Reach me at matanyacutler@gmail.com any time.', {
  first_name: 'Matan', last_name: 'Cutler',
})
check('a name inside an email does not leave the domain behind',
  !/gmail/i.test(leaky), leaky)

section('It survives a name a regex would choke on')
const odd = ai.withoutIdentity("A. O'Brien-Smith wrote this.", {
  first_name: 'A.', last_name: "O'Brien-Smith",
})
check('a punctuated name is escaped, not compiled', !/O'Brien/i.test(odd), odd)
check('and it does not redact the whole document',
  odd.includes('wrote this'),
  'an unescaped "A." would match every character in the CV')

finish()
