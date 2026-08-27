/**
 * Cursus Triage, end to end.
 *
 * Section 15 of the brief lists the acceptance criteria; this walks them. The
 * ones worth the most are not the happy path — they are the four that are
 * invisible when they break:
 *
 *   - a credit is spent at confirmed launch and NOT when a draft is created;
 *   - launching twice charges once, however many times the button is pressed;
 *   - Triage capacity and reveal credits never touch each other;
 *   - a Triage belonging to another organization is not reachable by id.
 *
 * Every one of those is a silent failure in production: the recruiter is
 * charged twice, or reads someone else's applicants, and nothing in the UI says
 * so. They are asserted first for that reason.
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

const H = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })
const AUTH = (token) => ({ authorization: `Bearer ${token}` })

const JD = `Senior Backend Engineer — Tel Aviv

We are looking for a senior backend engineer to own our payments platform.

Requirements:
- 5+ years building production backend services
- Strong Node.js and TypeScript
- PostgreSQL, including schema design and query tuning
- Experience with distributed systems and message queues

Nice to have:
- Kubernetes and Terraform
- Fintech or payments domain experience
- Hebrew and English
`

/** A CV as a real PDF, because the parser reads bytes and not fixtures. */
const cv = (name, lines) => makePdf([name, ...lines])

const STRONG = await cv('Dana Kovacs', [
  'dana.kovacs@example.com · 050-111-2222 · Tel Aviv',
  'Senior Backend Engineer with 9 years of production experience.',
  'Node.js, TypeScript, PostgreSQL, Kafka, distributed systems.',
  'Led the payments platform at a fintech scale-up. Kubernetes, Terraform.',
])
const MIDDLING = await cv('Omer Levi', [
  'omer.levi@example.com · 050-333-4444 · Haifa',
  'Backend developer, 3 years. Python and Django, some PostgreSQL.',
  'Interested in moving into Node.js work.',
])
const WEAK = await cv('Tamar Shaked', [
  'tamar.shaked@example.com · Jerusalem',
  'Graphic designer with 6 years in brand and print design.',
  'Adobe Illustrator, Photoshop, InDesign.',
])

async function upload(token, triageId, files) {
  const form = new FormData()
  for (const [name, bytes] of files) {
    form.append('cvs', new Blob([bytes], { type: 'application/pdf' }), name)
  }
  return json(await fetch(`${BASE}/api/hr/triage/${triageId}/files`, {
    method: 'POST', headers: AUTH(token), body: form,
  }))
}

/** Capacity, straight from the row — a purchase route would prove less. */
function grantCapacity(companyId, cvs) {
  db.prepare(`UPDATE companies SET triage_cv_balance = triage_cv_balance + ? WHERE id = ?`)
    .run(cvs, companyId)
}

/** An administrator capping one seat, as §9 lets them. */
function setAllowance(recruiterId, cvs) {
  db.prepare(`UPDATE recruiters SET triage_allowance = ? WHERE id = ?`).run(cvs, recruiterId)
}

const org = await registerAndSignIn({
  companyName: `Triage ${RUN}`, firstName: 'Noa', lastName: `Admin${RUN}`,
  email: `noa.${RUN}@example.com`,
})
await approveCompanyById(org.company.id)

// ---------------------------------------------------------------- catalogue ---

section('The third product is on sale')

const catalogue = await json(await fetch(`${BASE}/api/pricing`))
check('the pricing catalogue offers Triage packs', Array.isArray(catalogue.triage) && catalogue.triage.length > 0)
check('capacity is sold in CVs', catalogue.triage.map((p) => p.quantity).join(',') === '100,200,300,500')
check('at the published prices',
  catalogue.triage.map((p) => p.total).join(',') === '3000,5500,7500,11500')
check('and never as a number of Triages',
  !JSON.stringify(catalogue.triage).toLowerCase().includes('triages')) 
check('and the per-Triage rate falls with volume',
  catalogue.triage[0].unit > catalogue.triage[catalogue.triage.length - 1].unit)
check('the per-batch file ceiling is published rather than left to be discovered',
  Number.isFinite(catalogue.triageMaxFiles) && catalogue.triageMaxFiles > 0)
check('reveals and seats are untouched',
  catalogue.reveals.length === 4 && catalogue.seats.length === 4)

// ------------------------------------------------------------------- drafts ---

section('Workspaces are free and unlimited')

