/**
 * Cookie sessions and CSRF.
 *
 * The point of the change is that a session can no longer be read by script or
 * carried in a URL, and that a cookie riding along on a cross-site request is
 * not enough to change anything. Each of those is asserted directly.
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import Database from 'better-sqlite3'

import { BASE, contactProofs, approveCompanyByName, createReporter, json, makePdf, serverEnv } from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const MARKER = `@cking-cookie-${RUN}.example.com`
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const H = (extra = {}) => ({ 'content-type': 'application/json', ...extra })

/** Everything a browser would keep, so this behaves like one. */
function jar() {
  const store = new Map()
  return {
    absorb(res) {
      for (const line of res.headers.getSetCookie?.() ?? []) {
        const [pair] = line.split(';')
        const eq = pair.indexOf('=')
        const name = pair.slice(0, eq).trim()
        const value = pair.slice(eq + 1).trim()
        if (value === '' || /Max-Age=0/i.test(line)) store.delete(name)
        else store.set(name, value)
      }
      return res
    },
    header() {
      return [...store].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    get: (name) => store.get(name) ?? null,
    raw: store,
  }
}

const cookies = jar()
const withJar = async (path, init = {}) => cookies.absorb(await fetch(`${BASE}${path}`, {
  ...init,
  headers: { ...(init.headers ?? {}), ...(cookies.header() ? { cookie: cookies.header() } : {}) },
}))

section('A CSRF token is minted for any visitor')
await withJar('/api/health')
check('the csrf cookie is set', Boolean(cookies.get('cvrsus_csrf')))
check('it is long enough to be unguessable', (cookies.get('cvrsus_csrf') ?? '').length >= 32)

section('Applying signs you in by cookie')
const form = new FormData()
form.append('cv', new Blob([await makePdf([
  'Cook Ie', 'Backend engineer', 'BACKEND ENGINEER, Shop 2019-01 - present',
  '  Java and SQL.', 'SKILLS: Java, SQL',
])], { type: 'application/pdf' }), 'cv.pdf')
for (const [k, v] of Object.entries({
  firstName: 'Cook', lastName: 'Ie', email: `cook.${RUN}${MARKER}`,
  phone: '052-600-7000', location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
  // Both contact details are proved before an account exists.
  ...(await contactProofs({ email: `cook.${RUN}${MARKER}`, phone: '052-600-7000' })),
})) form.append(k, v)

// The 18+ affirmation and agreement the route now requires.
if (!form.has('consent')) form.append('consent', 'true')

const applied = await withJar('/api/candidates', {
  method: 'POST', body: form, headers: { 'x-csrf-token': cookies.get('cvrsus_csrf') },
})
const candidate = await applied.json()
check('the application succeeds', applied.status === 201, `HTTP ${applied.status}`)

const setCookies = applied.headers.getSetCookie?.() ?? []
const sessionLine = setCookies.find((l) => l.startsWith('cvrsus_candidate='))
check('a session cookie is set', Boolean(sessionLine))
check('it is HttpOnly — script cannot read it', /HttpOnly/i.test(sessionLine ?? ''),
  'this is the whole point of the change')
check('it is SameSite=Lax', /SameSite=Lax/i.test(sessionLine ?? ''))
check('and scoped to the whole site', /Path=\/(;|$)/i.test(sessionLine ?? ''))

const hintLine = setCookies.find((l) => l.startsWith('cvrsus_session='))
check('a readable hint accompanies it', Boolean(hintLine))
check('the hint is NOT HttpOnly, so the UI can read it', !/HttpOnly/i.test(hintLine ?? ''))
check('the hint carries no credential', (hintLine ?? '').includes('cvrsus_session=candidate'),
  'just the role')

section('The cookie alone authenticates')
const me = await withJar('/api/candidate/me')
check('the account loads with no Authorization header', me.status === 200, `HTTP ${me.status}`)
check('and it is the right account', (await me.json()).candidate.id === candidate.id)

section('A token in the URL no longer works')
check('the body still returns a token for API clients', typeof candidate.token === 'string')
const viaQuery = await fetch(`${BASE}/api/candidate/me?token=${encodeURIComponent(candidate.token)}`)
check('but ?token= is refused', viaQuery.status === 401,
  `HTTP ${viaQuery.status} — credentials in URLs leak through history, logs and Referer`)

section('Bearer still works for scripts')
const viaBearer = await fetch(`${BASE}/api/candidate/me`, {
  headers: { authorization: `Bearer ${candidate.token}` },
})
check('an API client can still authenticate', viaBearer.status === 200, `HTTP ${viaBearer.status}`)

section('CSRF: a cookie is not enough to change anything')
const noHeader = await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH',
  headers: { cookie: cookies.header() },
  body: new FormData(),
})
check('an unsafe request without the CSRF header is refused', noHeader.status === 403,
  `HTTP ${noHeader.status}`)

const wrongHeader = await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH',
  headers: { cookie: cookies.header(), 'x-csrf-token': 'not-the-right-token' },
  body: new FormData(),
})
check('a wrong CSRF token is refused', wrongHeader.status === 403, `HTTP ${wrongHeader.status}`)

const reading = await fetch(`${BASE}/api/candidate/me`, { headers: { cookie: cookies.header() } })
check('but reads are unaffected', reading.status === 200,
  'GET changes nothing, so it needs no token')

