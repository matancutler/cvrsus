/**
 * Refreshing the page keeps you signed in — as a recruiter, as a candidate, and
 * as both at once in the same browser.
 *
 * It did not. Refreshing the live site signed people out of whichever role they
 * were in, and three separate faults combined to do it:
 *
 *  1. The "is there a session" hint the page renders from was ONE cookie holding
 *     ONE role — `cvrsus_session=recruiter` or `=candidate`. Signing into one
 *     role overwrote the other, so on refresh the other role's page saw no
 *     session and showed the sign-in card without even asking the server.
 *  2. The recruiter page signed out on ANY failure to load — a 500, a timeout, a
 *     server waking up — not only on a refused session. The candidate page had
 *     already been fixed for exactly this; the recruiter page never was.
 *  3. Signing out, and being signed out by a sign-in elsewhere, cleared EVERY
 *     role's cookie. So one hiccup on the recruiter page also ended the
 *     candidate session in the same browser.
 *
 * The browser is simulated with a real cookie jar fed from each response's
 * Set-Cookie headers, because every one of these faults lives in what the
 * browser is left holding — not in any single response.
 */
import fs from 'node:fs'

import { BASE, contactProofs, createReporter, json, makePdf, registerApprovedCompany } from './helpers.mjs'
import { rolesInHint } from '../client/src/sessionHint.js'

const { check, section, finish } = createReporter()

const RUN = Date.now().toString(36)
const MARKER = `@cking-refresh-${RUN}.example.com`

/* ------------------------------------------------------------ the browser -- */

/** Just enough of a cookie jar: set, overwrite, and expire on Max-Age=0. */
class Jar {
  constructor() { this.cookies = new Map() }

  take(response) {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim())
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      const expired = attributes.some((a) => /^max-age=0$/i.test(a))
      if (expired || value === '') this.cookies.delete(name)
      else this.cookies.set(name, decodeURIComponent(value))
    }
    return response
  }

  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
  }

  has(name) { return this.cookies.has(name) }
  get(name) { return this.cookies.get(name) }

  /** What the page itself concludes on load, before asking the server. */
  looksSignedInAs(role) {
    return rolesInHint(this.get('cvrsus_session')).includes(role)
  }
}

