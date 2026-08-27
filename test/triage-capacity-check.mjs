/**
 * Triage is metered in CVs, not in sessions.
 *
 * The per-session model is gone: a workspace is free and unlimited, and what an
 * organization buys is a pool of CV processing capacity that it spends across
 * as many job descriptions as it likes.
 *
 * Four things in that change are silent when they break, so they are asserted
 * first:
 *
 *   - a workspace can always be created, at any balance, including zero;
 *   - the charge is the number of VALID CVs, not the number of files chosen;
 *   - the organization pool and a seat's allowance are BOTH enforced, and the
 *     two failures are told apart — one sends you to a checkout, the other to
 *     your administrator;
 *   - capacity is handed back for files that turn out not to be readable.
 *
 * Each of those, wrong, either overcharges a customer or lets one seat spend an
 * organization's whole balance. Neither shows up in the interface.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import {
  BASE, approveCompanyById, createReporter, json, makePdf, registerAndSignIn,
} from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))
const uploadDir = fileURLToPath(new URL('../server/uploads/', import.meta.url))

const H = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })
const AUTH = (token) => ({ authorization: `Bearer ${token}` })

const JD = `Senior Backend Engineer — Tel Aviv

We need a senior backend engineer for our payments platform.

Requirements:
- 5+ years building production backend services
- Strong Node.js and TypeScript
- PostgreSQL schema design and query tuning
- Distributed systems and message queues

Nice to have:
- Kubernetes and Terraform
- Payments domain experience
`

const cv = (name, lines) => makePdf([name, ...lines])

const capacity = (companyId) => db.prepare(
  `SELECT triage_cv_balance FROM companies WHERE id = ?`,
).get(companyId).triage_cv_balance

const grant = (companyId, cvs) => db.prepare(
  `UPDATE companies SET triage_cv_balance = ? WHERE id = ?`,
).run(cvs, companyId)

const setAllowance = (recruiterId, cvs) => db.prepare(
  `UPDATE recruiters SET triage_allowance = ?, triage_used = 0 WHERE id = ?`,
).run(cvs, recruiterId)

async function upload(token, triageId, files) {
  const form = new FormData()
  for (const [name, bytes] of files) {
    form.append('cvs', new Blob([bytes], { type: 'application/pdf' }), name)
  }
  return json(await fetch(`${BASE}/api/hr/triage/${triageId}/files`, {
    method: 'POST', headers: AUTH(token), body: form,
  }))
}

async function draft(token, title) {
  const made = await json(await fetch(`${BASE}/api/hr/triage`, {
    method: 'POST', headers: H(token), body: JSON.stringify({}),
  }))
  await json(await fetch(`${BASE}/api/hr/triage/${made.triage.id}`, {
    method: 'PATCH', headers: H(token), body: JSON.stringify({ jd: JD, title }),
  }))
  return made.triage.id
}

const org = await registerAndSignIn({
  companyName: `Capacity ${RUN}`, firstName: 'Noa', lastName: `Admin${RUN}`,
  email: `noa.${RUN}@example.com`,
})
await approveCompanyById(org.company.id)

// ------------------------------------------------------------- the packs ---

section('Capacity is sold in CVs')

const catalogue = await json(await fetch(`${BASE}/api/pricing`))
check('the packs are CV quantities',
  catalogue.triage.map((p) => p.quantity).join(',') === '100,200,300,500')
check('at the published prices',
  catalogue.triage.map((p) => p.total).join(',') === '3000,5500,7500,11500')
check('the unit price is per CV and keeps its cents',
  catalogue.triage[0].formattedUnit.includes('0.30'))
check('and it falls with volume',
  catalogue.triage[0].unit > catalogue.triage[catalogue.triage.length - 1].unit)
check('nothing in the catalogue counts Triages',
  !/\d+\s*Triages?\b/i.test(JSON.stringify(catalogue.triage)))

// ------------------------------------------------- unlimited workspaces ---

section('Workspaces are free and unlimited')

/* The welcome allowance is spent here rather than assumed absent: this suite
   is about what buying and launching do to a balance, and it needs a known
   starting point. pricing-check is where the grant itself is proved. */
db.prepare(`UPDATE companies SET triage_cv_balance = 0 WHERE id = ?`).run(org.company.id)

check('an organization with nothing bought has no capacity', capacity(org.company.id) === 0)

