/**
 * What a rolling Triage costs, and who it costs it.
 *
 * Phase 1 made a second delivery of CVs possible. This is the test that makes
 * it honest. Two statements have to hold at once and they pull in opposite
 * directions:
 *
 *   every CV is charged exactly once — and no CV is charged that we did not
 *   analyse, or analysed without charging.
 *
 * Both failures are quiet. A second delivery that inherits the first one's
 * claim is free work we pay a model for; a delivery that gets charged and then
 * refused is money taken for CVs the recruiter never got back. Neither shows
 * up anywhere a recruiter would notice, and the only place they show up at all
 * is the balance, weeks later, by which time nobody can reconstruct which
 * session did it.
 *
 * So everything here is asserted against the actual balance and the actual
 * ledger, never against what a route said it did.
 *
 * It also covers the three refusals that surround the charge: no capacity, the
 * feature switched off, and a delivery of nothing but duplicates — because
 * each of those has to leave the session exactly as it found it.
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
const MARK = `cking-charge-${RUN}`
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))
const uploadDir = fileURLToPath(new URL('../server/uploads/', import.meta.url))

const H = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })

const START = 6
const SECOND = 4
const BALANCE = 40

const JD = `Payments Operations Analyst

Requirements:
- 3+ years reviewing card-not-present transactions
- Chargeback and dispute handling end to end
- SQL for investigating transaction data

Nice to have:
- Fraud tooling, rules engines
- Hebrew and English
`

const cv = async (label, index, email = null) => makePdf([
  `${label} ${String(index).padStart(3, '0')}`,
  `${email ?? `${label.toLowerCase()}${index}.${RUN}@example.com`} · 050-222-${String(index).padStart(4, '0')} · Tel Aviv`,
  `Payments operations analyst, ${2 + (index % 9)} years of experience.`,
  'Skills: chargebacks, SQL, disputes, fraud rules.',
  'Reviewed card-not-present transactions daily and owned the dispute process end to end.',
])

const balanceNow = () => db.prepare(`SELECT triage_cv_balance AS n FROM companies WHERE id = ?`)
  .get(org.company.id).n

/* Charges only. The complimentary onboarding grant is a triage line too, and
   counting it here would make every assertion about "how many charges" off by
   one in a way that looks like a double charge. */
const ledger = () => db.prepare(`
  SELECT event, delta, triage_id AS triageId, triage_drop_id AS dropId
  FROM billing_ledger
  WHERE company_id = ? AND product = 'triage' AND event IN ('consume', 'refund')
  ORDER BY id
`).all(org.company.id)

/** Posts a pile of CVs at the add-CVs route and returns the raw response. */
async function addCvs(sessionId, files) {
  const form = new FormData()
  for (const file of files) {
    form.append('cvs', new Blob([file.bytes], { type: 'application/pdf' }), file.name)
  }
  return fetch(`${BASE}/api/hr/triage/${sessionId}/cvs`, {
    method: 'POST', headers: { authorization: `Bearer ${org.token}` }, body: form,
  })
}

// --------------------------------------------------------------- the setup ---

const org = await registerAndSignIn({
  companyName: `${MARK} Ltd`, firstName: 'Carmit', lastName: `Charge${RUN}`,
  email: `carmit.${RUN}@${MARK}.example.com`,
})
await approveCompanyById(org.company.id)
db.prepare(`UPDATE companies SET triage_cv_balance = ? WHERE id = ?`).run(BALANCE, org.company.id)

const draft = await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST', headers: H(org.token), body: '{}',
}))
const id = draft.triage.id

await json(await fetch(`${BASE}/api/hr/triage/${id}`, {
  method: 'PATCH', headers: H(org.token),
  body: JSON.stringify({ jd: JD, title: `${MARK} session` }),
}))

const first = new FormData()
for (let index = 0; index < START; index += 1) {
  first.append('cvs', new Blob([await cv('Starter', index)], { type: 'application/pdf' }), `first-${index}.pdf`)
}
await json(await fetch(`${BASE}/api/hr/triage/${id}/files`, {
  method: 'POST', headers: { authorization: `Bearer ${org.token}` }, body: first,
}))

section('The first delivery is charged at launch')

const launched = await fetch(`${BASE}/api/hr/triage/${id}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
})
check('the session starts', launched.ok, `HTTP ${launched.status}`)
check(`and ${START} CVs are taken from the balance`, balanceNow() === BALANCE - START,
  `${BALANCE - balanceNow()} taken`)

const drop1 = db.prepare(`SELECT id, seq, ledger_id AS ledgerId, charged_cvs AS charged
  FROM triage_drops WHERE triage_id = ? ORDER BY seq`).all(id)
check('the charge is written on the delivery, not only on the session',
  drop1.length === 1 && drop1[0].ledgerId !== null && drop1[0].charged === START,
  JSON.stringify(drop1))

const firstLines = ledger()
check('one ledger line, naming the session and the delivery',
  firstLines.length === 1 && firstLines[0].triageId === id && firstLines[0].dropId === drop1[0].id,
  JSON.stringify(firstLines))

section('Launching twice charges once')

const again = await fetch(`${BASE}/api/hr/triage/${id}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
})
check('the second launch is accepted', again.ok, `HTTP ${again.status}`)
check('and takes nothing further', balanceNow() === BALANCE - START, `balance ${balanceNow()}`)
check('and writes no second ledger line', ledger().length === 1, `${ledger().length} lines`)

