/**
 * CVs arriving while the session is still working.
 *
 * This is the test the whole of Phase 1 exists to pass. A rolling session takes
 * a second delivery of CVs into a Triage that is already running, and the two
 * things that must be true of that are easy to state and easy to get wrong:
 *
 *   every CV is analysed exactly once, and every CV is charged exactly once.
 *
 * Both failures are silent. The old pipeline would have dropped the second
 * delivery on the floor — its parse batch shared an idempotency key with the
 * first, so the insert was ignored and the work was never owed — while the
 * session reported itself complete. And re-ranking the pile underneath an
 * advanced frontier would slide CVs past the cursor that decides what gets
 * analysed, so they would sit unscored for ever with nothing to show it.
 *
 * The second delivery is written here rather than posted, on purpose. This
 * suite is about the pipeline: every CV analysed exactly once, ranks that do
 * not move, a queue that finds its own work. Driving addCvsToSession directly
 * is the shortest path to that and keeps the assertions about the thing being
 * tested. The money that route adds on top is test:triage-charge's job.
 *
 * It also proves the third thing Phase 1 promised: a score a recruiter has
 * already read does not move when new CVs land.
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
const MARK = `cking-drop-${RUN}`
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))
const uploadDir = fileURLToPath(new URL('../server/uploads/', import.meta.url))

const H = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })

/* Big enough that the first delivery is still being worked on when the second
   one lands, small enough that the suite finishes. */
const FIRST = 14
const SECOND = 6

const JD = `Payments Operations Analyst

Requirements:
- 3+ years reviewing card-not-present transactions
- Chargeback and dispute handling end to end
- SQL for investigating transaction data

Nice to have:
- Fraud tooling, rules engines
- Hebrew and English
`

const SKILLS = [
  ['chargebacks', 'SQL', 'fraud rules', 'disputes'],
  ['chargebacks', 'SQL'],
  ['customer support', 'Excel'],
  ['bookkeeping', 'invoices'],
]

const cv = async (label, index) => makePdf([
  `${label} ${String(index).padStart(3, '0')}`,
  `${label.toLowerCase()}${index}.${RUN}@example.com · 050-111-${String(index).padStart(4, '0')} · Tel Aviv`,
  `Payments operations analyst, ${2 + (index % 9)} years of experience.`,
  `Skills: ${SKILLS[index % SKILLS.length].join(', ')}.`,
  'Reviewed card-not-present transactions daily and owned the dispute process end to end.',
])

// --------------------------------------------------------------- the setup ---

const org = await registerAndSignIn({
  companyName: `${MARK} Ltd`, firstName: 'Dana', lastName: `Drop${RUN}`,
  email: `dana.${RUN}@${MARK}.example.com`,
})
await approveCompanyById(org.company.id)
db.prepare(`UPDATE companies SET triage_cv_balance = 500 WHERE id = ?`).run(org.company.id)

const draft = await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({}),
}))
const id = draft.triage.id

await json(await fetch(`${BASE}/api/hr/triage/${id}`, {
  method: 'PATCH', headers: H(org.token),
  body: JSON.stringify({ jd: JD, title: `${MARK} session` }),
}))

const form = new FormData()
for (let index = 0; index < FIRST; index += 1) {
  form.append('cvs', new Blob([await cv('Applicant', index)], { type: 'application/pdf' }), `first-${index}.pdf`)
}
const uploaded = await json(await fetch(`${BASE}/api/hr/triage/${id}/files`, {
  method: 'POST', headers: { authorization: `Bearer ${org.token}` }, body: form,
}))

section('The first delivery')
check(`${FIRST} CVs are accepted`, uploaded.results.filter((r) => r.status === 'added').length === FIRST)

const drops0 = db.prepare(`SELECT id, seq, files FROM triage_drops WHERE triage_id = ?`).all(id)
check('and they belong to a numbered delivery', drops0.length === 1 && drops0[0].seq === 1,
  `${drops0.length} delivery row(s)`)
check('which records how many it holds', drops0[0]?.files === FIRST, `${drops0[0]?.files}`)

