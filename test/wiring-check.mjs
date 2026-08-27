/**
 * The three things the recruiter and candidate UIs must actually do now:
 * staged search with Show More, candidate-visible categorisation, and
 * supporting documents feeding what the platform concludes.
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import Database from 'better-sqlite3'

import {
  BASE, approveCompanyById, contactProofs, createReporter, json, makePdf,
  registerAndSignIn, registerCompany, serverEnv,
} from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const MARKER = `@cking-wiring-${RUN}.example.com`
const H = (t) => ({ 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) })
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))


/** Proves the email and phone already in `form`, and appends the proofs. */
async function appendProofs(form) {
  const proofs = await contactProofs({ email: form.get('email'), phone: form.get('phone') })
  for (const [key, value] of Object.entries(proofs)) form.append(key, value)
}

async function apply({ first, last, cv, extraDoc = null }) {
  const form = new FormData()
  form.append('cv', new Blob([await makePdf(cv)], { type: 'application/pdf' }), 'cv.pdf')
  if (extraDoc) {
    form.append('cover_letter', new Blob([await makePdf(extraDoc)], { type: 'application/pdf' }), 'letter.pdf')
  }
  for (const [k, v] of Object.entries({
    firstName: first, lastName: last, email: `${first}.${last}.${RUN}${MARKER}`.toLowerCase(),
    phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
    location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
  })) form.append(k, v)
  // Both contact details are proved before an account exists.
  await appendProofs(form)
  // The 18+ affirmation and agreement the form now sends and the route now requires.
  if (!form.has('consent')) form.append('consent', 'true')
  const res = await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form })
  return { res, body: await res.json().catch(() => ({})) }
}

const waitForIntelligence = async (id) => {
  for (let i = 0; i < 60; i += 1) {
    const row = db.prepare(`
      SELECT 1 AS ok FROM candidate_profile_intelligence i
      JOIN candidates c ON c.id = i.candidate_id AND c.profile_version = i.profile_version
      WHERE i.candidate_id = ?
    `).get(id)
    if (row) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

// ------------------------------------------------------------------ setup ---

section('Setup')
const admin = await registerAndSignIn({ companyName: `Wiring ${RUN}` })
check('recruiter signed in', Boolean(admin.token))
// §15 — a company registers 'pending' and reaches nothing until it is approved.
await approveCompanyById(admin.company.id)


const people = []
for (let i = 0; i < 6; i += 1) {
  const person = await apply({
    first: `Cand${i}`, last: 'Wire',
    cv: [
      `Candidate ${i}`, 'Backend engineer - Tel Aviv',
      `BACKEND ENGINEER, Shop${i} 201${i} -01 - present`,
      '  Java services, SQL, payments work.',
      'SKILLS: Java, SQL, Kubernetes',
    ],
  })
  people.push(person.body.id)
}
check('six candidates created', people.every(Boolean), people.join(', '))
check('all categorised', (await Promise.all(people.map(waitForIntelligence))).every(Boolean))

// -------------------------------------------------- staged search + more ---

section('Staged search, as the browser calls it')
const jd = `Backend engineer ${RUN}. Requirements: Java, SQL. Preferred: Kubernetes.`

const first = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ jobDescription: jd }),
}))

check('a session id comes back', Boolean(first.sessionId))
check('the UI is told the batch size', typeof first.scoring.batchSize === 'number',
  `batch ${first.scoring.batchSize}`)
check('and whether more can be shown', typeof first.canShowMore === 'boolean',
  `canShowMore ${first.canShowMore}`)
check('the job profile carries classified criteria',
  Array.isArray(first.jobProfile.mustHaves) && Array.isArray(first.jobProfile.preferred))
check('results carry a score', first.results.every((r) => typeof r.score === 'number'))
check('and the activity a filter needs', first.results.every((r) => r.activity?.state))

section('Show More continues the same session')
const more = await fetch(`${BASE}/api/hr/search/${first.sessionId}/more`, {
  method: 'POST', headers: H(admin.token),
})
const moreData = await more.json()
check('the endpoint the button calls responds', more.status === 200, `HTTP ${more.status}`)
check('it returns the same session', moreData.sessionId === first.sessionId)
check('nobody shown twice',
  new Set(moreData.results.map((r) => r.candidate.id)).size === moreData.results.length)
check('everyone from the first batch is still there',
  first.results.every((r) => moreData.results.some((x) => x.candidate.id === r.candidate.id)))

