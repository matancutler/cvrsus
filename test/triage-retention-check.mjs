/**
 * When Triage CVs are let go of, and what happens when one is removed.
 *
 * Two things, and they are not the same thing.
 *
 * **Letting go.** Nothing in this product has ever deleted an applicant's CV.
 * The retention rule and the sweep are tested on fixtures whose dates are set
 * by this file, so "90 days after closing" can be proved in a second. The
 * sweep does not delete unless it is told to, and that is asserted too.
 *
 * **Removing one.** The per-CV delete is what an erasure request needs, and
 * it has two consequences that are easy to miss: the session has to notice it
 * has nothing left to do, and the next delivery must not be numbered into the
 * hole the deletion left — which is the failure that stranded CVs where
 * nothing in the product could name them.
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

section('A new session runs to the end')

check('with no deletion date yet', draft.triage.purgeAfter === null, String(draft.triage.purgeAfter))

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
check('and stays available once the queue catches up',
  done.triage.lifecycle === 'open', String(done.triage.lifecycle))

// ------------------------------------------------------------- the states ---

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

section('Deleting the top of the ranking does not strand the next delivery')

/*
 * The worst failure this phase could have shipped, and the review found it.
 *
 * Ranks were handed out above the highest SURVIVING rank. Delete the top of
 * a pile and that number drops, while analysis_frontier — which only ever
 * moves forward — does not. The next delivery was then numbered underneath
 * the cursor: parsed, ranked, charged, and permanently invisible, with
 * nothing in the product able to name it. Ranks are now issued above the
 * high-water mark, which includes the frontier.
 */
const strandDraft = await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST', headers: H(org.token), body: '{}',
}))
const strandId = strandDraft.triage.id
madeUp.push(strandId)

await json(await fetch(`${BASE}/api/hr/triage/${strandId}`, {
  method: 'PATCH', headers: H(org.token),
  body: JSON.stringify({ jd: JD, title: `${MARK} strand` }),
}))

const firstPile = new FormData()
for (let i = 0; i < 5; i += 1) {
  firstPile.append('cvs', new Blob([await cv(600 + i)], { type: 'application/pdf' }), `s-${i}.pdf`)
}
await json(await fetch(`${BASE}/api/hr/triage/${strandId}/files`, {
  method: 'POST', headers: { authorization: `Bearer ${org.token}` }, body: firstPile,
}))
await fetch(`${BASE}/api/hr/triage/${strandId}/launch`, {
  method: 'POST', headers: H(org.token), body: '{}',
})

await settle(strandId)
const frontierWas = db.prepare(`SELECT analysis_frontier AS n FROM triages WHERE id = ?`)
  .get(strandId).n
check('the first pile is analysed to the end', frontierWas === 5, `frontier ${frontierWas}`)

/* The two highest ranks go — an erasure request, or the sweep. */
const top = db.prepare(`
  SELECT id FROM triage_applicants WHERE triage_id = ? AND prelim_rank IS NOT NULL
  ORDER BY prelim_rank DESC LIMIT 2
`).all(strandId)

for (const row of top) {
  // eslint-disable-next-line no-await-in-loop
  await fetch(`${BASE}/api/hr/triage/${strandId}/applicants/${row.id}`, {
    method: 'DELETE', headers: H(org.token),
  })
}

check('the highest surviving rank is now below the frontier',
  db.prepare(`SELECT COALESCE(MAX(prelim_rank), 0) AS n FROM triage_applicants WHERE triage_id = ?`)
    .get(strandId).n < frontierWas,
  'which is the state that used to strand the next delivery')

const late = new FormData()
for (let i = 0; i < 3; i += 1) {
  late.append('cvs', new Blob([await cv(700 + i)], { type: 'application/pdf' }), `late-${i}.pdf`)
}
const landed = await fetch(`${BASE}/api/hr/triage/${strandId}/cvs`, {
  method: 'POST', headers: { authorization: `Bearer ${org.token}` }, body: late,
})
check('a new delivery is accepted', landed.status === 201, `HTTP ${landed.status}`)

await settle(strandId)

const strandedRows = db.prepare(`
  SELECT COUNT(*) AS n FROM triage_applicants
  WHERE triage_id = ? AND parse_status = 'parsed' AND deep_status <> 'scored'
`).get(strandId).n
check('every CV in it is analysed', strandedRows === 0, `${strandedRows} left unanalysed`)

check('and their ranks were issued above the frontier',
  db.prepare(`
    SELECT COALESCE(MIN(prelim_rank), 0) AS n FROM triage_applicants
    WHERE triage_id = ? AND analysed_at > (
      SELECT MAX(analysed_at) FROM triage_applicants WHERE triage_id = ? AND prelim_rank <= ?
    )
  `).get(strandId, strandId, frontierWas).n > frontierWas
  || db.prepare(`SELECT analysis_frontier AS n FROM triages WHERE id = ?`).get(strandId).n >= 8,
  `frontier ${db.prepare(`SELECT analysis_frontier AS n FROM triages WHERE id = ?`).get(strandId).n}`)

section('Deleting the last unscored CV settles the session')

const settleDraft = db.prepare(`
  SELECT id FROM triage_applicants WHERE triage_id = ? ORDER BY id LIMIT 1
`).get(strandId)

db.prepare(`UPDATE triage_applicants SET deep_status = 'failed' WHERE id = ?`).run(settleDraft.id)
db.prepare(`UPDATE triages SET status = 'ready' WHERE id = ?`).run(strandId)

await fetch(`${BASE}/api/hr/triage/${strandId}/applicants/${settleDraft.id}`, {
  method: 'DELETE', headers: H(org.token),
})

check('the session notices it has nothing left to do',
  db.prepare(`SELECT status AS s FROM triages WHERE id = ?`).get(strandId).s === 'completed',
  db.prepare(`SELECT status AS s FROM triages WHERE id = ?`).get(strandId).s)

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
