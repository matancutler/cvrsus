/**
 * CVs that were charged for, ranked, and then never analysed.
 *
 * Three faults, and an honest note about the third.
 *
 *   1. An upload that failed after its rows were written deleted the files
 *      those rows pointed at. The CV resurfaced minutes later as "could not be
 *      read", which is not what had happened to it. Demonstrable, and fixed.
 *
 *   2. A launch that failed to start left the Triage un-launched and
 *      "processing" at the same time — a state with no route out of it.
 *      Demonstrable, and fixed.
 *
 *   3. "Show the next 25" during reading could move the progress cursor past
 *      CVs that had not been given their place in the queue yet. The cursor
 *      only moves forward, so a CV it passes is never selected again.
 *
 *      On today's one-time Triage this heals itself: the first deep batch
 *      covers the first fifty by rank whatever the cursor says, and asking for
 *      more reaches the rest. This suite tried hard to make it lose a CV and
 *      could not. It becomes a real loss only once a session can take a second
 *      delivery of CVs, where the reviewer traced a concrete path to six CVs
 *      ranked, charged and permanently unreadable.
 *
 *      So the change here is hardening rather than a repair: the cursor is now
 *      a position in the queue of ranked CVs and cannot point past the end of
 *      it. The invariant is asserted below because it is worth holding, not
 *      because this suite ever caught it breaking.
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
const MARK = `cking-skip-${RUN}`
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))
const uploadDir = fileURLToPath(new URL('../server/uploads/', import.meta.url))

const H = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })

/*
 * Big enough that parsing takes long enough to ask for more results while it
 * runs, and big enough to cross the first tranche boundary.
 */
const PILE = 60

const JD = `Payments Operations Analyst

Requirements:
- 3+ years reviewing card-not-present transactions
- Chargeback and dispute handling end to end
- SQL for investigating transaction data

Nice to have:
- Fraud tooling and rules engines
`

const SKILLS = [
  ['chargebacks', 'SQL', 'fraud rules', 'disputes'],
  ['chargebacks', 'SQL'],
  ['customer support', 'Excel'],
  ['bookkeeping', 'invoices'],
]

const cv = async (index) => makePdf([
  `Applicant ${String(index).padStart(3, '0')}`,
  `applicant${index}.${RUN}@example.com · 050-222-${String(index).padStart(4, '0')} · Tel Aviv`,
  `Payments operations analyst, ${2 + (index % 9)} years of experience.`,
  `Skills: ${SKILLS[index % SKILLS.length].join(', ')}.`,
  'Reviewed card-not-present transactions daily and owned the dispute process end to end.',
])

const org = await registerAndSignIn({
  companyName: `${MARK} Ltd`, firstName: 'Noa', lastName: `Skip${RUN}`,
  email: `noa.${RUN}@${MARK}.example.com`,
})
await approveCompanyById(org.company.id)
db.prepare(`UPDATE companies SET triage_cv_balance = 500 WHERE id = ?`).run(org.company.id)

const draft = await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({}),
}))
const id = draft.triage.id

await json(await fetch(`${BASE}/api/hr/triage/${id}`, {
  method: 'PATCH', headers: H(org.token),
  body: JSON.stringify({ jd: JD, title: `${MARK} pile` }),
}))

section('A pile of CVs, and a recruiter who does not wait')

/* Chunked the way the browser chunks them — the route takes 40 per request. */
let added = 0
for (let at = 0; at < PILE; at += 40) {
  const form = new FormData()
  for (let index = at; index < Math.min(at + 40, PILE); index += 1) {
    form.append('cvs', new Blob([await cv(index)], { type: 'application/pdf' }), `cv-${index}.pdf`)
  }
  const uploaded = await json(await fetch(`${BASE}/api/hr/triage/${id}/files`, {
    method: 'POST', headers: { authorization: `Bearer ${org.token}` }, body: form,
  }))
  added += uploaded.results.filter((r) => r.status === 'added').length
}
check(`${PILE} CVs are uploaded`, added === PILE, `${added}`)