const bearerNoCsrf = await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${candidate.token}` },
  body: new FormData(),
})
check('a Bearer caller is not asked for a CSRF token', bearerNoCsrf.status !== 403,
  `HTTP ${bearerNoCsrf.status} — no ambient authority to forge`)

section('Signing out clears the cookie server-side')
const out = await withJar('/api/auth/sign-out', {
  method: 'POST', headers: H({ 'x-csrf-token': cookies.get('cvrsus_csrf') }),
})
check('sign-out succeeds', out.status === 200, `HTTP ${out.status}`)
check('the session cookie is gone from the jar', !cookies.get('cvrsus_candidate'))
check('so is the hint', !cookies.get('cvrsus_session'))
check('and the session no longer authenticates',
  (await withJar('/api/candidate/me')).status === 401)

section('Recruiters get the same treatment')
const rj = jar()
await rj.absorb(await fetch(`${BASE}/api/health`))
const reg = await rj.absorb(await fetch(`${BASE}/api/company/register`, {
  method: 'POST',
  headers: H({ cookie: rj.header(), 'x-csrf-token': rj.get('cvrsus_csrf') }),
  body: JSON.stringify({
    companyName: `Cookie ${RUN}`,
    firstName: 'Maya', lastName: 'Cohen',
    email: 'maya@example.com', phone: '050-123-4567', website: 'example.com',
    password: 'Longenough1!', confirmPassword: 'Longenough1!',
    // The 18+ affirmation and agreement the route now requires.
    consent: 'true',
    // Both contact details are proved before an account exists.
    ...(await contactProofs({ email: 'maya@example.com', phone: '050-123-4567' })),
  }),
}))
check('a company registers', reg.status === 201 || reg.status === 200, `HTTP ${reg.status}`)
/*
 * Registering no longer opens a session: the company key is the credential and
 * it is released by whoever approves the account, so there is nothing to sign
 * in with yet. The cookie arrives at sign-in instead, which is where the rest
 * of this section now looks.
 */
check('but sets no recruiter cookie',
  !(reg.headers.getSetCookie?.() ?? []).some((l) => l.startsWith('cvrsus_recruiter=')),
  'the key is handed over after review, not at registration')

// §15 — a company registers 'pending' and reaches nothing until it is approved.
await approveCompanyByName(`Cookie ${RUN}`)

// The key an operator would pass on, read from where it actually lives.
const joinKey = db.prepare(`SELECT join_key FROM companies WHERE name = ?`)
  .get(`Cookie ${RUN}`).join_key

const login = await rj.absorb(await fetch(`${BASE}/api/recruiter/login`, {
  method: 'POST',
  headers: H({ cookie: rj.header(), 'x-csrf-token': rj.get('cvrsus_csrf') }),
  body: JSON.stringify({ joinKey, username: 'maya.cohen', password: 'Longenough1!' }),
}))
check('signing in succeeds', login.status === 200, `HTTP ${login.status}`)

const recruiterLine = (login.headers.getSetCookie?.() ?? []).find((l) => l.startsWith('cvrsus_recruiter='))
check('with an HttpOnly recruiter cookie', /HttpOnly/i.test(recruiterLine ?? ''))

check('the recruiter API works on the cookie alone',
  (await fetch(`${BASE}/api/hr/candidates`, { headers: { cookie: rj.header() } })).status === 200)

section('The client stores nothing')
const api = fs.readFileSync(new URL('../client/src/api.js', import.meta.url), 'utf8')
// Matches a call, not the word — the file explains in prose why localStorage
// was abandoned, and a test that trips over its own documentation is noise.
check('no localStorage call remains in the API layer', !/localStorage\s*\./.test(api),
  'nothing left for an XSS to read')
check('nor anywhere else in the client',
  !/localStorage\s*\./.test(
    fs.readdirSync(new URL('../client/src/pages/', import.meta.url))
      .map((f) => fs.readFileSync(new URL(`../client/src/pages/${f}`, import.meta.url), 'utf8'))
      .join('\n'),
  ))
check('requests send cookies', api.includes("credentials: 'same-origin'"))
check('and echo the CSRF token', api.includes('X-CSRF-Token'))
check('withToken no longer appends a credential', !api.includes('token=${encodeURIComponent'))

const bundlePath = fs.readdirSync(new URL('../client/dist/assets/', import.meta.url))
  .find((n) => n.startsWith('index-') && n.endsWith('.js'))
const bundle = fs.readFileSync(new URL(`../client/dist/assets/${bundlePath}`, import.meta.url), 'utf8')
check('the built bundle stores no token either',
  !bundle.includes('cking.candidate.token') && !bundle.includes('cking.recruiter.token'))

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
const companies = db.prepare(`SELECT id FROM companies WHERE name LIKE 'Cookie %'`).all().map((r) => r.id)
if (companies.length) {
  const list = companies.join(',')
  const rl = db.prepare(`SELECT id FROM recruiters WHERE company_id IN (${list})`).all()
    .map((r) => r.id).join(',') || '-1'
  db.exec(`
    DELETE FROM view_events WHERE company_id IN (${list});
    DELETE FROM reveals WHERE company_id IN (${list});
    DELETE FROM organization_reveals WHERE company_id IN (${list});
    DELETE FROM billing_ledger WHERE company_id IN (${list});
    DELETE FROM seat_usage_periods WHERE recruiter_id IN (SELECT id FROM recruiters WHERE company_id IN (${list}));
    DELETE FROM seat_purchases WHERE company_id IN (${list});
    DELETE FROM scoring_audit WHERE recruiter_id IN (${rl});
    DELETE FROM recruiters WHERE company_id IN (${list});
    DELETE FROM companies WHERE id IN (${list});
  `)
}
check('test data removed', true, `${rows.length} candidate(s), ${companies.length} company(ies)`)
db.close()

finish()
