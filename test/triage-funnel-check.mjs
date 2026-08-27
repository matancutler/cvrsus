/**
 * The rolling buffer: 50 deep, 25 shown, 25 more on demand.
 *
 * Section 14 calls this "a product requirement, not an arbitrary implementation
 * suggestion", and it is the one part of Triage that cannot be checked with a
 * handful of CVs — every interesting behaviour lives at a boundary. So this
 * suite uploads enough applicants to cross one, and asserts the four things
 * that make the design worth having:
 *
 *   - the whole pile is prioritised, but only the first 50 are analysed;
 *   - the recruiter is shown 25, not 50 — the other 25 are the buffer;
 *   - reaching the end queues the NEXT 25 beyond the buffer, not a repeat;
 *   - crossing the same boundary twice analyses nobody twice.
 *
 * Split from triage-check because it is slow: sixty PDFs are parsed for real.
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

/* Enough to clear the initial fifty and leave a real remainder behind it, so
   the rolling batch has somewhere to go and an end to reach. */
const PILE = 60

const JD = `Senior Backend Engineer

Requirements:
- 5+ years of backend engineering
- Node.js and TypeScript in production
- PostgreSQL schema design and query tuning
- Distributed systems, message queues, observability

Nice to have:
- Kubernetes, Terraform
- Payments or fintech domain experience
`

/*
 * A spread of strengths, so the preliminary ordering has something to order.
 * The index is woven into the skills rather than into the name alone: a pile
 * where every CV is identical would rank arbitrarily and prove nothing about
 * whether the funnel reads the strongest first.
 */
const SKILLS = [
  ['Node.js', 'TypeScript', 'PostgreSQL', 'Kafka', 'Kubernetes', 'Terraform'],
  ['Node.js', 'TypeScript', 'PostgreSQL'],
  ['Node.js', 'JavaScript', 'MySQL'],
  ['Python', 'Django', 'PostgreSQL'],
  ['Java', 'Spring', 'Oracle'],
  ['PHP', 'Laravel'],
  ['Graphic design', 'Illustrator'],
]

async function pile() {
  const files = []
  for (let index = 0; index < PILE; index += 1) {
    const skills = SKILLS[index % SKILLS.length]
    files.push([
      `applicant-${index}.pdf`,
      await makePdf([
        `Applicant ${String(index).padStart(3, '0')}`,
        `applicant${index}@example.com · 050-000-${String(index).padStart(4, '0')} · Tel Aviv`,
        `Backend engineer, ${2 + (index % 12)} years of experience.`,
        `Skills: ${skills.join(', ')}.`,
        'Built and operated production services end to end.',
      ]),
    ])
  }
  return files
}

async function upload(token, triageId, files) {
  const form = new FormData()
  for (const [name, bytes] of files) {
    form.append('cvs', new Blob([bytes], { type: 'application/pdf' }), name)
  }
  return json(await fetch(`${BASE}/api/hr/triage/${triageId}/files`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  }))
}

const org = await registerAndSignIn({
  companyName: `Funnel ${RUN}`, firstName: 'Yael', lastName: `Admin${RUN}`,
  email: `yael.${RUN}@example.com`,
})
await approveCompanyById(org.company.id)
db.prepare(`UPDATE companies SET triage_cv_balance = 5000 WHERE id = ?`).run(org.company.id)

const draft = await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({}),
}))
const id = draft.triage.id

await json(await fetch(`${BASE}/api/hr/triage/${id}`, {
  method: 'PATCH', headers: H(org.token),
  body: JSON.stringify({ jd: JD, title: `Funnel ${RUN}` }),
}))

section(`Uploading ${PILE} CVs`)

const files = await pile()
/* Chunked exactly as the browser chunks them, so the server-side ceiling is
   exercised against a running total rather than against one request. */
let added = 0
for (let at = 0; at < files.length; at += 40) {
  const result = await upload(org.token, id, files.slice(at, at + 40))
  added += result.results.filter((r) => r.status === 'added').length
}
check(`all ${PILE} are accepted across several requests`, added === PILE)

const config = await json(await fetch(`${BASE}/api/hr/triages`, { headers: H(org.token) }))
check('the tranche size is published rather than assumed by the client', config.tranche === 25)

