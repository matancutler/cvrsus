/**
 * What a session is allowed to do, and when its CVs are let go of.
 *
 * Three things are being proved here and they are not the same thing.
 *
 * **The states.** open, paused and closed decide whether CVs can be added and
 * whether new analysis starts. The pipeline's own five states are untouched
 * and unread by any of it — a paused session whose last batch failed is both,
 * and a model that could not say so would force the queue to choose.
 *
 * **The migration that is not a migration.** Every Triage in production was
 * launched, charged and finished under the one-time model. Adding a column
 * with DEFAULT 'open' would turn all of them into live shortlists that can
 * take uploads and charges. So the column is nullable and NULL is answered
 * from the row's own state. That is tested against MADE-UP old sessions —
 * rows written here with lifecycle NULL, exactly as a pre-column row looks —
 * and never against anything real.
 *
 * **Letting go.** Nothing in this product has ever deleted an applicant's CV.
 * The rule (Q6) and the sweep are tested on fixtures whose dates are set by
 * this file, so "90 days after closing" can be proved in a second.
 *
 * Everything this suite creates carries one marker and is removed on the way
 * out. Nothing it did not create is touched.
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
const MARK = `cking-life-${RUN}`
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))
const uploadDir = fileURLToPath(new URL('../server/uploads/', import.meta.url))

const H = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })
const DAY = 86400000

const JD = `Payments Operations Analyst

Requirements:
- 3+ years reviewing card-not-present transactions
- Chargeback and dispute handling end to end
- SQL for investigating transaction data

Nice to have:
- Fraud tooling, rules engines
`

const cv = async (index) => makePdf([
  `Applicant ${String(index).padStart(3, '0')}`,
  `applicant${index}.${RUN}@example.com · 050-333-${String(index).padStart(4, '0')} · Tel Aviv`,
  `Payments operations analyst, ${2 + (index % 9)} years of experience.`,
  'Skills: chargebacks, SQL, disputes, fraud rules.',
  'Reviewed card-not-present transactions daily and owned the dispute process end to end.',
])

const madeUp = []

/** A session written straight to the database, in the shape it would have. */
function fakeSession({ status, lifecycle = null, closedAt = null, purgeAfter = null, cvAgeDays = 1 }) {
  const stamp = new Date().toISOString()
  const info = db.prepare(`
    INSERT INTO triages (
      company_id, recruiter_id, title, raw_jd, status, lifecycle, closed_at, purge_after,
      file_cap, ledger_id, charged_cvs, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 500, 999999, 2, ?, ?)
  `).run(
    org.company.id, org.recruiter?.id ?? null, `${MARK} fake`, JD,
    status, lifecycle, closedAt, purgeAfter, stamp, stamp,
  )

  const id = Number(info.lastInsertRowid)
  madeUp.push(id)

  const uploaded = new Date(Date.now() - cvAgeDays * DAY).toISOString()
  for (let i = 0; i < 2; i += 1) {
    db.prepare(`
      INSERT INTO triage_applicants (
        triage_id, file_name, stored_name, parse_status, deep_status, created_at
      ) VALUES (?, ?, ?, 'parsed', 'scored', ?)
    `).run(id, `${MARK}-fake-${id}-${i}.pdf`, `${MARK}-fake-${id}-${i}.pdf`, uploaded)
  }

  return id
}

// --------------------------------------------------------------- the setup ---

const org = await registerAndSignIn({
  companyName: `${MARK} Ltd`, firstName: 'Liron', lastName: `Life${RUN}`,
  email: `liron.${RUN}@${MARK}.example.com`,
})
await approveCompanyById(org.company.id)
db.prepare(`UPDATE companies SET triage_cv_balance = 200 WHERE id = ?`).run(org.company.id)

const draft = await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST', headers: H(org.token), body: '{}',
}))
const id = draft.triage.id

await json(await fetch(`${BASE}/api/hr/triage/${id}`, {
  method: 'PATCH', headers: H(org.token),
  body: JSON.stringify({ jd: JD, title: `${MARK} session` }),
}))

const form = new FormData()
for (let i = 0; i < 4; i += 1) {
  form.append('cvs', new Blob([await cv(i)], { type: 'application/pdf' }), `cv-${i}.pdf`)
}
await json(await fetch(`${BASE}/api/hr/triage/${id}/files`, {
  method: 'POST', headers: { authorization: `Bearer ${org.token}` }, body: form,
}))

section('A new session is open')

check('a draft starts open', draft.triage.lifecycle === 'open', String(draft.triage.lifecycle))
check('with no closing date', draft.triage.purgeAfter === null, String(draft.triage.purgeAfter))