section('The adapter the UI uses can rebuild its chips')
const withCriteria = first.results.find((r) => (r.analysis?.criteria ?? []).length > 0)
if (withCriteria) {
  const items = withCriteria.analysis.criteria
  check('criteria items carry a class', items.every((i) => i.class))
  check('and an assessment', items.every((i) => i.assessment))
  check('must-haves are distinguishable from preferences',
    items.some((i) => i.class === 'must-have') || items.some((i) => i.class === 'preferred'))
} else {
  check('no criteria to split, which the UI renders as an empty list', true,
    'deterministic path with no recognised skills')
}

section('The client actually calls the staged endpoints')
const bundlePath = fs.readdirSync(new URL('../client/dist/assets/', import.meta.url))
  .find((name) => name.startsWith('index-') && name.endsWith('.js'))
const bundle = fs.readFileSync(new URL(`../client/dist/assets/${bundlePath}`, import.meta.url), 'utf8')
check('the built UI posts to /api/hr/search', bundle.includes('/api/hr/search'))
check('and to the more endpoint', bundle.includes('/more'))
check('the Show more button is in the bundle', bundle.includes('Show '))
check('the old single-shot call is gone from the search flow', !bundle.includes('/api/hr/match'))

// ------------------------------------------------------- candidate side ---

section('A candidate sees how they are categorised')
const codeRes = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: H(), body: JSON.stringify({ identifier: `cand0.wire.${RUN}${MARKER}`.toLowerCase() }),
}))
const { token } = await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: H(),
  body: JSON.stringify({ identifier: `cand0.wire.${RUN}${MARKER}`.toLowerCase(), code: codeRes.devCode }),
}))

const me = await json(await fetch(`${BASE}/api/candidate/me`, { headers: { authorization: `Bearer ${token}` } }))
check('their categorisation is returned', Boolean(me.intelligence))
check('with labels', (me.intelligence.labels ?? []).length > 0, `${me.intelligence.labels?.length}`)
check('each carrying evidence', me.intelligence.labels.every((l) => l.evidence))
check('and a confidence', me.intelligence.labels.every((l) => typeof l.confidence === 'number'))
check('their preferences come back too', Boolean(me.preferences))
check('with the cap published', me.preferences.tagCap === 10)
check('and their activity state, which drives the toggle', Boolean(me.activity?.state))

check('the portal renders the categorisation', bundle.includes('How you are categorised'))
/*
 * The explanatory line under the heading was removed at the owner's request, so
 * the old form of this check — which passed as long as that sentence existed —
 * can no longer hold. What it was really protecting is that these labels are
 * never presented as a score: they say which searches find you, and a number
 * beside them would read as how well you did.
 */
/* Scoped to the panel, not the bundle: the Terms of Service disclaim the
   accuracy of "MATCH SCORES", which is a different and entirely correct use of
   the words several hundred kilobytes away. */
check('and never calls it a match score',
  !/\bscore\b/i.test(bundle.split('How you are categorised')[1]?.slice(0, 600) ?? ''))

// --------------------------------------------- supporting documents read ---

section('A supporting document feeds what we conclude')
const withLetter = await apply({
  first: 'Doc', last: 'Wire',
  cv: ['Doc Wire', 'Analyst - Tel Aviv', 'ANALYST, Firm 2019-01 - present', '  General analysis work.'],
  extraDoc: [
    'Cover letter',
    'I have spent my career in cybersecurity, focused on threat intelligence',
    'and incident response for financial institutions.',
  ],
})
check('applied with a cover letter', withLetter.res.status === 201, `HTTP ${withLetter.res.status}`)
await waitForIntelligence(withLetter.body.id)

const letterLabels = db.prepare(`
  SELECT concept_id FROM candidate_taxonomy_labels WHERE candidate_id = ?
`).all(withLetter.body.id).map((r) => r.concept_id)

check('a concept only the letter mentions is picked up',
  letterLabels.some((c) => ['cybersecurity', 'security-function', 'threat-intel'].includes(c)),
  letterLabels.join(', ') || '(none)')

section('Six-month revalidation is built but not scheduled')
const { runRevalidation } = await import('../server/src/matching/revalidation.js')
const plan = runRevalidation({ dryRun: true })
check('a dry run reports without changing anything', plan.dryRun === true)
check('and nothing is due for a fresh profile', plan.due === 0, `${plan.due} due`)