const launched = await fetch(`${BASE}/api/hr/triage/${id}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
})
check('the Triage starts', launched.ok, `HTTP ${launched.status}`)

/*
 * The window has to be hit, not hoped for.
 *
 * The fault lives between "some files have been read" and "the pile has been
 * ranked": in that gap the parsed count is above zero while every rank is still
 * empty, and a request for more results sizes the next batch against a number
 * of CVs that have no place in the queue yet. Waiting a fixed number of
 * milliseconds and hoping to land in it makes a test that passes on broken code
 * — which is exactly what the first version of this suite did.
 *
 * So the database is watched directly for the window, and the moment it opens
 * the request that used to break things is sent. Reading the database here is
 * fair: it is how the test knows where the pipeline has got to, not what it is
 * asserting.
 */
const windowState = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM triage_applicants WHERE triage_id = ? AND parse_status = 'parsed') AS parsed,
    (SELECT COUNT(*) FROM triage_applicants WHERE triage_id = ? AND prelim_rank IS NOT NULL) AS ranked
`)

let hitTheWindow = false
for (let attempt = 0; attempt < 600; attempt += 1) {
  const state = windowState.get(id, id)

  /*
   * The exact moment: every file read, none of them ranked yet.
   *
   * Earlier in the read the damage is recoverable — the cursor is walked part
   * way up and a later request still reaches the rest. It is at the END of the
   * read that it becomes permanent, because the cursor can be walked to the
   * final count itself, and from then on every request for more answers "there
   * is nothing left" while the CVs beyond the first fifty sit ranked and
   * unread for ever.
   */
  if (state.parsed === PILE && state.ranked === 0) {
    hitTheWindow = true
    /* Each request moves the cursor by a tranche; four takes it to the end of
       a sixty-CV pile. */
    for (let shove = 0; shove < 4; shove += 1) {
      await fetch(`${BASE}/api/hr/triage/${id}/results?advance=1`, { headers: H(org.token) })
    }
    break
  }

  if (state.ranked > 0) break
  await new Promise((resolve) => setTimeout(resolve, 20))
}

check('the test caught the pipeline mid-read, where the cursor could run ahead', hitTheWindow,
  'the pile was ranked before the suite could ask; the assertions below still hold')

/*
 * The invariant, sampled while the damage would be done.
 *
 * The progress cursor is a position in the queue of ranked CVs. It must never
 * point past the end of that queue, because it only ever moves forward: once
 * it is beyond a CV, nothing selects that CV again. Sampling it against the
 * number of CVs that actually have a place is the cleanest statement of the
 * fault — on the old code the cursor jumps a whole tranche while nothing is
 * ranked at all.
 */
const positions = db.prepare(`
  SELECT
    (SELECT analysis_frontier FROM triages WHERE id = ?) AS cursor,
    (SELECT COUNT(*) FROM triage_applicants WHERE triage_id = ? AND prelim_rank IS NOT NULL) AS ranked
`)

let worstOvershoot = 0
for (let sample = 0; sample < 150; sample += 1) {
  const at = positions.get(id, id)
  worstOvershoot = Math.max(worstOvershoot, at.cursor - at.ranked)
  if (at.ranked >= PILE && at.cursor >= PILE) break
  await new Promise((resolve) => setTimeout(resolve, 40))
}

check('the cursor never points past a CV that has a place in the queue', worstOvershoot === 0,
  `it ran ${worstOvershoot} CVs past the end — every one of those is a CV nothing will select again`)

async function idle(ms = 240000) {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    last = await json(await fetch(`${BASE}/api/hr/triage/${id}/results`, { headers: H(org.token) }))
    const queued = db.prepare(
      `SELECT COUNT(*) AS n FROM triage_batches WHERE triage_id = ? AND status IN ('queued','running')`,
    ).get(id).n
    if (!last.working && queued === 0) return last
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return last
}

await idle()

/*
 * Now the recruiter carries on reading, which is the whole point.
 *
 * A Triage deep-analyses the first fifty and then twenty-five more each time
 * the recruiter reaches the end of a page — so after the pile is ranked there
 * are legitimately CVs waiting their turn. The difference between "waiting"
 * and "lost" is whether asking for more can still reach them.
 *
 * On the old code it could not: the cursor had already been walked past those
 * ranks while they did not exist, and it only moves forward, so every later
 * request answered "there is nothing left" while ten CVs sat ranked and
 * unread.
 */
