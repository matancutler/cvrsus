/**
 * A recruiter account with capacity, and a Triage holding sample applicants,
 * so the rolling work can be looked at rather than described.
 *
 * Everything it creates is named with the same marker, so it can be removed in
 * one go later. Nothing here touches production: it writes to the local
 * database only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

const BASE = process.env.CKING_URL ?? 'http://127.0.0.1:5199'
const root = fileURLToPath(new URL('../../', import.meta.url))

const db = new Database(path.join(root, 'server/data/cking.db'))
const uploadDir = path.join(root, 'server/uploads')

const MARK = 'cvrsus-test'
const EMAIL = 'test.recruiter@cvrsus-test.example.com'
const PASSWORD = 'TestRecruiter!2026'

/* ------------------------------------------------------- sample material --- */

const JD = `Payments Operations Analyst — Tel Aviv

We review card-not-present transactions for a payments company and need
somebody who has done this work rather than read about it.

Requirements:
- 3+ years reviewing card-not-present transactions
- Chargeback and dispute handling end to end
- SQL for investigating transaction data
- Hebrew and English

Nice to have:
- Fraud tooling and rules engines
- Experience with a payment service provider or acquirer
`

const PEOPLE = [
  ['Noa Bar-Lev', 'noa.barlev', ['chargebacks', 'disputes', 'SQL', 'fraud rules'], 7, 'Tel Aviv-Yafo'],
  ['Amir Cohen', 'amir.cohen', ['chargebacks', 'SQL'], 5, 'Ramat Gan'],
  ['Yael Shalev', 'yael.shalev', ['fraud rules', 'SQL', 'disputes'], 4, 'Herzliya'],
  ['Dan Mizrahi', 'dan.mizrahi', ['customer support', 'Excel'], 3, 'Haifa'],
  ['Rivka Green', 'rivka.green', ['bookkeeping', 'invoices'], 6, 'Jerusalem'],
  ['Omer Katz', 'omer.katz', ['chargebacks', 'acquiring', 'SQL', 'Hebrew'], 9, 'Tel Aviv-Yafo'],
  ['Maya Levi', 'maya.levi', ['disputes', 'customer support'], 2, 'Netanya'],
  ['Eitan Peretz', 'eitan.peretz', ['SQL', 'data analysis'], 5, 'Tel Aviv-Yafo'],
]

/* A PDF the parser can read, built the way the test helpers build theirs. */
async function pdf(lines) {
  const { default: PDFDocument } = await import('pdfkit')
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 })
    const chunks = []
    doc.on('data', (c) => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    for (const line of lines) doc.fontSize(11).text(line)
    doc.end()
  })
}

const cvFor = ([name, handle, skills, years, city]) => pdf([
  name,
  `${handle}@example.com · 05${(2 + years) % 10}-${String(1000000 + years * 11111).slice(0, 7)} · ${city}`,
  '',
  'EXPERIENCE',
  `Payments operations analyst, ${years} years.`,
  'Reviewed card-not-present transactions daily and owned the dispute process',
  'end to end, working with the acquirer on representment evidence.',
  '',
  `SKILLS: ${skills.join(', ')}`,
  '',
  'LANGUAGES: Hebrew (native), English (fluent)',
])

/* ------------------------------------------------------------- the account --- */

/*
 * Registration goes through the real route, contact proofs and all, because a
 * test account made by writing rows directly is an account that has never been
 * through the thing it is meant to be testing.
 *
 * Signing in takes a join key and a username rather than an email — that is
 * how a recruiter signs in to this product, and the test account should be no
 * different from a real one.
 */
const { contactProofs } = await import('../../test/helpers.mjs')

let recruiter = db.prepare(`SELECT id, company_id FROM recruiters WHERE email = ?`).get(EMAIL)

if (recruiter) {
  console.log(`Test recruiter already exists (recruiter ${recruiter.id}). Topping up capacity.`)
} else {
  const fields = {
    companyName: `${MARK} Ltd`,
    firstName: 'Test',
    lastName: 'Recruiter',
    email: EMAIL,
    phone: '052-000-1234',
    website: 'example.com',
    password: PASSWORD,
    confirmPassword: PASSWORD,
    consent: 'true',
  }

  const proofs = await contactProofs(fields)
  const register = await fetch(`${BASE}/api/company/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...proofs, ...fields }),
  })

  const body = await register.json().catch(() => ({}))
  if (!register.ok) {
    console.error('register failed:', register.status, body.error ?? body)
    process.exit(1)
  }

  recruiter = db.prepare(`SELECT id, company_id FROM recruiters WHERE email = ?`).get(EMAIL)
  console.log(`Created recruiter ${recruiter.id} at company ${recruiter.company_id}.`)
}

/* Approved, funded, and an administrator — the state a paying customer is in,
   reached the way the product reaches it. */
const { approveCompany } = await import('../src/accounts.js')
approveCompany(recruiter.company_id)
db.prepare(`UPDATE companies SET triage_cv_balance = 2000, reveal_balance = 200 WHERE id = ?`)
  .run(recruiter.company_id)
db.prepare(`UPDATE recruiters SET is_org_admin = 1 WHERE id = ?`).run(recruiter.id)

const joinKey = db.prepare(`SELECT join_key FROM companies WHERE id = ?`).get(recruiter.company_id).join_key

/* --------------------------------------------------------------- sign in --- */

const login = await fetch(`${BASE}/api/recruiter/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ joinKey, username: 'test.recruiter', password: PASSWORD }),
})
const session = await login.json().catch(() => ({}))
if (!login.ok) {
  console.error('login failed:', login.status, session.error ?? session)
  process.exit(1)
}
const H = { 'content-type': 'application/json', authorization: `Bearer ${session.token}` }

/* ---------------------------------------------------------- a live session --- */

const draft = await (await fetch(`${BASE}/api/hr/triage`, { method: 'POST', headers: H, body: '{}' })).json()
const id = draft.triage.id

await fetch(`${BASE}/api/hr/triage/${id}`, {
  method: 'PATCH', headers: H,
  body: JSON.stringify({ jd: JD, title: 'Payments Operations Analyst — sample' }),
})

/* The first delivery: five CVs. The other three are left on disk for you to
   add later, which is the whole point of the rolling work. */
const form = new FormData()
for (const person of PEOPLE.slice(0, 5)) {
  form.append('cvs', new Blob([await cvFor(person)], { type: 'application/pdf' }), `${person[1]}.pdf`)
}
const uploaded = await (await fetch(`${BASE}/api/hr/triage/${id}/files`, {
  method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body: form,
})).json()

const launch = await fetch(`${BASE}/api/hr/triage/${id}/launch`, { method: 'POST', headers: H, body: '{}' })

/* The three held back, written where they can be picked up from a file dialog. */
const samples = path.join(root, 'sample-cvs')
fs.mkdirSync(samples, { recursive: true })
for (const person of PEOPLE.slice(5)) {
  fs.writeFileSync(path.join(samples, `${person[1]}.pdf`), await cvFor(person))
}
fs.writeFileSync(path.join(samples, 'job-description.txt'), JD)

console.log('')
console.log('  Sign in at   :', BASE + '/hr')
console.log('  Join key     :', joinKey)
console.log('  Username     : test.recruiter')
console.log('  Password     :', PASSWORD)
console.log('  Triage       :', `#${id}, ${uploaded.results?.filter((r) => r.status === 'added').length ?? 0} CVs, launch ${launch.status}`)
console.log('  More CVs     :', samples)
console.log('')

db.close()