async function send(jar, path, { method = 'GET', body } = {}) {
  const csrf = jar.get('cvrsus_csrf')
  return jar.take(await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie: jar.header(),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(csrf && method !== 'GET' ? { 'x-csrf-token': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
}

/* --------------------------------------------------------- the accounts --- */

const account = await registerApprovedCompany({
  companyName: `cking-refresh-${RUN} Ltd`,
  email: `admin.${RUN}${MARKER}`,
  phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
})
const joinKey = account.company.joinKey
const username = account.recruiter.username

const email = `cand.${RUN}${MARKER}`
const phone = `053-${Math.floor(1000000 + Math.random() * 8999999)}`
const form = new FormData()
form.append('cv', new Blob([await makePdf([
  'Refresh Tester', 'Operations analyst - Tel Aviv',
  'ANALYST, SomeCo 2020 - present', '  Reviewed transactions and reported on them daily.',
  '  Built the monthly reconciliation process used by the finance team.',
  'SKILLS: Excel, SQL, reporting',
])],
  { type: 'application/pdf' }), 'cv.pdf')
for (const [k, v] of Object.entries({
  firstName: 'Refresh', lastName: 'Tester', email, phone,
  location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
})) form.append(k, v)
for (const [k, v] of Object.entries(await contactProofs({ email, phone }))) form.append(k, v)
form.append('consent', 'true')
const created = await json(await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form }))

async function signInRecruiter(jar) {
  return send(jar, '/api/recruiter/login', {
    method: 'POST', body: { joinKey, username, password: 'Longenough1!' },
  })
}

async function signInCandidate(jar) {
  const code = await json(await send(jar, '/api/candidate/request-code', {
    method: 'POST', body: { identifier: email },
  }))
  return send(jar, '/api/candidate/verify-code', {
    method: 'POST', body: { identifier: email, code: code.devCode },
  })
}

/* ----------------------------------------------------------------- tests -- */

section('The hint reads a list, and an old single-role hint still works')
check('one role', JSON.stringify(rolesInHint('recruiter')) === '["recruiter"]',
  'the value every live browser already holds must keep meaning what it meant')
check('both roles', rolesInHint('candidate,recruiter').includes('recruiter')
  && rolesInHint('candidate,recruiter').includes('candidate'))
check('nothing', rolesInHint(null).length === 0 && rolesInHint('').length === 0)
check('rubbish is not a role', rolesInHint('admin,recruiter').join() === 'recruiter',
  'a forged hint could only ever name a role, never invent one')

section('Recruiter, then candidate, in one browser')
const both = new Jar()
check('recruiter signs in', (await signInRecruiter(both)).status === 200)
check('candidate signs in', (await signInCandidate(both)).status === 200)

check('refresh: the recruiter page still believes it is signed in',
  both.looksSignedInAs('recruiter'),
  `hint is "${both.get('cvrsus_session')}" — this was fault 1`)
check('refresh: the candidate page too', both.looksSignedInAs('candidate'))
check('and the server agrees for the recruiter',
  (await send(both, '/api/recruiter/me')).status === 200)
check('and for the candidate', (await send(both, '/api/candidate/me')).status === 200)

section('Candidate, then recruiter — order must not matter')
const reversed = new Jar()
await signInCandidate(reversed)
await signInRecruiter(reversed)
check('the candidate page survives the recruiter signing in after it',
  reversed.looksSignedInAs('candidate'), `hint is "${reversed.get('cvrsus_session')}"`)
check('and the recruiter page', reversed.looksSignedInAs('recruiter'))

section('Signing out of one role leaves the other alone')
await send(reversed, '/api/auth/sign-out', { method: 'POST', body: { role: 'recruiter' } })
check('the recruiter is signed out', !reversed.has('cvrsus_recruiter')
  && !reversed.looksSignedInAs('recruiter'))
check('the candidate is not', reversed.has('cvrsus_candidate')
  && reversed.looksSignedInAs('candidate'),
  'this was fault 3: one sign-out ended both')
check('and the server still accepts the candidate',
  (await send(reversed, '/api/candidate/me')).status === 200)

await send(reversed, '/api/auth/sign-out', { method: 'POST', body: { role: 'candidate' } })
check('signing out of the last role removes the hint entirely',
  !reversed.has('cvrsus_session'))

section('A sign-out that names no role still ends everything')
const legacy = new Jar()
await signInRecruiter(legacy)
await signInCandidate(legacy)
await send(legacy, '/api/auth/sign-out', { method: 'POST' })
check('both session cookies gone', !legacy.has('cvrsus_recruiter') && !legacy.has('cvrsus_candidate'))
check('and the hint', !legacy.has('cvrsus_session'))

section('Being signed out elsewhere ends only that role')
const laptop = new Jar()
await signInCandidate(laptop)
await signInRecruiter(laptop)
const phoneJar = new Jar()
await signInRecruiter(phoneJar)

const bumped = await send(laptop, '/api/recruiter/me')
check('the laptop recruiter session is superseded', bumped.status === 401)
check('its recruiter cookie is cleared', !laptop.has('cvrsus_recruiter'))
check('but the candidate session on that laptop survives',
  laptop.has('cvrsus_candidate') && laptop.looksSignedInAs('candidate'),
  'a recruiter sign-in on a phone has nothing to do with the candidate account')
check('and still works', (await send(laptop, '/api/candidate/me')).status === 200)

section('The recruiter page does not sign out on an ordinary failure')
const panel = fs.readFileSync(new URL('../client/src/pages/HrPanel.jsx', import.meta.url), 'utf8')
check('only a refused session ends it',
  !/load\(\)\.catch\(\(\) => signOutRequest\(\)\)/.test(panel)
  && /status === 401/.test(panel),
  'this was fault 2: a 500 or a timeout on load used to sign the recruiter out')

section('Cleanup')
const { default: Database } = await import('better-sqlite3')
const db = new Database(new URL('../server/data/cking.db', import.meta.url).pathname.slice(1))
const { deleteCandidateCompletely } = await import('../server/src/profiles.js')
for (const name of deleteCandidateCompletely(created.id)) {
  const p = new URL(`../server/uploads/${name}`, import.meta.url).pathname.slice(1)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}
const recruiterIds = db.prepare('SELECT id FROM recruiters WHERE company_id = ?')
  .all(account.company.id).map((r) => r.id)
if (recruiterIds.length) {
  db.prepare(`DELETE FROM recruiter_password_resets WHERE recruiter_id IN (${recruiterIds.join(',')})`).run()
  db.prepare('DELETE FROM recruiters WHERE company_id = ?').run(account.company.id)
}
db.prepare('DELETE FROM companies WHERE id = ?').run(account.company.id)
check('test accounts removed',
  !db.prepare('SELECT id FROM candidates WHERE id = ?').get(created.id)
  && !db.prepare('SELECT id FROM companies WHERE id = ?').get(account.company.id))
db.close()

finish()