await json(await fetch(`${BASE}/api/hr/triage/${id}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
}))

/** Waits until the queue is idle, which is when a claim about counts is safe. */
async function idle(ms = 300000) {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    last = await json(await fetch(`${BASE}/api/hr/triage/${id}/results`, { headers: H(org.token) }))
    if (!last.working) return last
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return last
}

// ------------------------------------------------------- the initial fifty ---

section('Stage A prioritises everyone; Stage B analyses fifty')

const first = await idle()

const parsed = db.prepare(
  `SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ? AND parse_status = 'parsed'`,
).get(id).n
check(`every one of the ${PILE} CVs was read`, parsed === PILE)

const ranked = db.prepare(
  `SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ? AND prelim_rank IS NOT NULL`,
).get(id).n
check('and every one was given a preliminary rank — nobody is discarded', ranked === PILE)

check('exactly the first 50 were deeply analysed', first.triage.counts.analysed === 50)
check('so ten are prioritised but not yet analysed',
  first.states.prioritized === 10 && first.states.scored === 50)

const outsideFifty = db.prepare(`
  SELECT COUNT(*) AS n FROM triage_applicants
  WHERE triage_id = ? AND prelim_rank > 50 AND deep_status = 'scored'
`).get(id).n
check('nobody beyond rank 50 was analysed before being asked for', outsideFifty === 0)

// ------------------------------------------------------------ the first 25 ---

section('The recruiter is shown 25, and 25 more are already waiting')

check('the first page is 25 results, not 50', first.results.length === 25)
check('with more available without any further analysis', first.hasMore === true)
check('the total ready to read is the analysed 50', first.total === 50)
check('the buffer is real: 50 analysed against 25 shown',
  first.triage.counts.analysed === 50 && first.results.length === 25)

check('the page is ordered by final score, highest first',
  first.results.every((row, i, all) => i === 0 || all[i - 1].score >= row.score))

// ------------------------------------------------------- crossing the line ---

section('Reaching the end queues the next 25')

const frontierBefore = first.triage.counts.frontier
check('the frontier sits at 50 before the boundary is crossed', frontierBefore === 50)

const second = await json(await fetch(
  `${BASE}/api/hr/triage/${id}/results?offset=25&advance=1`, { headers: H(org.token) },
))
check('the second page is the buffer, served immediately', second.results.length === 25)
check('and it continues the ranking rather than repeating it',
  second.results[0].id !== first.results[0].id
  && second.results[0].score <= first.results[24].score)

check('crossing the boundary queued more work',
  second.queued?.queued === true || second.queued?.reason === 'already_queued')
check('the next tranche starts at 51, not at 26 — the buffer is not re-analysed',
  second.queued?.from === 51)
check('and it is 25 wide, clamped to what is left',
  second.queued?.to === Math.min(75, PILE))

const settled = await idle()
check('the remaining applicants are analysed', settled.triage.counts.analysed === PILE)
check('so the Triage completes', settled.triage.status === 'completed')
check('and the frontier has moved past the pile', settled.triage.counts.frontier >= PILE)

// ------------------------------------------------------------- idempotency ---

section('Crossing the same boundary twice analyses nobody twice')

const batchesBefore = db.prepare(
  `SELECT COUNT(*) AS n FROM triage_batches WHERE triage_id = ?`,
).get(id).n

/* Four simultaneous requests at the same boundary: a double-click, a refresh
   and a second tab, which is exactly the situation Section 3.3 names. */
await Promise.all(Array.from({ length: 4 }, () => (
  fetch(`${BASE}/api/hr/triage/${id}/results?offset=25&advance=1`, { headers: H(org.token) })
)))
await idle()

const batchesAfter = db.prepare(
  `SELECT COUNT(*) AS n FROM triage_batches WHERE triage_id = ?`,
).get(id).n
check('no duplicate batch was created', batchesAfter === batchesBefore)

const analysisRows = db.prepare(
  `SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ? AND deep_status = 'scored'`,
).get(id).n
check('and no applicant was analysed a second time', analysisRows === PILE)

const keys = db.prepare(`SELECT idem_key FROM triage_batches WHERE triage_id = ?`).all(id)
check('every batch carries a distinct idempotency key',
  new Set(keys.map((k) => k.idem_key)).size === keys.length)

// ------------------------------------------------------------- reordering ---

section('Deep analysis reorders what the cheap pass guessed')

const finalPageProbe = await json(await fetch(`${BASE}/api/hr/triage/${id}/results`, { headers: H(org.token) }))
const finalPage = finalPageProbe

/*
 * Section 3.4: a candidate the preliminary pass ranked lower may finish higher.
 *
 * This can only be asserted when the reasoning pass actually ran. Without an
 * ANTHROPIC_API_KEY the deep stage falls back to the same deterministic scorer
 * the preliminary stage uses, so the two orders agree by construction — that is
 * the fallback working correctly, not a reordering bug, and a test that failed
 * on it would be testing whether a key is set.
 *
 * What is still worth asserting on the deterministic path is the part that
 * holds either way: the ranks are a permutation of 1..n with no gaps and no
 * duplicates, which is what makes tranche boundaries addressable at all.
 */
const orders = db.prepare(`
  SELECT prelim_rank, absolute_fit FROM triage_applicants
  WHERE triage_id = ? AND deep_status = 'scored'
  ORDER BY absolute_fit DESC, id
`).all(id)

const reasoned = finalPageProbe.results.some((row) => row.analysis?.source === 'claude')

if (reasoned) {
  const movedRows = orders.filter((row, index) => row.prelim_rank !== index + 1).length
  check('the final order is not simply the preliminary order', movedRows > 0,
    `${movedRows} of ${orders.length} applicants moved`)
} else {
  check('deep analysis fell back to the deterministic scorer, so no reordering '
    + 'is expected — set ANTHROPIC_API_KEY to exercise Section 3.4', true)
}

const ranks = db.prepare(
  `SELECT prelim_rank FROM triage_applicants WHERE triage_id = ? AND prelim_rank IS NOT NULL`,
).all(id).map((row) => row.prelim_rank).sort((a, b) => a - b)
check('preliminary ranks are a gapless 1..n, which is what makes a tranche addressable',
  ranks.length === PILE && ranks.every((rank, index) => rank === index + 1))

check('and the recruiter sees the final order, not the preliminary one',
  finalPage.results.every((row, i, all) => i === 0 || all[i - 1].score >= row.score))
check('the preliminary score is still never serialised',
  !/prelim/i.test(JSON.stringify(finalPage)))

// ---------------------------------------------------------------- cleanup ---

section('Cleanup')

const stored = db.prepare(`SELECT stored_name FROM triage_applicants WHERE triage_id = ?`)
  .all(id).map((row) => row.stored_name)

await fetch(`${BASE}/api/hr/triage/${id}`, { method: 'DELETE', headers: H(org.token) })
check('the pile is removed from disk',
  stored.every((name) => !fs.existsSync(path.join(uploadDir, name))))

for (const row of db.prepare(`SELECT id FROM triages WHERE company_id = ?`).all(org.company.id)) {
  for (const applicant of db.prepare(`SELECT stored_name FROM triage_applicants WHERE triage_id = ?`).all(row.id)) {
    try { fs.unlinkSync(path.join(uploadDir, applicant.stored_name)) } catch { /* already gone */ }
  }
  db.prepare(`DELETE FROM triage_applicants WHERE triage_id = ?`).run(row.id)
  db.prepare(`DELETE FROM triage_batches WHERE triage_id = ?`).run(row.id)
  db.prepare(`DELETE FROM triage_cost_events WHERE triage_id = ?`).run(row.id)
}
db.prepare(`DELETE FROM triages WHERE company_id = ?`).run(org.company.id)
db.prepare(`DELETE FROM billing_ledger WHERE company_id = ?`).run(org.company.id)
db.prepare(`DELETE FROM recruiters WHERE company_id = ?`).run(org.company.id)
db.prepare(`DELETE FROM companies WHERE id = ?`).run(org.company.id)
check('the test organization is removed',
  db.prepare(`SELECT COUNT(*) AS n FROM companies WHERE id = ?`).get(org.company.id).n === 0)

finish()