/*
 * Emptied on purpose, and not because it arrived that way.
 *
 * A new organization is now granted a welcome allowance of Triage capacity —
 * the pricing page promises it to every account — so "what happens with no
 * capacity" has to be set up rather than assumed. Everything below this line
 * is about the empty-wallet path, which is exactly as important as it was; the
 * grant itself is checked where it belongs, in pricing-check.
 */
db.prepare(`UPDATE companies SET triage_cv_balance = 0 WHERE id = ?`).run(org.company.id)

const before = (await json(await fetch(`${BASE}/api/hr/triages`, { headers: H(org.token) }))).balance
check('an organization with nothing bought has no Triage capacity', before === 0)

/*
 * Opening New Triage must not write anything.
 *
 * The + used to POST a draft, so anybody who opened the screen and left added
 * an "Untitled Triage" to the whole organization's list. The builder now
 * renders from this route and the row is created by the first thing typed into
 * it — which only holds as long as this returns a whole screen's worth of state
 * without an id.
 */
const blank = await json(await fetch(`${BASE}/api/hr/triages/new`, { headers: H(org.token) }))
check('the New Triage screen can be rendered without a Triage', blank.triage?.id === null)
check('it is a draft, unlaunched', blank.triage.status === 'draft' && blank.triage.launched === false)
check('with the file cap the real one would have', blank.triage.fileCap > 0)
check('no files, no failures', blank.files.length === 0 && blank.failures.length === 0)
check('and the launch problems a blank one has — no JD, no CVs',
  ['no_jd', 'no_files'].every((code) => blank.readiness.problems.some((p) => p.code === code)))
check('opening it created nothing',
  db.prepare(`SELECT COUNT(*) AS n FROM triages WHERE company_id = ?`).get(org.company.id).n === 0)
check('and it is not reachable without a session',
  (await fetch(`${BASE}/api/hr/triages/new`)).status === 401)

const draft = await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({}),
}))
check('a draft can be created with an empty balance', Boolean(draft.triage?.id))
check('and creating it charged nothing', draft.balance === 0)
check('it starts as a draft, unlaunched', draft.triage.status === 'draft' && draft.triage.launched === false)

const triageId = draft.triage.id

// -------------------------------------------------------------- the JD gate ---

section('A paid launch needs a usable job description')

let state = await json(await fetch(`${BASE}/api/hr/triage/${triageId}`, { headers: H(org.token) }))
check('an empty draft is not ready to launch', state.readiness.ready === false)
check('and says both reasons rather than the first',
  state.readiness.problems.some((p) => p.code === 'no_jd')
  && state.readiness.problems.some((p) => p.code === 'no_files'))

await json(await fetch(`${BASE}/api/hr/triage/${triageId}`, {
  method: 'PATCH', headers: H(org.token), body: JSON.stringify({ jd: 'Backend dev' }),
}))
state = await json(await fetch(`${BASE}/api/hr/triage/${triageId}`, { headers: H(org.token) }))
check('a one-line job description is refused',
  state.readiness.problems.some((p) => p.code === 'jd_too_short'))

await json(await fetch(`${BASE}/api/hr/triage/${triageId}`, {
  method: 'PATCH', headers: H(org.token),
  body: JSON.stringify({ jd: JD, title: `Backend ${RUN}` }),
}))
state = await json(await fetch(`${BASE}/api/hr/triage/${triageId}`, { headers: H(org.token) }))
check('a real one is accepted', !state.readiness.problems.some((p) => p.code.startsWith('jd')))
check('and the title is kept', state.triage.title === `Backend ${RUN}`)

// ------------------------------------------------------------------ the pile ---

section('The pile')

const added = await upload(org.token, triageId, [
  ['strong.pdf', STRONG], ['middling.pdf', MIDDLING], ['weak.pdf', WEAK],
])
check('three CVs upload in one request', added.results.filter((r) => r.status === 'added').length === 3)
check('and the Triage counts them', added.triage.counts.total === 3)

const dup = await upload(org.token, triageId, [['strong-copy.pdf', STRONG]])
check('the same file under another name is recognised as a duplicate',
  dup.results[0].status === 'duplicate')
check('and it is named against the file it duplicates',
  /strong\.pdf/.test(dup.results[0].reason ?? ''))
check('so the count does not move', dup.triage.counts.total === 3)