const ids = []
for (let i = 0; i < 4; i += 1) ids.push(await draft(org.token, `Role ${i}`))
check('four workspaces can be created at a zero balance', ids.filter(Boolean).length === 4)
check('and none of them cost anything', capacity(org.company.id) === 0)

const listed = await json(await fetch(`${BASE}/api/hr/triages`, { headers: H(org.token) }))
check('the dashboard reports a CV balance, not a number of Triages',
  listed.balance === 0 && listed.triages.length === 4 && listed.credits === undefined)

// ------------------------------------------------------ only valid CVs ---

section('Only valid CVs are charged')

const target = ids[0]
const good = [
  ['a.pdf', await cv('Dana Kovacs', ['dana@example.com', 'Node.js, TypeScript, PostgreSQL, Kafka.'])],
  ['b.pdf', await cv('Omer Levi', ['omer@example.com', 'Python, Django, PostgreSQL.'])],
  ['c.pdf', await cv('Roni Shapira', ['roni@example.com', 'Java, Spring, Kafka.'])],
]
await upload(org.token, target, good)

/* One duplicate, one empty file, one that is not a document at all. §6 says the
   charge counts none of them. */
const noise = await upload(org.token, target, [
  ['a-copy.pdf', good[0][1]],
  ['empty.pdf', Buffer.alloc(0)],
  ['fake.pdf', Buffer.from('this is not a pdf, whatever the extension says')],
])
check('the duplicate is recognised',
  noise.results.some((r) => r.status === 'duplicate'))
check('the empty and the fake are rejected',
  noise.results.filter((r) => r.status === 'rejected').length === 2)
check('so the Triage holds only the three real CVs', noise.triage.counts.total === 3)

const ready = await json(await fetch(`${BASE}/api/hr/triage/${target}`, { headers: H(org.token) }))
check('and the quantity quoted before launch is three, not six', ready.readiness.cvs === 3)

// --------------------------------------------------- the two-level check ---

section('The organization pool and the seat allowance are both enforced')

grant(org.company.id, 2)
let state = await json(await fetch(`${BASE}/api/hr/triage/${target}`, { headers: H(org.token) }))
check('two CVs of capacity is not enough for three',
  state.readiness.ready === false
  && state.readiness.problems.some((p) => p.code === 'no_capacity'))
check('and the message names the shortfall',
  /Buy 1 more/.test(state.readiness.problems.find((p) => p.code === 'no_capacity')?.message ?? ''))

let refused = await fetch(`${BASE}/api/hr/triage/${target}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
})
check('launching short of capacity answers 402 — pay for this', refused.status === 402)

/* Now the other failure: plenty in the pool, but this seat is capped below what
   the launch needs. The two must not be told the same way. */
grant(org.company.id, 600)
const adminRecruiter = db.prepare(
  `SELECT id FROM recruiters WHERE company_id = ? ORDER BY id`,
).get(org.company.id).id
setAllowance(adminRecruiter, 2)

state = await json(await fetch(`${BASE}/api/hr/triage/${target}`, { headers: H(org.token) }))
check('with capacity in the pool but a seat capped below it, launch is still blocked',
  state.readiness.ready === false
  && state.readiness.problems.some((p) => p.code === 'over_allowance'))
check('and the reason points at an administrator, not at a checkout',
  /administrator/i.test(state.readiness.problems.find((p) => p.code === 'over_allowance')?.message ?? ''))

refused = await fetch(`${BASE}/api/hr/triage/${target}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
})
check('over an allowance answers 403 — not permitted, rather than not paid for',
  refused.status === 403)
check('and the pool was not touched by the refusal', capacity(org.company.id) === 600)

// ----------------------------------------------------------- the charge ---

section('The charge is the valid CV count, once')

