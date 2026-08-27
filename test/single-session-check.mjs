/**
 * One recruiter account, one device.
 *
 * A seat is bought per person and the workspace behind it shows revealed
 * contact details, so an account in use in two places at once is either a
 * shared password or a stolen session. The rule is that the newest sign-in
 * wins: it claims the account, and the token the older device is holding stops
 * working on its very next request.
 *
 * What is asserted here is the part that is easy to get subtly wrong — not
 * "the second sign-in succeeds", which is trivially true, but that the first
 * one genuinely stops, that it stops for *every* route rather than the one the
 * check happened to try, that the shape of the refusal tells the client what
 * happened, and that none of it reaches an account it was not about.
 */
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'

import { BASE, createReporter, json, registerAndSignIn } from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const NAME = `Seat ${RUN}`
const PASSWORD = 'Longenough1!'

/** A device: its own cookie jar, exactly as a second browser would have. */
function device(label) {
  const store = new Map()
  return {
    label,
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
    cookie() {
      return [...store].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    /* A browser echoes the CSRF cookie in a header on every unsafe request, so
       a device standing in for one has to as well — otherwise this measures the
       CSRF guard rather than the session rule. */
    headers(extra = {}) {
      const csrf = store.get('cvrsus_csrf')
      return { cookie: this.cookie(), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...extra }
    },
    has: (name) => store.has(name),
    async get(path) {
      const res = await fetch(`${BASE}${path}`, { headers: { cookie: this.cookie() } })
      this.absorb(res)
      return res
    },
    async post(path, body) {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      this.absorb(res)
      return res
    },
    async signIn(joinKey, username) {
      return json(await this.post('/api/recruiter/login', { joinKey, username, password: PASSWORD }))
    },
    signOut() {
      return this.post('/api/auth/sign-out')
    },
  }
}

const account = await registerAndSignIn({
  companyName: NAME, firstName: 'Dana', lastName: `Seat${RUN}`,
  email: `dana.${RUN}@example.com`,
})
const { joinKey } = account.company
const username = `dana.seat${RUN}`
db.prepare(`UPDATE companies SET approval_status = 'approved' WHERE id = ?`).run(account.company.id)

// ---------------------------------------------------------------------------

section('A second device takes the account')

const laptop = device('laptop')
const phone = device('phone')

await laptop.signIn(joinKey, username)
check('the first device is signed in', (await laptop.get('/api/recruiter/me')).status === 200)

await phone.signIn(joinKey, username)
check('the second device is signed in too', (await phone.get('/api/recruiter/me')).status === 200)

const afterTakeover = await laptop.get('/api/recruiter/me')
check('and the first device is now refused', afterTakeover.status === 401,
  `HTTP ${afterTakeover.status}`)

const refusal = await afterTakeover.json().catch(() => ({}))
check('told, in words, that this is what happened',
  /another device/i.test(refusal.error ?? ''), refusal.error ?? '(no message)')
check('and machine-readably, so the page can react rather than look broken',
  refusal.reason === 'session-superseded', refusal.reason ?? '(none)')

/*
 * The session is enforced where every recruiter route already passes, so this
 * samples routes of different kinds — a read, a workspace route behind its own
 * gate, and a write — rather than trusting that one 401 covers the rest.
 */
section('It is the account that is signed out, not one endpoint')

for (const path of ['/api/recruiter/me', '/api/hr/candidates', '/api/hr/search/config']) {
  const res = await laptop.get(path)
  check(`${path} refuses the superseded device`, res.status === 401, `HTTP ${res.status}`)
}

const write = await laptop.post('/api/hr/parse-jd', { text: 'Backend engineer, Tel Aviv.' })
check('and so does a write', write.status === 401, `HTTP ${write.status}`)

section('The dead device is not left looking signed in')

check('its session cookie was cleared on the way out', !laptop.has('cvrsus_recruiter'))
check('and so was the hint the UI renders from', !laptop.has('cvrsus_session'))

section('The surviving device is untouched')

check('the second device still works after the first was refused',
  (await phone.get('/api/recruiter/me')).status === 200)

section('Signing out the old device cannot end the new one')

/*
 * A superseded device pressing Sign out is the ordinary case — somebody comes
 * back to a laptop and tidies up. It must clear its own cookies without
 * reaching across and ending the session that replaced it.
 */
const stale = device('stale')
await stale.signIn(joinKey, username)
const current = device('current')
await current.signIn(joinKey, username)

check('the stale device can still sign out', (await stale.signOut()).status === 200)
check('and the live session survives it',
  (await current.get('/api/recruiter/me')).status === 200)

check('while its own sign-out does end its session',
  (await current.signOut()).status === 200)
check('after which nothing it holds works',
  (await current.get('/api/recruiter/me')).status === 401)

section('A token from before the rule existed is not accepted')

/*
 * Such a token names no session, so it cannot be told apart from a second copy
 * of itself — which is the one thing this is here to prevent. Refusing it costs
 * everyone signed in at the time a single fresh sign-in.
 */
const legacy = device('legacy')
await legacy.signIn(joinKey, username)
const recruiterId = db.prepare(
  `SELECT id FROM recruiters WHERE company_id = ? AND username = ?`,
).get(account.company.id, username).id

const auth = await import('../server/src/auth.js')
const secret = process.env.SESSION_SECRET ?? 'dev-secret-change-me'
const sidless = auth.issueToken(secret, { role: 'recruiter', id: recruiterId }, 12)
const withSid = auth.issueToken(secret, { role: 'recruiter', id: recruiterId, sid: 'not-the-one' }, 12)

const asLegacy = await fetch(`${BASE}/api/recruiter/me`, {
  headers: { authorization: `Bearer ${sidless}` },
})
check('a validly signed token naming no session is refused', asLegacy.status === 401,
  `HTTP ${asLegacy.status}`)

const asGuess = await fetch(`${BASE}/api/recruiter/me`, {
  headers: { authorization: `Bearer ${withSid}` },
})
check('and so is one naming a session the account is not on', asGuess.status === 401,
  `HTTP ${asGuess.status}`)

section('Candidates are unaffected')

/*
 * The rule is about a paid seat, not about people. A candidate reading their
 * own profile on a phone and a laptop is ordinary use, and nothing here should
 * have reached them.
 */
const cookieAuth = await import('../server/src/auth.js')
check('a candidate token still carries no session id — nothing to revoke',
  cookieAuth.readToken(
    cookieAuth.issueToken(secret, { role: 'candidate', id: 1 }, 12), secret,
  ).sid === null)

// ------------------------------------------------------------------ tidy ---

section('Cleanup')

const ids = db.prepare(`SELECT id FROM companies WHERE name = ?`).all(NAME).map((r) => r.id)
if (ids.length) {
  const list = ids.join(',')
  const rl = db.prepare(`SELECT id FROM recruiters WHERE company_id IN (${list})`).all()
    .map((r) => r.id).join(',') || '-1'
  db.exec(`
    DELETE FROM retrieval_sessions WHERE recruiter_id IN (${rl});
    DELETE FROM jobs WHERE recruiter_id IN (${rl});
    DELETE FROM folder_items WHERE folder_id IN (SELECT id FROM folders WHERE recruiter_id IN (${rl}));
    DELETE FROM folders WHERE recruiter_id IN (${rl});
    DELETE FROM seat_usage_periods WHERE recruiter_id IN (${rl});
    DELETE FROM seat_purchases WHERE company_id IN (${list});
    DELETE FROM billing_ledger WHERE company_id IN (${list});
    DELETE FROM organization_reveals WHERE company_id IN (${list});
    DELETE FROM recruiters WHERE company_id IN (${list});
    DELETE FROM companies WHERE id IN (${list});
  `)
}
check('test company removed', db.prepare(
  `SELECT COUNT(*) AS n FROM companies WHERE name = ?`,
).get(NAME).n === 0)

finish()