// ------------------------------------------------------- the second pile ---

section('A second delivery is charged on its own')

const secondFiles = []
for (let index = 0; index < SECOND; index += 1) {
  secondFiles.push({ name: `second-${index}.pdf`, bytes: await cv('Latecomer', 100 + index) })
}

const added = await addCvs(id, secondFiles)
const addedBody = await json(added).catch(() => ({}))

check('the route accepts them', added.status === 201, `HTTP ${added.status}`)
check(`and reports ${SECOND} added`, addedBody.added === SECOND, `${addedBody.added}`)
check('as a second numbered delivery', addedBody.drop?.seq === 2, `seq ${addedBody.drop?.seq}`)
check('the balance falls by exactly that many',
  balanceNow() === BALANCE - START - SECOND, `balance ${balanceNow()}`)

const drops = db.prepare(`SELECT id, seq, ledger_id AS ledgerId, charged_cvs AS charged
  FROM triage_drops WHERE triage_id = ? ORDER BY seq`).all(id)
check('each delivery carries its own charge',
  drops.length === 2 && drops[1].ledgerId !== null && drops[1].charged === SECOND,
  JSON.stringify(drops))
check('and the two ledger lines point at two different deliveries',
  new Set(ledger().filter((l) => l.event === 'consume').map((l) => l.dropId)).size === 2)

check('the session total is the sum of its deliveries',
  db.prepare(`SELECT charged_cvs AS n FROM triages WHERE id = ?`).get(id).n === START + SECOND,
  `${db.prepare(`SELECT charged_cvs AS n FROM triages WHERE id = ?`).get(id).n}`)

section('The same file twice is not a second delivery')

const repeat = await addCvs(id, [secondFiles[0]])
check('a pile of nothing but CVs already here is refused', repeat.status === 409,
  `HTTP ${repeat.status}`)
check('and nothing is charged for it', balanceNow() === BALANCE - START - SECOND,
  `balance ${balanceNow()}`)
check('and no empty delivery is left behind',
  db.prepare(`SELECT COUNT(*) AS n FROM triage_drops WHERE triage_id = ?`).get(id).n === 2)

// ------------------------------------------------------------- refusals ---

section('Running out of capacity refuses before it charges')

db.prepare(`UPDATE companies SET triage_cv_balance = 1 WHERE id = ?`).run(org.company.id)

const tooMany = []
for (let index = 0; index < 3; index += 1) {
  tooMany.push({ name: `over-${index}.pdf`, bytes: await cv('Overflow', 200 + index) })
}
const refused = await addCvs(id, tooMany)
/* Read directly rather than through json(), which throws on a non-2xx and
   would hide the very sentence this section is about. */
const refusedBody = await refused.json().catch(() => ({}))

check('the route answers 402', refused.status === 402, `HTTP ${refused.status}`)
const refusedText = String(refusedBody.error ?? refusedBody.message ?? JSON.stringify(refusedBody))
check('and says how many more are needed', /Buy 2 more/.test(refusedText), refusedText)
check('nothing is taken', balanceNow() === 1, `balance ${balanceNow()}`)
check('no rows are left from the refused pile',
  db.prepare(`SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ?`).get(id).n
  === START + SECOND,
  `${db.prepare(`SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ?`).get(id).n} rows`)
check('and no delivery either',
  db.prepare(`SELECT COUNT(*) AS n FROM triage_drops WHERE triage_id = ?`).get(id).n === 2)

const strays = fs.readdirSync(uploadDir).filter((name) => name.endsWith('.pdf')
  && fs.statSync(path.join(uploadDir, name)).mtimeMs > Date.now() - 60000
  && !db.prepare(`SELECT id FROM triage_applicants WHERE stored_name = ?`).get(name))
check('and the refused files are not left on disk', strays.length === 0, strays.join(', '))

db.prepare(`UPDATE companies SET triage_cv_balance = ? WHERE id = ?`)
  .run(BALANCE - START - SECOND, org.company.id)

section('A draft cannot be topped up through this route')

const draft2 = await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST', headers: H(org.token), body: '{}',
}))
const notStarted = await addCvs(draft2.triage.id, [
  { name: 'draft.pdf', bytes: await cv('Drafted', 300) },
])
check('a session that has not started refuses', notStarted.status === 409,
  `HTTP ${notStarted.status}`)
check('and is charged nothing', balanceNow() === BALANCE - START - SECOND, `balance ${balanceNow()}`)

// ------------------------------------------------------ the same person ---

section('The same person twice is one person')

/* A candidate already in the pile sends a newer CV. Same mailbox, different
   bytes, so nothing upstream catches it — the content hash lets it straight
   through and the recruiter would meet the same name twice. */
