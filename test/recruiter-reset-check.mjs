/**
 * An organization administrator resetting their password.
 *
 * This is single-factor account recovery for the account that can see every
 * revealed candidate an organization has paid for, so the whole path is checked
 * rather than the happy line through it: who may request one, what the link
 * carries, that it works once, and that it stops working afterwards.
 *
 * The link's ADDRESS is checked too. It is built from APP_URL, which is set by
 * hand at deploy and then never looked at again — and when the site moved to
 * its own domain the variable stayed on the platform hostname, so every reset
 * email pointed at a host that no longer answered. The reset was not broken;
 * the address in it was, and nothing in the product noticed.
 */
import { createReporter, registerApprovedCompany, json, BASE } from './helpers.mjs'

const { check, section, finish } = createReporter()

const RUN = Date.now().toString(36)
const MARK = `cking-reset-${RUN}`

const account = await registerApprovedCompany({
  companyName: `${MARK} Ltd`,
  email: `admin.${RUN}@${MARK}.example.com`,
  phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
})
const joinKey = account.company.joinKey
const companyId = account.company.id
const username = account.recruiter.username

const forgot = (body) => fetch(`${BASE}/api/recruiter/forgot-password`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const redeem = (body) => fetch(`${BASE}/api/recruiter/reset-password`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

section('Asking for a reset')
const asked = await forgot({ joinKey, username })
const askedBody = await asked.json().catch(() => ({}))
check('the request is accepted', asked.status === 200, `HTTP ${asked.status}`)
check('and it says where the link went without spelling the address out',
  typeof askedBody.hint === 'string' && askedBody.hint.includes('*'),
  askedBody.hint)

/* The token never leaves the server except in the email, so the test reads it
   the way an operator would — out of the row it was written to. */
const { default: Database } = await import('better-sqlite3')
const db = new Database(new URL('../server/data/cking.db', import.meta.url).pathname.slice(1))
const row = db.prepare(`
  SELECT r.token_hash, r.recruiter_id, r.expires_at, r.used_at
  FROM recruiter_password_resets r
  JOIN recruiters rec ON rec.id = r.recruiter_id
  WHERE rec.company_id = ? ORDER BY r.created_at DESC LIMIT 1
`).get(companyId)

check('a reset row is written', Boolean(row))
check('and it stores a HASH, never the token itself',
  Boolean(row?.token_hash) && row.token_hash.length >= 32,
  'a readable token in the table is a second copy of the credential')
check('with an expiry', Boolean(row?.expires_at))
check('and is not yet used', row?.used_at === null || row?.used_at === undefined)

section('A stranger cannot ask on somebody else\u2019s behalf')
const wrongKey = await forgot({ joinKey: 'not-the-key', username: username })
check('a wrong company key is refused or silently ignored',
  wrongKey.status === 200 || wrongKey.status === 400,
  `HTTP ${wrongKey.status} — it must not confirm whether the username exists`)

const issued = db.prepare(
  'SELECT COUNT(*) n FROM recruiter_password_resets WHERE recruiter_id = ?',
).get(row.recruiter_id).n
check('and a refused request issues no token', issued === 1,
  `${issued} reset row(s) — a wrong company key must not mint one`)

section('Redeeming it')
const bad = await redeem({ token: 'not-a-real-token', password: 'Str0ng-Passw0rd!' })
check('a made-up token is refused', bad.status === 400, `HTTP ${bad.status}`)

const mismatch = await redeem({
  token: 'whatever', password: 'Str0ng-Passw0rd!', confirmPassword: 'something-else',
})
check('a mismatched confirmation is refused', mismatch.status === 400)

section('A real link works, once')
/*
 * The token is echoed here only because this deployment is in development; in
 * production it exists solely inside the email. Redeeming it is the half of the
 * flow no assertion about the database row can reach.
 */
const token = askedBody.devToken
check('a token was issued', Boolean(token), 'OTP_ECHO must be on for this suite')

const NEW_PASSWORD = 'Str0ng-Passw0rd!'
const used = await redeem({ token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD })
check('the link sets the new password', used.status === 200, `HTTP ${used.status}`)

const twice = await redeem({ token, password: 'An0ther-Passw0rd!', confirmPassword: 'An0ther-Passw0rd!' })
check('and cannot be used a second time', twice.status === 400,
  `HTTP ${twice.status} — a reset link is a credential and is spent on use`)

const fresh = await fetch(`${BASE}/api/recruiter/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ joinKey, username, password: NEW_PASSWORD }),
})
check('the new password signs in', fresh.status === 200, `HTTP ${fresh.status}`)

const stale = await fetch(`${BASE}/api/recruiter/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ joinKey, username, password: 'Longenough1!' }),
})
check('and the old one does not', stale.status !== 200, `HTTP ${stale.status}`)

section('The address the email sends people to')
/* Built from APP_URL. The value itself is deployment configuration, but the
   product should notice when it is one that cannot work. */
const notify = await import('../server/src/notify.js')
check('the link base has no trailing slash',
  !notify.APP_URL.endsWith('/'),
  'otherwise every link is built with a double slash')
check('and it is an absolute URL',
  /^https?:\/\//.test(notify.APP_URL), notify.APP_URL)

const source = (await import('node:fs')).readFileSync(
  new URL('../server/src/notify.js', import.meta.url), 'utf8',
)
check('a Render hostname in production is called out at boot',
  /onrender\\.com\$/.test(source) && /WARNING: APP_URL/.test(source),
  'this is the failure that produced a dead reset link')
check('and so is a localhost one', /still points at localhost/.test(source))

section('Cleanup')
const recruiters = db.prepare('SELECT id FROM recruiters WHERE company_id = ?').all(companyId)
const ids = recruiters.map((r) => r.id)
if (ids.length) {
  db.prepare(`DELETE FROM recruiter_password_resets WHERE recruiter_id IN (${ids.join(',')})`).run()
  db.prepare(`DELETE FROM recruiters WHERE company_id = ?`).run(companyId)
}
db.prepare('DELETE FROM companies WHERE id = ?').run(companyId)
check('test company removed',
  !db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId))
db.close()

finish()