setAllowance(adminRecruiter, 500)
const launch = await json(await fetch(`${BASE}/api/hr/triage/${target}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
}))
check('launching charges one unit per valid CV', launch.cvs === 3 && launch.charged === true)
check('the balance falls by exactly that', launch.balance === 597)
check('and the pool agrees', capacity(org.company.id) === 597)

const seat = db.prepare(`SELECT triage_used FROM recruiters WHERE id = ?`).get(adminRecruiter)
check('the seat records what it drew', seat.triage_used === 3)

const again = await Promise.all([
  fetch(`${BASE}/api/hr/triage/${target}/launch`, { method: 'POST', headers: H(org.token), body: '{}' }),
  fetch(`${BASE}/api/hr/triage/${target}/launch`, { method: 'POST', headers: H(org.token), body: '{}' }),
  fetch(`${BASE}/api/hr/triage/${target}/launch`, { method: 'POST', headers: H(org.token), body: '{}' }),
])
check('every repeated launch answers rather than erroring', again.every((r) => r.ok))
check('and none of them charged again', capacity(org.company.id) === 597)
check('nor did the seat draw again',
  db.prepare(`SELECT triage_used FROM recruiters WHERE id = ?`).get(adminRecruiter).triage_used === 3)

/*
 * The count that was charged for is the count that gets read.
 *
 * Launching bills one unit per valid CV, once. If a recruiter could keep
 * adding files afterwards, every one of them would be sorted and scored for
 * nothing — and the ledger row saying "3 CVs" would sit beside a Triage holding
 * six. The route refuses with a 409, and nothing about the charge moves.
 */
const lateForm = new FormData()
lateForm.append(
  'cvs',
  new Blob([await cv('Late Arrival', ['late@example.com', 'Go, gRPC.'])], { type: 'application/pdf' }),
  'late.pdf',
)
const late = await fetch(`${BASE}/api/hr/triage/${target}/files`, {
  method: 'POST', headers: AUTH(org.token), body: lateForm,
})
check('a launched Triage refuses more files', late.status === 409)
check('and the applicant list is unchanged',
  db.prepare(`SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ?`).get(target).n === 3,
  'a file accepted after the charge is a CV sorted for free')
check('and the balance did not move', capacity(org.company.id) === 597)

const consumeRows = db.prepare(
  `SELECT COUNT(*) AS n FROM billing_ledger
   WHERE company_id = ? AND product = 'triage' AND event = 'consume'`,
).get(org.company.id).n
check('the ledger holds exactly one consumption row', consumeRows === 1)
check('and it records the CVs, not a session',
  db.prepare(
    `SELECT delta FROM billing_ledger
     WHERE company_id = ? AND product = 'triage' AND event = 'consume'`,
  ).get(org.company.id).delta === -3)

// ----------------------------------------------- unreadable CVs come back ---

section('Capacity comes back for CVs that could not be read')

const scanId = await draft(org.token, `Scanned ${RUN}`)
/* A PDF with no text layer: it passes every check at upload — the bytes really
   are a PDF — and only fails when we try to read words out of it. */
const blank = await makePdf([' '])
await upload(org.token, scanId, [
  ['readable.pdf', await cv('Maya Brenner', ['maya@example.com', 'Node.js, PostgreSQL, Kafka.'])],
  ['scan.pdf', blank],
])

const before = capacity(org.company.id)
const scanLaunch = await json(await fetch(`${BASE}/api/hr/triage/${scanId}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
}))
check('both files are charged at launch, because readability is not yet known',
  scanLaunch.cvs === 2 && capacity(org.company.id) === before - 2)

async function settle(id, ms = 120000) {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    last = await json(await fetch(`${BASE}/api/hr/triage/${id}/results`, { headers: H(org.token) }))
    if (!last.working) return last
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  return last
}
await settle(scanId)

check('the unreadable one is handed back once parsing finds out',
  capacity(org.company.id) === before - 1)
check('and the refund is in the ledger',
  db.prepare(
    `SELECT COUNT(*) AS n FROM billing_ledger
     WHERE company_id = ? AND product = 'triage' AND event = 'refund'`,
  ).get(org.company.id).n === 1)
check('the seat gets its allowance back too',
  db.prepare(`SELECT triage_used FROM recruiters WHERE id = ?`).get(adminRecruiter).triage_used === 4)

const scanRow = db.prepare(`SELECT charged_cvs, refunded_cvs FROM triages WHERE id = ?`).get(scanId)
check('and the Triage records both figures',
  scanRow.charged_cvs === 2 && scanRow.refunded_cvs === 1)

/*
 * The sweep, run again directly.
 *
 * Waiting for another poll does not exercise this: the parse batch is already
 * done, so the queue never calls the refund a second time. The bug it guards
 * against — an additive refund paying out on every retry — only appears when
 * the function itself is invoked twice with the same report, which is exactly
 * what a reclaimed batch after a crash would do.
 */
const { refundTriageCvs } = await import('../server/src/wallet.js')
for (let i = 0; i < 3; i += 1) {
  refundTriageCvs({ companyId: org.company.id, triageId: scanId, totalCvs: 1 })
}
check('repeating the sweep refunds nothing further',
  db.prepare(`SELECT refunded_cvs FROM triages WHERE id = ?`).get(scanId).refunded_cvs === 1)