const empty = await upload(org.token, triageId, [['nothing.pdf', Buffer.alloc(0)]])
check('an empty file is rejected rather than queued',
  empty.results[0].status === 'rejected')
check('and one bad file does not lose the good ones', empty.triage.counts.total === 3)

const removable = await upload(org.token, triageId, [['spare.pdf', await cv('Spare Person', ['spare@example.com'])]])
const spareId = removable.results.find((r) => r.status === 'added')?.id
const afterRemove = await json(await fetch(`${BASE}/api/hr/triage/${triageId}/files/${spareId}`, {
  method: 'DELETE', headers: H(org.token),
}))
check('a file can be removed before launching', afterRemove.triage.counts.total === 3)

// ------------------------------------------------------------------ the gate ---

section('The purchase gate')

state = await json(await fetch(`${BASE}/api/hr/triage/${triageId}`, { headers: H(org.token) }))
check('with a JD and CVs but no capacity, it is still not ready',
  state.readiness.ready === false
  && state.readiness.problems.some((p) => p.code === 'no_capacity'))
check('and the shortfall is stated in CVs',
  /3 CVs? of capacity|needs 3 CV/.test(
    state.readiness.problems.find((p) => p.code === 'no_capacity')?.message ?? ''))

const refused = await fetch(`${BASE}/api/hr/triage/${triageId}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
})
check('launching without capacity is refused with 402, not 500', refused.status === 402)

// ----------------------------------------------------------------- the money ---

section('CV capacity is its own currency')

const walletBefore = await json(await fetch(`${BASE}/api/recruiter/me`, { headers: H(org.token) }))
const revealsBefore = walletBefore.wallet.balance

/* Ten, for three CVs — so the arithmetic below is visible rather than
   coincidental. */
grantCapacity(org.company.id, 10)

const launch = await json(await fetch(`${BASE}/api/hr/triage/${triageId}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
}))
check('launching spends one unit of capacity per valid CV',
  launch.cvs === 3 && launch.charged === true)
check('so the balance falls by exactly that', launch.balance === 7)
check('and the Triage is now launched', launch.triage.launched === true)

const walletAfter = await json(await fetch(`${BASE}/api/recruiter/me`, { headers: H(org.token) }))
check('the reveal balance is untouched by a Triage launch',
  walletAfter.wallet.balance === revealsBefore)
check('and every seat can see the Triage balance',
  walletAfter.wallet.triage?.balance === 7)

/*
 * The two numbers the payload carries about Triage, which mean different
 * things and used to be confused for one another in the rail.
 *
 * `balance` is CV capacity, a currency. `workspaces` is how many Triages exist,
 * drafts included — the count beside the word "Triage" in the left rail. Sent
 * together, because a count fetched separately is a count that disagrees with
 * itself between two panels.
 */
check('the payload also carries a count of Triage workspaces',
  typeof walletAfter.wallet.triage?.workspaces === 'number')
check('and it counts workspaces rather than capacity',
  walletAfter.wallet.triage.workspaces !== walletAfter.wallet.triage.balance
  && walletAfter.wallet.triage.workspaces
    === db.prepare(`SELECT COUNT(*) AS n FROM triages WHERE company_id = ?`)
      .get(org.company.id).n)

/* A draft counts. It is a workspace the recruiter made, can reopen and can
   delete, which is what the rail's number refers to. */
const beforeDraft = walletAfter.wallet.triage.workspaces
await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ title: 'A draft that counts' }),
}))
const withDraft = await json(await fetch(`${BASE}/api/recruiter/me`, { headers: H(org.token) }))
check('an unlaunched draft counts towards it',
  withDraft.wallet.triage.workspaces === beforeDraft + 1)
check('while the capacity balance is untouched by making one',
  withDraft.wallet.triage.balance === walletAfter.wallet.triage.balance,
  'creating a workspace costs nothing; only submitting CVs does')

/* The heart of it: a retried launch must not charge again. Three attempts,
   because a double-click is two and a flaky connection can be more. */
const again = await Promise.all([
  fetch(`${BASE}/api/hr/triage/${triageId}/launch`, { method: 'POST', headers: H(org.token), body: '{}' }),
  fetch(`${BASE}/api/hr/triage/${triageId}/launch`, { method: 'POST', headers: H(org.token), body: '{}' }),
  fetch(`${BASE}/api/hr/triage/${triageId}/launch`, { method: 'POST', headers: H(org.token), body: '{}' }),
])
check('every repeated launch answers rather than erroring', again.every((r) => r.ok))
const afterRetries = await json(await fetch(`${BASE}/api/hr/triages`, { headers: H(org.token) }))
check('and none of them charged a second time', afterRetries.balance === 7)

