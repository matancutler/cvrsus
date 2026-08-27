import fs from 'node:fs'
import PDFDocument from 'pdfkit'

export const BASE = process.env.CKING_URL ?? 'http://localhost:5175'

/** Reads server/.env without pulling in dotenv, so tests run standalone. */
export function serverEnv() {
  const path = new URL('../server/.env', import.meta.url)
  if (!fs.existsSync(path)) return {}

  return Object.fromEntries(
    fs.readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const eq = line.indexOf('=')
        return [line.slice(0, eq).trim(), line.slice(eq + 1).trim()]
      }),
  )
}

/**
 * Walks one contact detail through the real verification round trip.
 *
 * Account creation now proves both the email address and the phone number, so
 * every test that creates an account has to do what a person does: ask for a
 * code, read it, and send it back. The code is read from the response, which
 * only happens because OTP_ECHO is on in development — the check below says so
 * out loud rather than failing several steps later with an unhelpful 400.
 */
export async function proveContact(channel, destination) {
  const sent = await json(await fetch(`${BASE}/api/verify/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, destination }),
  }))

  if (!sent.devCode) {
    throw new Error('Set OTP_ECHO=true in server/.env — the tests read the code from the response.')
  }

  const confirmed = await json(await fetch(`${BASE}/api/verify/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, destination, code: sent.devCode }),
  }))

  return confirmed.proof
}

/**
 * Delete a candidate account the way the account page does.
 *
 * The route wants an explicit acknowledgement that the consequences have been
 * read — the checkbox in the dialog. Kept in one place so a change to what the
 * endpoint asks for is a change to one function rather than to every suite that
 * deletes a fixture.
 *
 * Returns the raw response so a caller can assert on the status.
 */
export async function deleteCandidate(token, { acknowledged = true } = {}) {
  return fetch(`${BASE}/api/candidate/me`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ acknowledged }),
  })
}

/** Both proofs, in the field names the sign-up routes read them from. */
export async function contactProofs({ email, phone }) {
  return {
    emailProof: await proveContact('email', email),
    phoneProof: await proveContact('phone', phone),
  }
}

/**
 * Registers a company and opens the door for it.
 *
 * Audit §15 removed the shared sign-up secret, so registration takes nobody's
 * word for anything up front — instead a new company lands 'pending' and every
 * /api/hr route refuses it until a human approves. Tests that then go on to
 * search or reveal need an approved company, so approval happens here rather
 * than being repeated (and forgotten) in six files.
 *
 * The approval is written straight to the database rather than through an API,
 * because there is no self-service route to it and there should not be. The
 * connection is opened lazily, so a test that never registers a company does
 * not open the database at all.
 *
 * §17 also made email, phone and website mandatory and tightened the password
 * rules; the defaults below satisfy both so a caller only states what it cares
 * about.
 */
export async function registerCompany(body = {}) {
  const fields = {
    firstName: 'Maya',
    lastName: 'Cohen',
    email: 'maya@example.com',
    phone: '050-123-4567',
    website: 'example.com',
    password: 'Longenough1!',
    confirmPassword: 'Longenough1!',
    // The 18+ affirmation and agreement, which /api/company/register now
    // requires. Before `...body` so a test can still send it as false.
    consent: 'true',
    ...body,
  }

  /*
   * Proofs, unless the caller supplied their own — a test checking that an
   * unproved address is refused passes `emailProof: ''` and must not have it
   * quietly filled in for it. A blank email or phone cannot be proved at all,
   * which is exactly the case those tests are making.
   */
  const proofs = ('emailProof' in body || 'phoneProof' in body || !fields.email || !fields.phone)
    ? {}
    : await contactProofs(fields)

  return fetch(`${BASE}/api/company/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...proofs, ...fields }),
  })
}

/**
 * Registers a company and signs its administrator in.
 *
 * Registering no longer returns a session or the company key: the key is the
 * credential, and it is released by whoever approves the account. Tests still
 * need a working session, so this does what an operator does — reads the key
 * out of the database and signs in with it.
 *
 * Returns the shape the suites used to get from registerCompany directly, so
 * call sites keep reading `.token`, `.company` and `.recruiter`.
 */
export async function registerAndSignIn(body = {}) {
  const registered = await json(await registerCompany(body))

  if (!accountsDb) {
    const mod = await import('better-sqlite3')
    const Database = mod.default
    accountsDb = new Database(new URL('../server/data/cking.db', import.meta.url).pathname.slice(1))
  }

  const row = accountsDb.prepare(
    `SELECT join_key, approval_status FROM companies WHERE id = ?`,
  ).get(registered.company.id)

  const username = [body.firstName ?? 'Maya', body.lastName ?? 'Cohen']
    .join('.').toLowerCase()

  const signedIn = await json(await fetch(`${BASE}/api/recruiter/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      joinKey: row.join_key,
      username,
      password: body.password ?? 'Longenough1!',
    }),
  }))

  /*
   * The login response is deliberately leaner than the old registration one —
   * it carries what a sign-in screen needs, not a full account record. The two
   * fields the suites rely on are read from the database, which is where they
   * live and where an assertion about them belongs.
   */
  const admin = accountsDb.prepare(
    `SELECT is_org_admin FROM recruiters WHERE id = ?`,
  ).get(signedIn.recruiter.id)

  return {
    token: signedIn.token,
    company: {
      ...registered.company,
      joinKey: row.join_key,
      approvalStatus: row.approval_status,
    },
    recruiter: { ...signedIn.recruiter, isOrgAdmin: Boolean(admin?.is_org_admin) },
  }
}

let accountsDb = null

let accounts = null

/** Marks a registered company approved, so its recruiters can reach /api/hr. */
export async function approveCompanyById(companyId) {
  if (!accounts) accounts = await import('../server/src/accounts.js')
  accounts.approveCompany(companyId)
}

/**
 * The same, by name, for a test that never parsed the registration response —
 * the cookie check reads headers rather than a body, and consuming it there to
 * find an id would defeat what it is measuring.
 */
export async function approveCompanyByName(name) {
  const { default: db } = await import('../server/src/db.js')
  const row = db.prepare(`SELECT id FROM companies WHERE name = ?`).get(name)
  if (!row) throw new Error(`No company named "${name}" to approve.`)
  await approveCompanyById(row.id)
}

/** Register, sign in, approve, and hand back a working session. The usual case. */
export async function registerApprovedCompany(body = {}) {
  const result = await registerAndSignIn(body)
  await approveCompanyById(result.company.id)
  return result
}

/** Renders `lines` into a real PDF, since the uploader accepts PDF only. */
export function makePdf(lines) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks = []
    doc.on('data', (chunk) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.fontSize(11)
    for (const line of lines) doc.text(line)
    doc.end()
  })
}

/**
 * Smallest valid PNG: a single opaque pixel. Enough to exercise the photo
 * upload path without checking a binary fixture into the repo.
 */
export function makePng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
}

export function createReporter() {
  const failures = []

  return {
    check(label, condition, detail = '') {
      if (!condition) failures.push(label)
      console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
    },
    section(title) {
      console.log(`\n${title}`)
    },
    finish() {
      console.log(`\n${failures.length === 0
        ? 'All checks passed.'
        : `${failures.length} FAILED: ${failures.join('; ')}`}\n`)
      process.exit(failures.length === 0 ? 0 : 1)
    },
  }
}

export async function json(response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${response.status}: ${body.error ?? 'unknown error'}`)
  return body
}