check('so the balance is unmoved by the repeats', capacity(org.company.id) === before - 1)
check('and a single refund row is in the ledger',
  db.prepare(
    `SELECT COUNT(*) AS n FROM billing_ledger
     WHERE company_id = ? AND product = 'triage' AND event = 'refund'`,
  ).get(org.company.id).n === 1)
check('a refund can never exceed what was charged',
  (() => {
    const r = db.prepare(`SELECT charged_cvs, refunded_cvs FROM triages WHERE id = ?`).get(scanId)
    return r.refunded_cvs <= r.charged_cvs
  })())

// ------------------------------------------- no further charge afterwards ---

section('Reading a Triage costs nothing more')

const steady = capacity(org.company.id)
await json(await fetch(`${BASE}/api/hr/triage/${target}/results?advance=1`, { headers: H(org.token) }))
await json(await fetch(`${BASE}/api/hr/triage/${target}`, { headers: H(org.token) }))
await json(await fetch(`${BASE}/api/hr/triages`, { headers: H(org.token) }))
check('re-reading results, re-opening and listing all charge nothing',
  capacity(org.company.id) === steady)

// -------------------------------------------------- the admin's controls ---

section('An administrator controls how seats spend the pool')

const allocations = await json(await fetch(`${BASE}/api/company/triage-allocations`, {
  headers: H(org.token),
}))
check('the allocation screen reports the pool and every seat',
  allocations.balance === capacity(org.company.id) && allocations.seats.length >= 1)
check('and what each has drawn',
  allocations.seats.some((s) => s.used === 4))

const updated = await json(await fetch(`${BASE}/api/company/triage-allocations`, {
  method: 'PUT', headers: H(org.token),
  body: JSON.stringify({ allocations: { [adminRecruiter]: 250 } }),
}))
check('an allowance can be set', updated.seats.find((s) => s.id === adminRecruiter)?.allowance === 250)
check('and raising it does not reset what was already drawn',
  updated.seats.find((s) => s.id === adminRecruiter)?.used === 4)

const cleared = await json(await fetch(`${BASE}/api/company/triage-allocations`, {
  method: 'PUT', headers: H(org.token),
  body: JSON.stringify({ allocations: { [adminRecruiter]: null } }),
}))
check('and it can be removed again, back to the shared pool',
  cleared.seats.find((s) => s.id === adminRecruiter)?.allowance === null)

// A recruiter must not be able to raise their own ceiling.
const other = await registerAndSignIn({
  companyName: `Rival ${RUN}`, firstName: 'Gil', lastName: `Rival${RUN}`,
  email: `gil.${RUN}@example.com`,
})
await approveCompanyById(other.company.id)
const across = await fetch(`${BASE}/api/company/triage-allocations`, {
  method: 'PUT', headers: H(other.token),
  body: JSON.stringify({ allocations: { [adminRecruiter]: 9999 } }),
})
const acrossBody = across.ok ? await across.json() : null
check('an administrator of another company cannot touch these seats',
  !acrossBody || !acrossBody.seats.some((s) => s.id === adminRecruiter))
check('and the allowance is unchanged',
  db.prepare(`SELECT triage_allowance FROM recruiters WHERE id = ?`).get(adminRecruiter)
    .triage_allowance === null)

// ---------------------------------------------------------------- cleanup ---

section('Cleanup')

for (const company of [org.company.id, other.company.id]) {
  for (const row of db.prepare(`SELECT id FROM triages WHERE company_id = ?`).all(company)) {
    for (const a of db.prepare(`SELECT stored_name FROM triage_applicants WHERE triage_id = ?`).all(row.id)) {
      try { fs.unlinkSync(path.join(uploadDir, a.stored_name)) } catch { /* already gone */ }
    }
    for (const table of ['triage_applicants', 'triage_batches', 'triage_cost_events']) {
      db.prepare(`DELETE FROM ${table} WHERE triage_id = ?`).run(row.id)
    }
  }
  for (const table of ['triages', 'billing_ledger', 'recruiters']) {
    db.prepare(`DELETE FROM ${table} WHERE company_id = ?`).run(company)
  }
  db.prepare(`DELETE FROM companies WHERE id = ?`).run(company)
}
check('test organizations removed',
  db.prepare(`SELECT COUNT(*) AS n FROM companies WHERE id IN (?, ?)`)
    .get(org.company.id, other.company.id).n === 0)

finish()