const launched = await fetch(`${BASE}/api/hr/triage/${id}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
})
check('and starting it does not change that', launched.ok, `HTTP ${launched.status}`)

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

const done = await settle(id)
check('the session finishes', done?.total === 4, `${done?.total} scored`)
check('and is still open once the queue catches up',
  done.triage.lifecycle === 'open', String(done.triage.lifecycle))

// ------------------------------------------------------------- the states ---

const move = (to) => fetch(`${BASE}/api/hr/triage/${id}/lifecycle`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ state: to }),
})

const addOne = async () => {
  const body = new FormData()
  body.append('cvs', new Blob([await cv(90)], { type: 'application/pdf' }), 'late.pdf')
  return fetch(`${BASE}/api/hr/triage/${id}/cvs`, {
    method: 'POST', headers: { authorization: `Bearer ${org.token}` }, body,
  })
}

section('Pausing stops new work and nothing else')

const paused = await json(await move('paused'))
check('the session pauses', paused.to === 'paused', String(paused.to))

const whilePaused = await addOne()
check('and takes no more CVs', whilePaused.status === 409, `HTTP ${whilePaused.status}`)
check('with a message that says what to do',
  /Resume it/.test(String((await whilePaused.json().catch(() => ({}))).error ?? '')))

const retryPaused = await fetch(`${BASE}/api/hr/triage/${id}/retry`, {
  method: 'POST', headers: H(org.token), body: '{}',
})
check('and starts no new analysis', retryPaused.status === 409, `HTTP ${retryPaused.status}`)

const readPaused = await fetch(`${BASE}/api/hr/triage/${id}/results?advance=1`, { headers: H(org.token) })
const readPausedBody = await readPaused.json()
check('but can still be read', readPaused.ok && readPausedBody.total === 4,
  `HTTP ${readPaused.status}, ${readPausedBody.total} results`)
check('and asks for no further tranche', readPausedBody.queued === null,
  JSON.stringify(readPausedBody.queued))

const resumed = await json(await move('open'))
check('resuming puts it back', resumed.to === 'open', String(resumed.to))

section('Closing starts the clock; reopening stops it')

const closed = await json(await move('closed'))
check('the session closes', closed.to === 'closed', String(closed.to))
check('and is given a date its CVs go', Boolean(closed.purgeAfter), String(closed.purgeAfter))

const days = Math.round((Date.parse(closed.purgeAfter) - Date.now()) / DAY)
check('ninety days out', days === 90 || days === 89, `${days} days`)

const whileClosed = await addOne()
check('a closed session takes no CVs', whileClosed.status === 409, `HTTP ${whileClosed.status}`)
check('with a message that says what to do',
  /Reopen it/.test(String((await whileClosed.json().catch(() => ({}))).error ?? '')))

const stillReadable = await fetch(`${BASE}/api/hr/triage/${id}/results`, { headers: H(org.token) })
check('and is still readable as history', stillReadable.ok, `HTTP ${stillReadable.status}`)

const reopened = await json(await move('open'))
check('reopening works', reopened.to === 'open', String(reopened.to))
check('and takes the deletion date away', reopened.purgeAfter === null,
  String(reopened.purgeAfter))
check('which the stored row agrees with',
  db.prepare(`SELECT purge_after AS at FROM triages WHERE id = ?`).get(id).at === null)

const nonsense = await fetch(`${BASE}/api/hr/triage/${id}/lifecycle`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ state: 'archived' }),
})
check('a state that does not exist is refused', nonsense.status === 400, `HTTP ${nonsense.status}`)

// ------------------------------------------------- sessions from before ---

section('Sessions that predate the column read as what they are')

const oldFinished = fakeSession({ status: 'completed', lifecycle: null })
const oldWorking = fakeSession({ status: 'ready', lifecycle: null })
const oldFailed = fakeSession({ status: 'failed', lifecycle: null })

const viewOf = async (sessionId) => json(
  await fetch(`${BASE}/api/hr/triage/${sessionId}`, { headers: H(org.token) }),
)

check('a finished one reads as closed',
  (await viewOf(oldFinished)).triage.lifecycle === 'closed')
check('a failed one reads as closed',
  (await viewOf(oldFailed)).triage.lifecycle === 'closed')
check('one still working reads as open',
  (await viewOf(oldWorking)).triage.lifecycle === 'open')

check('and none of them was given a deletion date behind our back',
  db.prepare(`
    SELECT COUNT(*) AS n FROM triages WHERE id IN (?, ?, ?) AND purge_after IS NOT NULL
  `).get(oldFinished, oldWorking, oldFailed).n === 0)

const reopenedOld = await json(await fetch(`${BASE}/api/hr/triage/${oldFinished}/lifecycle`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ state: 'open' }),
}))
check('a finished one can be reopened', reopenedOld.to === 'open', String(reopenedOld.to))
check('and the row now says so explicitly',
  db.prepare(`SELECT lifecycle AS l FROM triages WHERE id = ?`).get(oldFinished).l === 'open')

// ------------------------------------------------------------ retention ---

section('The rule says what would go, and deletes nothing by itself')

const { dueForDeletion, runRetention } = await import('../server/src/retention.js')

/* Closed a hundred days ago, so its date has passed. */
const longClosed = fakeSession({
  status: 'completed',
  lifecycle: 'closed',
  closedAt: new Date(Date.now() - 100 * DAY).toISOString(),
  purgeAfter: new Date(Date.now() - 10 * DAY).toISOString(),
})

/* Open, but holding CVs from four hundred days ago. This is the clock that
   actually binds: without it a session left open keeps everything forever. */
const oldCvs = fakeSession({ status: 'ready', lifecycle: 'open', cvAgeDays: 400 })

/* Closed yesterday. Its date is ninety days away and it must be left alone. */
const justClosed = fakeSession({
  status: 'completed',
  lifecycle: 'closed',
  closedAt: new Date(Date.now() - DAY).toISOString(),
  purgeAfter: new Date(Date.now() + 89 * DAY).toISOString(),
})

const due = dueForDeletion({})
const dueIn = (sessionId) => due.filter((row) => row.triageId === sessionId).length

check('a session closed a hundred days ago is due', dueIn(longClosed) === 2, `${dueIn(longClosed)}`)
check('and so are year-old CVs in a session still open', dueIn(oldCvs) === 2, `${dueIn(oldCvs)}`)
check('one closed yesterday is not', dueIn(justClosed) === 0, `${dueIn(justClosed)}`)
check('nor is the live session', dueIn(id) === 0, `${dueIn(id)}`)

check('the reasons are named',
  due.find((row) => row.triageId === oldCvs)?.because === 'twelve months since it was uploaded'
  && due.find((row) => row.triageId === longClosed)?.because === 'ninety days since the session closed',
  JSON.stringify([...new Set(due.map((row) => row.because))]))

const reported = runRetention({})
check('running it changes nothing', reported.deletedAnything === false)
check('and every row is still there',
  db.prepare(`SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ?`).get(longClosed).n === 2)

section('And deletes exactly what it named when told to')

const before = db.prepare(`SELECT COUNT(*) AS n FROM triage_applicants`).get().n
const acted = runRetention({ deletes: true, triageId: longClosed })

check('it deletes only that session', acted.deleted === 2, `${acted.deleted}`)
check('and only that session',
  db.prepare(`SELECT COUNT(*) AS n FROM triage_applicants`).get().n === before - 2)
check('the year-old CVs elsewhere are untouched',
  db.prepare(`SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ?`).get(oldCvs).n === 2)
check('the session itself stays, with its billing line',
  db.prepare(`SELECT ledger_id AS l FROM triages WHERE id = ?`).get(longClosed).l === 999999)

// --------------------------------------------------------- one CV at a time ---

section('One CV can be removed, which is what an erasure request needs')

const victim = db.prepare(`
  SELECT id, stored_name AS stored FROM triage_applicants
  WHERE triage_id = ? AND parse_status = 'parsed' ORDER BY id LIMIT 1
`).get(id)

const storedAt = path.join(uploadDir, victim.stored)
check('its file is on disk to begin with', fs.existsSync(storedAt))

const balanceBefore = db.prepare(`SELECT triage_cv_balance AS n FROM companies WHERE id = ?`)
  .get(org.company.id).n

const gone = await fetch(`${BASE}/api/hr/triage/${id}/applicants/${victim.id}`, {
  method: 'DELETE', headers: H(org.token),
})
check('the author can remove it', gone.ok, `HTTP ${gone.status}`)
check('the row is gone',
  !db.prepare(`SELECT id FROM triage_applicants WHERE id = ?`).get(victim.id))
check('and so is the file', !fs.existsSync(storedAt))
check('nothing is refunded for it',
  db.prepare(`SELECT triage_cv_balance AS n FROM companies WHERE id = ?`).get(org.company.id).n
  === balanceBefore,
  `balance ${balanceBefore}`)

const afterDelete = await json(await fetch(`${BASE}/api/hr/triage/${id}/results`, { headers: H(org.token) }))
check('and it is out of the results', afterDelete.total === 3, `${afterDelete.total}`)

const missing = await fetch(`${BASE}/api/hr/triage/${id}/applicants/99999999`, {
  method: 'DELETE', headers: H(org.token),
})
check('a CV that is not there answers 404', missing.status === 404, `HTTP ${missing.status}`)

// ----------------------------------------------------------------- the cap ---

section('An organization cannot leave unlimited sessions open')

const { TRIAGE } = await import('../server/src/triage.js')
const { openSessions } = await import('../server/src/triage.js')

check('the cap is a number', TRIAGE.maxOpenSessions > 0, String(TRIAGE.maxOpenSessions))
check('and open sessions are counted', openSessions(org.company.id) >= 1,
  `${openSessions(org.company.id)} open`)

/* Filled to the cap with made-up sessions rather than by launching two dozen
   real ones — the cap is arithmetic, and paying for 25 Triages to prove it
   would take minutes and real capacity. */
while (openSessions(org.company.id) < TRIAGE.maxOpenSessions) {
  fakeSession({ status: 'ready', lifecycle: 'open' })
}

const overCap = await fetch(`${BASE}/api/hr/triage/${justClosed}/lifecycle`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ state: 'open' }),
})
check('reopening one more is refused', overCap.status === 409, `HTTP ${overCap.status}`)
check('and says why',
  /which is the limit/.test(String((await overCap.json().catch(() => ({}))).error ?? '')))

// ---------------------------------------------------------------- cleanup ---

section('Cleanup')

for (const sessionId of [id, ...madeUp]) {
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