const future = new Date()
future.setMonth(future.getMonth() + 7)
const overdue = runRevalidation({ now: future, dryRun: true })
check('but seven months on, profiles are due', overdue.due > 0, `${overdue.due} due`)
check('and unchanged ones are skipped rather than rebuilt',
  overdue.plans.some((p) => !p.rebuild),
  'identical documents are not paid for twice')

check('no timer schedules it', !fs.readFileSync(new URL('../server/src/index.js', import.meta.url), 'utf8')
  .includes('runRevalidation'), 'run it from server/scripts/revalidate.mjs')

// ---------------------------------------------------------------- cleanup ---

section('Cleanup')
const ids = db.prepare(`SELECT id FROM candidates WHERE email LIKE ?`).all(`%${MARKER}`).map((r) => r.id)
for (const id of ids) {
  for (const doc of db.prepare(`SELECT stored_name FROM documents WHERE candidate_id = ?`).all(id)) {
    try { fs.unlinkSync(new URL(`../server/uploads/${doc.stored_name}`, import.meta.url)) } catch {}
  }
  const row = db.prepare(`SELECT stored_name FROM candidates WHERE id = ?`).get(id)
  if (row?.stored_name) { try { fs.unlinkSync(new URL(`../server/uploads/${row.stored_name}`, import.meta.url)) } catch {} }
  for (const t of [
    'folder_items', 'view_events', 'reveals', 'documents', 'extracted_profiles',
    'profile_overrides', 'blocked_companies', 'messages', 'message_threads', 'login_codes',
    'scoring_audit', 'freshness_checkins', 'embeddings', 'candidate_preference_tags',
    'extracted_facts', 'candidate_profile_intelligence', 'candidate_taxonomy_labels',
    'candidate_experience_metrics', 'candidate_job_analyses', 'displayed_match_state',
  ]) {
    try { db.prepare(`DELETE FROM ${t} WHERE candidate_id = ?`).run(id) } catch {}
  }
  db.prepare(`DELETE FROM candidates WHERE id = ?`).run(id)
}

const companies = db.prepare(`SELECT id FROM companies WHERE name LIKE 'Wiring %'`).all().map((r) => r.id)
if (companies.length) {
  const list = companies.join(',')
  const recruiters = db.prepare(`SELECT id FROM recruiters WHERE company_id IN (${list})`).all().map((r) => r.id)
  const rlist = recruiters.length ? recruiters.join(',') : '-1'
  db.exec(`
    DELETE FROM displayed_match_state WHERE session_id IN (SELECT id FROM retrieval_sessions WHERE recruiter_id IN (${rlist}));
    DELETE FROM candidate_job_analyses WHERE job_id IN (SELECT id FROM jobs WHERE recruiter_id IN (${rlist}));
    DELETE FROM job_match_profiles WHERE job_id IN (SELECT id FROM jobs WHERE recruiter_id IN (${rlist}));
    DELETE FROM retrieval_sessions WHERE recruiter_id IN (${rlist});
    DELETE FROM jobs WHERE recruiter_id IN (${rlist});
    DELETE FROM search_chat_turns WHERE chat_id IN (SELECT id FROM search_chats WHERE recruiter_id IN (${rlist}));
    DELETE FROM search_chats WHERE recruiter_id IN (${rlist});
    DELETE FROM folder_items WHERE folder_id IN (SELECT id FROM folders WHERE recruiter_id IN (${rlist}));
    DELETE FROM folders WHERE recruiter_id IN (${rlist});
    DELETE FROM scoring_audit WHERE recruiter_id IN (${rlist});
    DELETE FROM view_events WHERE company_id IN (${list});
    DELETE FROM reveals WHERE company_id IN (${list});
    DELETE FROM organization_reveals WHERE company_id IN (${list});
    DELETE FROM billing_ledger WHERE company_id IN (${list});
    DELETE FROM seat_usage_periods WHERE recruiter_id IN (SELECT id FROM recruiters WHERE company_id IN (${list}));
    DELETE FROM seat_purchases WHERE company_id IN (${list});
    DELETE FROM recruiters WHERE company_id IN (${list});
    DELETE FROM companies WHERE id IN (${list});
  `)
}
check('test data removed', true, `${ids.length} candidate(s), ${companies.length} company(ies)`)
db.close()

finish()