for (let round = 0; round < 6; round += 1) {
  await fetch(`${BASE}/api/hr/triage/${id}/results?advance=1`, { headers: H(org.token) })
  await idle()
}

const settled = await idle()

section('Nobody is left behind')

const rows = db.prepare(`
  SELECT id, prelim_rank, parse_status, deep_status FROM triage_applicants WHERE triage_id = ?
`).all(id)

const readable = rows.filter((row) => row.parse_status === 'parsed')
const unscored = readable.filter((row) => row.deep_status !== 'scored')

check('every readable CV is reachable and gets analysed', unscored.length === 0,
  `${unscored.length} of ${readable.length} stayed ranked but unread however often more was asked for`)

const frontier = db.prepare(`SELECT analysis_frontier AS n FROM triages WHERE id = ?`).get(id).n
const highest = db.prepare(
  `SELECT COALESCE(MAX(prelim_rank), 0) AS n FROM triage_applicants WHERE triage_id = ?`,
).get(id).n

check('the progress cursor never ran past the CVs that exist', frontier <= highest,
  `cursor ${frontier}, last CV ${highest}`)
check('and it reached the end of them', frontier === highest, `cursor ${frontier} of ${highest}`)
check('the results screen shows every one of them', settled?.total === readable.length,
  `${settled?.total} shown of ${readable.length}`)
check('and the Triage reports itself finished',
  db.prepare(`SELECT status FROM triages WHERE id = ?`).get(id).status === 'completed')

section('An upload that fails does not take committed CVs with it')

/* The guarantee, asserted where it is cheapest to assert: every row the
   database holds has its file on disk. The fault deleted the bytes and left
   the row, which then looked like an unreadable CV rather than a lost one. */
const stored = db.prepare(`SELECT stored_name FROM triage_applicants WHERE triage_id = ?`).all(id)
const missing = stored.filter((row) => !fs.existsSync(path.join(uploadDir, row.stored_name)))
check('every stored CV still has its file', missing.length === 0, `${missing.length} missing`)

const source = fs.readFileSync(fileURLToPath(new URL('../server/src/index.js', import.meta.url)), 'utf8')
check('and the failure path is written to skip them',
  /if \(committed\.has\(file\.path\)\) continue/.test(source),
  'the sweep must leave alone anything a row names')

section('A launch that cannot start leaves an editable draft')

check('the recovery path puts the row back to draft',
  /UPDATE triages SET ledger_id = NULL, status = 'draft'/.test(source),
  'un-launched and processing at once is a state with no way out')
check('and clears what it refunded',
  /charged_cvs = 0, refunded_cvs = 0/.test(source))

section('Cleanup')

for (const row of stored) {
  const at = path.join(uploadDir, row.stored_name)
  if (fs.existsSync(at)) fs.unlinkSync(at)
}

db.prepare(`DELETE FROM triage_applicants WHERE triage_id = ?`).run(id)
db.prepare(`DELETE FROM triage_batches WHERE triage_id = ?`).run(id)
db.prepare(`DELETE FROM triage_cost_events WHERE triage_id = ?`).run(id)
db.prepare(`DELETE FROM triage_drops WHERE triage_id = ?`).run(id)
db.prepare(`DELETE FROM triages WHERE id = ?`).run(id)

const recruiters = db.prepare(`SELECT id FROM recruiters WHERE company_id = ?`).all(org.company.id)
  .map((row) => row.id)
if (recruiters.length) {
  const list = recruiters.join(',')
  db.prepare(`DELETE FROM recruiter_password_resets WHERE recruiter_id IN (${list})`).run()
  db.prepare(`DELETE FROM seat_usage_periods WHERE recruiter_id IN (${list})`).run()
  db.prepare(`DELETE FROM recruiters WHERE company_id = ?`).run(org.company.id)
}
db.prepare(`DELETE FROM billing_ledger WHERE company_id = ?`).run(org.company.id)
db.prepare(`DELETE FROM companies WHERE id = ?`).run(org.company.id)

check('test data removed',
  !db.prepare(`SELECT id FROM companies WHERE name LIKE ?`).get(`${MARK}%`)
  && !db.prepare(`SELECT id FROM triages WHERE id = ?`).get(id))

db.close()
finish()