const launched = await fetch(`${BASE}/api/hr/triage/${id}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
})
check('the session starts', launched.ok, `HTTP ${launched.status}`)

const balanceAfterLaunch = db.prepare(`SELECT triage_cv_balance AS n FROM companies WHERE id = ?`)
  .get(org.company.id).n
check('and is charged for exactly those CVs', balanceAfterLaunch === 500 - FIRST,
  `${500 - balanceAfterLaunch} charged`)

// -------------------------------------------- the second delivery, mid-work ---

section('A second delivery, while the first is still being analysed')

const results = async () => json(await fetch(`${BASE}/api/hr/triage/${id}/results`, { headers: H(org.token) }))

/* Wait until the pipeline is genuinely under way, so this is an arrival into a
   working session rather than into an idle one. */
let working = false
for (let attempt = 0; attempt < 40; attempt += 1) {
  const state = await results()
  if (state.working) { working = true; break }
  if (state.total > 0) break
  await new Promise((resolve) => setTimeout(resolve, 250))
}
check('the session is working when the new CVs arrive', working,
  'if this is false the suite still runs, but it tested the idle path')

const before = await results()
const scoredBefore = new Map(before.results.map((row) => [row.id, row.score]))
const ranksBefore = new Map(
  db.prepare(`SELECT id, prelim_rank FROM triage_applicants WHERE triage_id = ?`).all(id)
    .filter((row) => row.prelim_rank !== null)
    .map((row) => [row.id, row.prelim_rank]),
)

/*
 * Written straight to the upload directory, the way multer would leave them,
 * and handed to the server-side path in the shape a route would hand them over.
 * `wake: false` on the start: the server owns the pump, and a second pump in
 * this process would race it for the same batch.
 */
const { addCvsToSession } = await import('../server/src/triage.js')
const { startProcessing } = await import('../server/src/triageQueue.js')

const dropped = []
for (let index = 0; index < SECOND; index += 1) {
  const storedName = `${MARK}-second-${index}.pdf`
  const at = path.join(uploadDir, storedName)
  fs.writeFileSync(at, await cv('Latecomer', 100 + index))
  dropped.push({
    originalname: `second-${index}.pdf`, path: at,
    size: fs.statSync(at).size, mimetype: 'application/pdf',
  })
}

const second = addCvsToSession({ triageId: id, recruiterId: org.recruiter?.id ?? null, files: dropped })
startProcessing(id, { dropId: second.drop.id, wake: false })

check(`${SECOND} more CVs are taken`, second.added === SECOND, `${second.added}`)
check('as a second numbered delivery', second.drop.seq === 2)

/* The server's own waker has to notice work this process enqueued — nothing
   here pumps, and no browser asked for anything. */
section('The queue picks the work up on its own')

async function idle(ms = 180000) {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    last = await results()
    const queued = db.prepare(
      `SELECT COUNT(*) AS n FROM triage_batches WHERE triage_id = ? AND status IN ('queued','running')`,
    ).get(id).n
    if (!last.working && queued === 0) return last
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return last
}

const settled = await idle()
check('the session finishes without anybody asking it to', Boolean(settled),
  'the waker runs every few seconds and pumps whatever is queued')

// ------------------------------------------------------------- the claims ---

section('Every CV is analysed exactly once')

const rows = db.prepare(`
  SELECT id, drop_id, prelim_rank, deep_status, parse_status, absolute_fit, stored_name
  FROM triage_applicants WHERE triage_id = ?
`).all(id)

check('every CV is stored', rows.length === FIRST + SECOND, `${rows.length} rows`)
check('and every one of them was read', rows.every((row) => row.parse_status === 'parsed'),
  rows.filter((row) => row.parse_status !== 'parsed').map((row) => row.parse_status).join(', ') || 'all parsed')
check('and every one of them was scored',
  rows.every((row) => row.deep_status === 'scored'),
  rows.filter((row) => row.deep_status !== 'scored').length + ' unscored')

const ranks = rows.map((row) => row.prelim_rank).filter((rank) => rank !== null).sort((a, b) => a - b)
check('ranks are unique', new Set(ranks).size === ranks.length)
check('and gapless from 1', ranks.every((rank, index) => rank === index + 1),
  `1..${ranks.length}`)

/* The proof that nothing was analysed twice: one cost event per batch, and the
   applicants they report add up to the number of CVs, not more. */
const counted = db.prepare(`
  SELECT COALESCE(SUM(applicants), 0) AS n FROM triage_cost_events
  WHERE triage_id = ? AND stage LIKE 'deep:%'
`).get(id).n
check('the deep-analysis stages report each CV once and once only',
  counted === FIRST + SECOND, `${counted} of ${FIRST + SECOND}`)

const frontier = db.prepare(`SELECT analysis_frontier AS n FROM triages WHERE id = ?`).get(id).n
check('the frontier ends at the end of the pile', frontier === FIRST + SECOND, `${frontier}`)

section('Every CV is charged exactly once')

/*
 * The first delivery was charged at launch. The second is NOT charged here,
 * and that is the invariant rather than a gap: charging belongs to the ROUTE,
 * and this suite drives addCvsToSession directly. Writing rows is not the same
 * act as paying for them, and anything that charged as a side effect of the
 * write would charge the migration and the tests too.
 *
 * What the money actually does across two deliveries is test:triage-charge,
 * which goes through the route and asserts against the balance and the ledger.
 * What this asserts is the part that matters either way — nothing was charged
 * twice, and nothing was charged for a delivery that never happened.
 */
const consumeRows = db.prepare(`
  SELECT COUNT(*) AS n, COALESCE(SUM(delta), 0) AS delta FROM billing_ledger
  WHERE company_id = ? AND product = 'triage' AND event = 'consume'
`).get(org.company.id)

check('one charge, for the delivery that was launched', consumeRows.n === 1, `${consumeRows.n} rows`)
check('and it is the CV count, not a session fee', consumeRows.delta === -FIRST, `${consumeRows.delta}`)
check('writing a delivery does not charge for it — the route does that',
  db.prepare(`SELECT charged_cvs AS n FROM triages WHERE id = ?`).get(id).n === FIRST)

section('A score a recruiter has already read does not move')

const after = await results()
const scoredAfter = new Map(after.results.map((row) => [row.id, row.score]))
const moved = [...scoredBefore.entries()].filter(([rowId, score]) => (
  scoredAfter.has(rowId) && scoredAfter.get(rowId) !== score
))

check('not one score changed when the new CVs landed', moved.length === 0,
  moved.map(([rowId, was]) => `#${rowId} ${was}→${scoredAfter.get(rowId)}`).join(', ') || 'none moved')

const ranksAfter = db.prepare(`SELECT id, prelim_rank FROM triage_applicants WHERE triage_id = ?`).all(id)
const rankMoved = ranksAfter.filter((row) => (
  ranksBefore.has(row.id) && ranksBefore.get(row.id) !== row.prelim_rank
))
check('and no CV was given a different place in the queue', rankMoved.length === 0,
  `${rankMoved.length} moved`)

check('the new CVs are ranked after the ones already there',
  rows.filter((row) => row.drop_id === second.drop.id).every((row) => row.prelim_rank > FIRST),
  'appending is what keeps the earlier ranks meaningful')

section('The work is still one batch per delivery')

const batches = db.prepare(`SELECT kind, drop_id, idem_key FROM triage_batches WHERE triage_id = ?`).all(id)
check('each delivery was parsed on its own', batches.filter((b) => b.kind === 'parse').length === 2)
check('and ranked on its own', batches.filter((b) => b.kind === 'preliminary').length === 2)
check('with keys that cannot collide',
  new Set(batches.map((b) => b.idem_key)).size === batches.length,
  batches.map((b) => b.idem_key).join(' | '))

section('The files behind the rows are still on disk')

/* The upload bug in the plan's section 4.3 deleted committed files and left the
   rows pointing at nothing. It surfaced minutes later as "this CV could not be
   read", which is why it is worth asserting rather than assuming. */
const missing = rows.filter((row) => !fs.existsSync(path.join(uploadDir, row.stored_name)))
check('no row points at a file that is gone', missing.length === 0, `${missing.length} missing`)

// ------------------------------------------ the frontier cannot overshoot ---

/*
 * The failure this guards against was found by review, not by the suite above:
 * a recruiter paging through already-analysed results while a delivery is being
 * read sends ?advance=1, which used to size the next tranche by the number of
 * PARSED rows. Rows are flipped to parsed one at a time and ranked only at the
 * end, so the range named ranks that did not exist yet, the batch found nothing
 * in it, moved the frontier past them anyway — and the CVs ranked into that
 * band a moment later sat below a cursor that only moves forward. Parsed,
 * ranked, never analysed, and nothing in the product able to say so.
 */
section('Paging while a delivery is being read cannot strand it')

const third = []
for (let index = 0; index < 5; index += 1) {
  const storedName = `${MARK}-third-${index}.pdf`
  const at = path.join(uploadDir, storedName)
  fs.writeFileSync(at, await cv('Overshoot', 200 + index))
  third.push({
    originalname: `third-${index}.pdf`, path: at,
    size: fs.statSync(at).size, mimetype: 'application/pdf',
  })
}

const thirdDrop = addCvsToSession({ triageId: id, recruiterId: null, files: third })
startProcessing(id, { dropId: thirdDrop.drop.id, wake: false })

/* Exactly the window that used to break it: work queued, nothing ranked yet,
   and the recruiter asking for more results. */
for (let attempt = 0; attempt < 6; attempt += 1) {
  await fetch(`${BASE}/api/hr/triage/${id}/results?advance=1`, { headers: H(org.token) })
  await new Promise((resolve) => setTimeout(resolve, 120))
}

const afterOvershoot = await idle()
const stranded = db.prepare(`
  SELECT COUNT(*) AS n FROM triage_applicants
  WHERE triage_id = ? AND parse_status = 'parsed' AND deep_status <> 'scored'
`).get(id).n

check('every CV is still analysed, however much the recruiter paged', stranded === 0,
  `${stranded} left parsed but unscored`)
check('and the session holds all three deliveries', afterOvershoot.total === FIRST + SECOND + 5,
  `${afterOvershoot.total} of ${FIRST + SECOND + 5}`)

const frontierNow = db.prepare(`SELECT analysis_frontier AS n FROM triages WHERE id = ?`).get(id).n
const highestRank = db.prepare(
  `SELECT COALESCE(MAX(prelim_rank), 0) AS n FROM triage_applicants WHERE triage_id = ?`,
).get(id).n
check('and the frontier never ran past the ranks that exist', frontierNow === highestRank,
  `frontier ${frontierNow}, highest rank ${highestRank}`)

// ------------------------------------- a session that predates deliveries ---

/*
 * Rows written before this code have no delivery. The upgrade must give them
 * one of their own rather than folding them into whatever arrives next — and
 * above all must not leave a session holding two kinds of row, where the parse
 * pass sees one kind and silently ignores the other.
 */
section('A session from before deliveries existed')

const legacyForm = new FormData()
for (let index = 0; index < 4; index += 1) {
  legacyForm.append('cvs', new Blob([await cv('Legacy', 300 + index)], { type: 'application/pdf' }), `legacy-${index}.pdf`)
}
const legacyDraft = await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({}),
}))
const legacyId = legacyDraft.triage.id
await json(await fetch(`${BASE}/api/hr/triage/${legacyId}`, {
  method: 'PATCH', headers: H(org.token),
  body: JSON.stringify({ jd: JD, title: `${MARK} legacy` }),
}))
await json(await fetch(`${BASE}/api/hr/triage/${legacyId}/files`, {
  method: 'POST', headers: { authorization: `Bearer ${org.token}` }, body: legacyForm,
}))

