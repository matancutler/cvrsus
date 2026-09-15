/**
 * Three things a recruiter running a Triage noticed, checked where they live.
 *
 *  1. "Remove all" — clearing a draft of hundreds of CVs used to mean pressing
 *     Remove once per file. It is one request now, and it must obey the same
 *     rules as removing one: only the owning company, only before launch.
 *  2. The header read "0 of 26 applicants fully analysed" while scored rows
 *     were already filling the list beneath it, because the count was only
 *     recomputed after every applicant in a batch had finished.
 *  3. Two lines of reasoning ran under the score on every card and collided
 *     with it. The reasoning belongs in the applicant dialog, which already
 *     shows it in full.
 */
import fs from 'node:fs'

import { BASE, createReporter, json, makePdf, registerApprovedCompany } from './helpers.mjs'

const { check, section, finish } = createReporter()

const RUN = Date.now().toString(36)
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

const owner = await registerApprovedCompany({
  companyName: `cking-draftux-${RUN} Ltd`,
  email: `owner.${RUN}@cking-draftux-${RUN}.example.com`,
  phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
})
const auth = { authorization: `Bearer ${owner.token}` }

/* A draft, through the same route the page uses — see triage-check.mjs. */
const draft = await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({}),
}))

section('Setup')
const triageId = draft.triage?.id ?? null
check('a draft Triage exists to test against', Boolean(triageId))

async function upload(n) {
  const form = new FormData()
  for (let i = 0; i < n; i += 1) {
    form.append('cvs', new Blob([await makePdf([
      `Applicant ${i} ${RUN}`, 'Operations analyst', 'ANALYST, Co 2020 - present',
      '  Reviewed transactions daily and built the reconciliation process.', 'SKILLS: Excel, SQL',
    ])], { type: 'application/pdf' }), `applicant-${i}-${RUN}.pdf`)
  }
  return fetch(`${BASE}/api/hr/triage/${triageId}/files`, { method: 'POST', headers: auth, body: form })
}

if (triageId) {
  section('Remove all')
  const uploaded = await upload(3)
  const afterUpload = await uploaded.json().catch(() => ({}))
  check('three files are in the draft', (afterUpload.files ?? []).length === 3,
    `${(afterUpload.files ?? []).length} files — HTTP ${uploaded.status}`)

  const { default: Database } = await import('better-sqlite3')
  const db = new Database(new URL('../server/data/cking.db', import.meta.url).pathname.slice(1))
  const stored = db.prepare('SELECT stored_name FROM triage_applicants WHERE triage_id = ?')
    .all(triageId).map((r) => r.stored_name)
  const onDisk = (name) => fs.existsSync(new URL(`../server/uploads/${name}`, import.meta.url).pathname.slice(1))

  /* Another company must not be able to empty it. */
  const stranger = await registerApprovedCompany({
    companyName: `cking-draftux-${RUN}-b Ltd`,
    email: `other.${RUN}@cking-draftux-${RUN}.example.com`,
    phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
  })
  const trespass = await fetch(`${BASE}/api/hr/triage/${triageId}/files`, {
    method: 'DELETE', headers: { authorization: `Bearer ${stranger.token}` },
  })
  check('another company cannot clear it', trespass.status === 404, `HTTP ${trespass.status}`)
  check('and the files are all still there',
    db.prepare('SELECT COUNT(*) n FROM triage_applicants WHERE triage_id = ?').get(triageId).n === 3)

  const cleared = await fetch(`${BASE}/api/hr/triage/${triageId}/files`, { method: 'DELETE', headers: auth })
  const clearedBody = await cleared.json().catch(() => ({}))
  check('the owner can clear it in one request', cleared.status === 200, `HTTP ${cleared.status}`)
  check('it reports how many it removed', clearedBody.removed === 3, `${clearedBody.removed}`)
  check('the draft is empty', (clearedBody.files ?? [1]).length === 0)
  check('no rows remain', db.prepare('SELECT COUNT(*) n FROM triage_applicants WHERE triage_id = ?').get(triageId).n === 0)
  check('the counters agree', clearedBody.triage?.counts?.total === 0 || clearedBody.triage?.totalFiles === 0
    || db.prepare('SELECT total_files FROM triages WHERE id = ?').get(triageId).total_files === 0)

  /* Unlinks are fire-and-forget; give them a moment. */
  await new Promise((resolve) => setTimeout(resolve, 300))
  check('and the uploaded files are off disk', stored.every((name) => !onDisk(name)),
    'a cleared draft must not leave hundreds of CVs behind on the server')

  section('Cleanup')
  for (const companyId of [owner.company.id, stranger.company.id]) {
    db.prepare('DELETE FROM triage_applicants WHERE triage_id IN (SELECT id FROM triages WHERE company_id = ?)').run(companyId)
    db.prepare('DELETE FROM triage_cost_events WHERE triage_id IN (SELECT id FROM triages WHERE company_id = ?)').run(companyId)
    db.prepare('DELETE FROM triages WHERE company_id = ?').run(companyId)
    const recruiters = db.prepare('SELECT id FROM recruiters WHERE company_id = ?').all(companyId).map((r) => r.id)
    if (recruiters.length) {
      db.prepare(`DELETE FROM recruiter_password_resets WHERE recruiter_id IN (${recruiters.join(',')})`).run()
      db.prepare('DELETE FROM recruiters WHERE company_id = ?').run(companyId)
    }
    db.prepare('DELETE FROM billing_ledger WHERE company_id = ?').run(companyId)
    db.prepare('DELETE FROM companies WHERE id = ?').run(companyId)
  }
  check('test companies removed',
    !db.prepare("SELECT id FROM companies WHERE name LIKE ?").get(`cking-draftux-${RUN}%`))
  db.close()
}

section('The analysed count moves as each applicant lands')
const queue = read('../server/src/triageQueue.js')
const writeAt = queue.indexOf("SET deep_status = 'scored'")
const catchAt = queue.indexOf('} catch (error) {', writeAt)
check('recount runs inside the per-applicant success path',
  writeAt > 0 && /recount\(triage\.id\)/.test(queue.slice(writeAt, catchAt)),
  'it used to run only once the whole batch had finished')

section('The card no longer carries the reasoning; the dialog does')
const tab = read('../client/src/components/TriageTab.jsx')
const rowStart = tab.indexOf('className="result-main"')
const dialogStart = tab.indexOf('function TriageApplicantDialog')
check('no reasoning paragraph on the card',
  rowStart > 0 && !/analysis\.reasoning/.test(tab.slice(rowStart, dialogStart)),
  'it ran under the score and collided with it')
check('the dialog still shows it',
  /analysis\.reasoning/.test(tab.slice(dialogStart)),
  'removing it from the card must not remove it from the product')

finish()