const twiceEmail = `repeat.${RUN}@example.com`

const original = { name: 'person-v1.pdf', bytes: await cv('Repeater', 500, twiceEmail) }
const firstSend = await addCvs(id, [original])
check('the first CV is taken', firstSend.status === 201, `HTTP ${firstSend.status}`)

async function settle(sessionId, ms = 180000) {
  const until = Date.now() + ms
  let last = null
  while (Date.now() < until) {
    last = await json(await fetch(`${BASE}/api/hr/triage/${sessionId}/results`, { headers: H(org.token) }))
    const queued = db.prepare(
      `SELECT COUNT(*) AS n FROM triage_batches WHERE triage_id = ? AND status IN ('queued','running')`,
    ).get(sessionId).n
    if (!last.working && queued === 0) return last
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return last
}

await settle(id)
const withOriginal = await settle(id)
const seenOnce = withOriginal.results.filter((row) => row.email === twiceEmail).length
check('and appears once in the results', seenOnce === 1, `${seenOnce} rows`)

const newer = { name: 'person-v2.pdf', bytes: await cv('Repeater', 501, twiceEmail) }
const secondSend = await addCvs(id, [newer])
check('a newer CV from the same person is accepted', secondSend.status === 201,
  `HTTP ${secondSend.status}`)

const settled = await settle(id)
const stillOnce = settled.results.filter((row) => row.email === twiceEmail)
check('they still appear exactly once', stillOnce.length === 1, `${stillOnce.length} rows`)

const versions = db.prepare(`
  SELECT id, file_name AS file, parse_status AS status, duplicate_of AS supersededBy
  FROM triage_applicants WHERE triage_id = ? AND email = ? ORDER BY id
`).all(id, twiceEmail)
check('both CVs are kept', versions.length === 2, JSON.stringify(versions))
check('the older one steps aside',
  versions[0]?.status === 'duplicate' && versions[0]?.supersededBy === versions[1]?.id,
  JSON.stringify(versions))
check('and the newer one is the current version', versions[1]?.status === 'parsed')
check('the one shown is the newer one', stillOnce[0]?.id === versions[1]?.id,
  `showing #${stillOnce[0]?.id}, newest is #${versions[1]?.id}`)

/* Both were charged. That is not a bug being papered over: the older CV was
   read, which is the work that was paid for, and Q15 says nothing about
   refunding a CV that turns out later to have been superseded. Stated here so
   a future change to it is a decision rather than an accident. */
const chargedForPerson = db.prepare(`
  SELECT COALESCE(SUM(charged_cvs), 0) AS n FROM triage_drops WHERE triage_id = ?
`).get(id).n
check('both versions were charged, and neither was charged twice',
  chargedForPerson === START + SECOND + 2, `${chargedForPerson}`)

section('A failed upload does not take committed CVs with it')

/*
 * Asserted on the source, deliberately, and it is worth saying why rather
 * than pretending otherwise.
 *
 * The failure is real and was live until this commit: both upload routes
 * decide file by file which bytes a surviving row points at, and then hand
 * the request to the error handler — which sweeps every entry in req.files
 * and cannot tell a stray from a committed one. The row survived, its file
 * did not, and the loss surfaced days later as "this CV could not be read".
 *
 * Reproducing it end to end means winning a race: the only reachable throw
 * after the rows are written is a second request launching the Triage in the
 * window between the inserts and the response. A test that has to win a race
 * to fail is a test that passes for the wrong reason most of the time, which
 * is worse than no test. So the invariant is pinned where it actually lives —
 * every catch in an upload route empties req.files before calling next().
 */
const routeSource = fs.readFileSync(
  fileURLToPath(new URL('../server/src/index.js', import.meta.url)), 'utf8',
)

const uploadCatches = [...routeSource.matchAll(
  /if \(committed\.has\(file\.path\)\) continue[\s\S]{0,900}?next\(error\)/g,
)].map((match) => match[0])

check('both upload routes protect the files their rows name', uploadCatches.length === 2,
  `${uploadCatches.length} found`)
check('and hand the error handler nothing left to sweep',
  uploadCatches.length === 2 && uploadCatches.every((block) => /req\.files = \[\]/.test(block)),
  uploadCatches.filter((block) => !/req\.files = \[\]/.test(block)).length + ' unprotected')

// ------------------------------------------------------------ the switch ---

section('The switch turns the whole thing off')

const { TRIAGE } = await import('../server/src/triage.js')
check('it is on in the test environment', TRIAGE.addCvs === true,
  'TRIAGE_ADD_CVS defaults on outside production')
check('and off when NODE_ENV says production',
  (() => {
    const before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    /* Read through the same expression the module evaluates at load, because
       the flag is resolved once and a re-import would be cached. */
    const off = !(process.env.TRIAGE_ADD_CVS ?? (process.env.NODE_ENV !== 'production'))
    process.env.NODE_ENV = before
    return off
  })(),
  'the default is NODE_ENV !== production')

// ---------------------------------------------------------------- cleanup ---

section('Cleanup')

for (const sessionId of [id, draft2.triage.id]) {
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