/* Made to look like a session written before Phase 1: its CVs belong to no
   delivery, and it has no delivery rows at all. */
db.prepare(`UPDATE triage_applicants SET drop_id = NULL WHERE triage_id = ?`).run(legacyId)
db.prepare(`DELETE FROM triage_drops WHERE triage_id = ?`).run(legacyId)

await fetch(`${BASE}/api/hr/triage/${legacyId}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
})

async function legacyIdle(ms = 120000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const state = await json(await fetch(`${BASE}/api/hr/triage/${legacyId}/results`, { headers: H(org.token) }))
    const queued = db.prepare(
      `SELECT COUNT(*) AS n FROM triage_batches WHERE triage_id = ? AND status IN ('queued','running')`,
    ).get(legacyId).n
    if (!state.working && queued === 0) return state
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}

const legacySettled = await legacyIdle()
check('its own CVs are read and scored', legacySettled?.total === 4, `${legacySettled?.total}`)

const legacyExtra = []
for (let index = 0; index < 3; index += 1) {
  const storedName = `${MARK}-legacy-new-${index}.pdf`
  const at = path.join(uploadDir, storedName)
  fs.writeFileSync(at, await cv('Newcomer', 400 + index))
  legacyExtra.push({
    originalname: `legacy-new-${index}.pdf`, path: at,
    size: fs.statSync(at).size, mimetype: 'application/pdf',
  })
}

const legacyDrop = addCvsToSession({ triageId: legacyId, recruiterId: null, files: legacyExtra })
startProcessing(legacyId, { dropId: legacyDrop.drop.id, wake: false })

const legacyAfter = await legacyIdle()

const legacyDrops = db.prepare(
  `SELECT seq, files FROM triage_drops WHERE triage_id = ? ORDER BY seq`,
).all(legacyId)
check('the old pile is given a delivery of its own',
  legacyDrops[0]?.seq === 1 && legacyDrops[0]?.files === 4, JSON.stringify(legacyDrops))
check('and the new CVs are a second one', legacyDrops[1]?.seq === 2 && legacyDrops[1]?.files === 3)

const legacyOrphans = db.prepare(
  `SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ? AND drop_id IS NULL`,
).get(legacyId).n
check('no CV is left belonging to nothing', legacyOrphans === 0, `${legacyOrphans} orphaned`)
check('and all seven end up scored', legacyAfter?.total === 7, `${legacyAfter?.total}`)

// ---------------------------------------------------------------- cleanup ---

section('Cleanup')

for (const sessionId of [id, legacyId]) {
  const held = db.prepare(`SELECT stored_name FROM triage_applicants WHERE triage_id = ?`).all(sessionId)
  for (const row of held) {
    const at = path.join(uploadDir, row.stored_name)
    if (fs.existsSync(at)) fs.unlinkSync(at)
  }

  db.prepare(`DELETE FROM triage_applicants WHERE triage_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM triage_batches WHERE triage_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM triage_cost_events WHERE triage_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM triage_drops WHERE triage_id = ?`).run(sessionId)
  db.prepare(`DELETE FROM triages WHERE id = ?`).run(sessionId)
}

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