const ledger = db.prepare(
  `SELECT COUNT(*) AS n FROM billing_ledger WHERE company_id = ? AND product = 'triage' AND event = 'consume'`,
).get(org.company.id).n
check('the ledger holds exactly one consumption row', ledger === 1)

// ---------------------------------------------------------------- processing ---

section('Processing runs on its own')

/* The request has already returned; the work is on the queue. Poll the way the
   workspace does rather than reaching into the database, so what is asserted is
   what a recruiter would actually see. */
async function settle(ms = 120000) {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    last = await json(await fetch(`${BASE}/api/hr/triage/${triageId}/results`, { headers: H(org.token) }))
    if (!last.working && last.triage.status !== 'processing') return last
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return last
}

const settled = await settle()
check('the Triage finishes without the browser holding it open',
  ['ready', 'completed'].includes(settled.triage.status))

/*
 * Nothing is left holding a claim once the queue is idle.
 *
 * 'running' is the flag a worker sets while it owns a row, and it is only ever
 * cleared by that worker finishing or by the boot-time reclaim. A row still
 * holding it with an empty queue means work was claimed and abandoned — which
 * is invisible in the UI, because the Triage keeps reporting the applicants it
 * did analyse and simply never mentions the ones it dropped.
 */
check('no applicant is left holding a claim nobody is working on',
  db.prepare(
    `SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ? AND deep_status = 'running'`,
  ).get(triageId).n === 0)
check('and no batch is left running with no worker behind it',
  db.prepare(
    `SELECT COUNT(*) AS n FROM triage_batches WHERE triage_id = ? AND status = 'running'`,
  ).get(triageId).n === 0)
check('every readable CV was parsed', settled.triage.counts.usable === 3)
check('and every one of them was analysed — nobody is discarded',
  settled.triage.counts.analysed === 3)
check('so the Triage reports itself completed', settled.triage.status === 'completed')

// ------------------------------------------------------------------ scoring ---

section('The score is the Cursus score')

check('three applicants come back scored', settled.results.length === 3)
check('ordered by score, highest first',
  settled.results.every((row, i, all) => i === 0 || all[i - 1].score >= row.score))
check('the strongest CV is first', /Dana/.test(settled.results[0].name))
check('the graphic designer is last', /Tamar/.test(settled.results[2].name))
check('scores sit on the 0-100 scale',
  settled.results.every((row) => row.score >= 0 && row.score <= 100))
check('the top of a strong field reaches the top of the scale',
  settled.results[0].score >= 60)

/* Section 3 — the preliminary pass orders the queue and is never shown. This is
   the assertion that keeps it that way: the field must not appear anywhere in
   the serialised response, however the shape changes later. */
check('the internal preliminary score is never serialised',
  !/prelim/i.test(JSON.stringify(settled)))

check('each result explains itself', settled.results.every((row) => row.analysis))
check('and carries its own CV back', settled.results.every((row) => row.fileName))

const scoringNote = settled.scoring?.explanation ?? ''
check('the rescoring behaviour is stated rather than left to be noticed',
  /re-rank|relative/i.test(scoringNote))

// ------------------------------------------------------------------- the CV ---

section('The original CV stays reachable, and costs no reveal')

const first = settled.results[0]
const file = await fetch(`${BASE}/api/hr/triage/${triageId}/applicants/${first.id}/file`, {
  headers: AUTH(org.token),
})
check('the uploaded CV can be opened from the result', file.status === 200)
check('and it is served as a document, not as active content',
  (file.headers.get('content-security-policy') ?? '').includes('sandbox'))

const walletAfterCv = await json(await fetch(`${BASE}/api/recruiter/me`, { headers: H(org.token) }))
check('opening it spends no reveal — the recruiter already had this CV',
  walletAfterCv.wallet.balance === revealsBefore)

// ------------------------------------------------------------- isolation ---

section('One organization cannot reach another')

const other = await registerAndSignIn({
  companyName: `Rival ${RUN}`, firstName: 'Gil', lastName: `Rival${RUN}`,
  email: `gil.${RUN}@example.com`,
})
await approveCompanyById(other.company.id)

const peek = await fetch(`${BASE}/api/hr/triage/${triageId}`, { headers: H(other.token) })
check('a Triage id from another company is not found', peek.status === 404)

const peekResults = await fetch(`${BASE}/api/hr/triage/${triageId}/results`, { headers: H(other.token) })
check('nor are its results', peekResults.status === 404)

const peekFile = await fetch(`${BASE}/api/hr/triage/${triageId}/applicants/${first.id}/file`, {
  headers: AUTH(other.token),
})
check('nor is an applicant CV inside it', peekFile.status === 404)

const stealLaunch = await fetch(`${BASE}/api/hr/triage/${triageId}/launch`, {
  method: 'POST', headers: H(other.token), body: '{}',
})
check('and it cannot be launched from outside', stealLaunch.status === 404)

// --------------------------------------------------------- no cross-import ---

section('An applicant is not a candidate')

const candidateWithCvEmail = db.prepare(
  `SELECT COUNT(*) AS n FROM candidates WHERE email = 'dana.kovacs@example.com'`,
).get().n
check('uploading a CV does not create a marketplace candidate', candidateWithCvEmail === 0)

const applicantRows = db.prepare(
  `SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ?`,
).get(triageId).n
check('the applicants live in their own table', applicantRows === 3)

// -------------------------------------------------------------- telemetry ---

section('What it cost is recorded')

const stages = db.prepare(
  `SELECT DISTINCT stage FROM triage_cost_events WHERE triage_id = ?`,
).all(triageId).map((row) => row.stage)
check('the preliminary pass and the deep pass are costed separately',
  stages.some((s) => s.startsWith('preliminary')) && stages.some((s) => s.startsWith('deep')))
check('with a latency for each', db.prepare(
  `SELECT COUNT(*) AS n FROM triage_cost_events WHERE triage_id = ? AND duration_ms IS NOT NULL`,
).get(triageId).n > 0)
check('and none of it reaches the recruiter',
  !/cost|token|prelim/i.test(JSON.stringify(settled)))

// --------------------------------------------------------------- deletion ---

section('Deleting takes the CVs with it')

const stored = db.prepare(`SELECT stored_name FROM triage_applicants WHERE triage_id = ?`)
  .all(triageId).map((row) => row.stored_name)
const uploadDir = fileURLToPath(new URL('../server/uploads/', import.meta.url))
check('the CVs are on disk before deleting',
  stored.length === 3 && stored.every((name) => fs.existsSync(path.join(uploadDir, name))))

const deleted = await json(await fetch(`${BASE}/api/hr/triage/${triageId}`, {
  method: 'DELETE', headers: H(org.token),
}))
check('the Triage is gone from the dashboard',
  !deleted.triages.some((t) => t.id === triageId))
check('and its CVs are gone from disk',
  stored.every((name) => !fs.existsSync(path.join(uploadDir, name))))
check('while the payment record survives — a payment does not un-happen',
  db.prepare(`SELECT COUNT(*) AS n FROM billing_ledger WHERE company_id = ? AND product = 'triage'`)
    .get(org.company.id).n >= 1)

// ---------------------------------------------------------------- cleanup ---

section('Cleanup')

for (const company of [org.company.id, other.company.id]) {
  for (const row of db.prepare(`SELECT id FROM triages WHERE company_id = ?`).all(company)) {
    for (const applicant of db.prepare(`SELECT stored_name FROM triage_applicants WHERE triage_id = ?`).all(row.id)) {
      try { fs.unlinkSync(path.join(uploadDir, applicant.stored_name)) } catch { /* already gone */ }
    }
    db.prepare(`DELETE FROM triage_applicants WHERE triage_id = ?`).run(row.id)
    db.prepare(`DELETE FROM triage_batches WHERE triage_id = ?`).run(row.id)
    db.prepare(`DELETE FROM triage_cost_events WHERE triage_id = ?`).run(row.id)
  }
  db.prepare(`DELETE FROM triages WHERE company_id = ?`).run(company)
  db.prepare(`DELETE FROM billing_ledger WHERE company_id = ?`).run(company)
  db.prepare(`DELETE FROM recruiters WHERE company_id = ?`).run(company)
  db.prepare(`DELETE FROM companies WHERE id = ?`).run(company)
}
check('test organizations removed',
  db.prepare(`SELECT COUNT(*) AS n FROM companies WHERE id IN (?, ?)`)
    .get(org.company.id, other.company.id).n === 0)

finish()
