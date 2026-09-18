/**
 * The Triage history is what was started, and New always does something.
 *
 *  1. Opening New Triage and leaving without pressing Start put an "Untitled
 *     Triage" in the rail. The history now lists only launched Triages.
 *  2. Hiding drafts must not strand them. A recruiter who uploads two hundred
 *     CVs and clicks away comes back through New — so New reopens their
 *     unfinished draft instead of starting another row beside it, and empty
 *     duplicates are cleared away rather than accumulating.
 *  3. Pressing New while a Triage was open did nothing: the workspace copied its
 *     id into state once and ignored the new one. It is now remounted per press.
 *  4. The search box stayed editable while a search ran.
 */
import fs from 'node:fs'

import { BASE, createReporter, json, makePdf, registerApprovedCompany } from './helpers.mjs'

const { check, section, finish } = createReporter()

const RUN = Date.now().toString(36)
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

const org = await registerApprovedCompany({
  companyName: `cking-history-${RUN} Ltd`,
  email: `hist.${RUN}@cking-history-${RUN}.example.com`,
  phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
})
const H = { authorization: `Bearer ${org.token}`, 'content-type': 'application/json' }

const { default: Database } = await import('better-sqlite3')
const db = new Database(new URL('../server/data/cking.db', import.meta.url).pathname.slice(1))

const rail = async () => (await json(await fetch(`${BASE}/api/hr/triages`, { headers: H }))).triages
const openNew = async () => json(await fetch(`${BASE}/api/hr/triages/new`, { headers: H }))
const createDraft = async () => (await json(await fetch(`${BASE}/api/hr/triage`, {
  method: 'POST', headers: H, body: '{}',
}))).triage

section('An untouched draft is not history')
const blank = await openNew()
check('New with no draft gives a blank builder', !blank.triage.id, `id ${blank.triage.id}`)

const empty = await createDraft()
check('a draft row can exist', Boolean(empty?.id))
check('but it is not in the rail', !(await rail()).some((t) => t.id === empty.id),
  'this was the "Untitled Triage" nobody started')

section('New reopens the unfinished draft instead of making another')
const resumed = await openNew()
check('New comes back with that draft', resumed.triage.id === empty.id,
  `${resumed.triage.id} vs ${empty.id}`)

/* Put something in it, the way the builder does. */
await fetch(`${BASE}/api/hr/triage/${empty.id}`, {
  method: 'PATCH', headers: H,
  body: JSON.stringify({ title: `Ops ${RUN}`, jd: 'Operations analyst reviewing transactions daily. Must know Excel and SQL. Reports to the finance lead.' }),
})
const again = await openNew()
check('and brings its job description with it', again.triage.id === empty.id
  && /Operations analyst/.test(again.triage.jd ?? ''),
  'work typed into a draft is reachable again through New')

section('Empty duplicates are cleared, not accumulated')
const stray = await createDraft()
await createDraft()
const draftsBefore = db.prepare(
  `SELECT COUNT(*) n FROM triages WHERE company_id = ? AND ledger_id IS NULL`,
).get(org.company.id).n
check('two more empty drafts exist before New is pressed', draftsBefore === 3, `${draftsBefore}`)

/* The newest empty draft is the one reopened; ours has a JD but is older. Make
   ours the most recent so the test checks the clean-up rather than the pick. */
db.prepare(`UPDATE triages SET updated_at = ? WHERE id = ?`).run('9999-01-01T00:00:00.000Z', empty.id)
const cleaned = await openNew()
const draftsAfter = db.prepare(
  `SELECT COUNT(*) n FROM triages WHERE company_id = ? AND ledger_id IS NULL`,
).get(org.company.id).n
check('New reopens the latest draft', cleaned.triage.id === empty.id)
check('and the empty ones are gone', draftsAfter === 1, `${draftsAfter} drafts left`)
check('the one with content survives', Boolean(db.prepare('SELECT id FROM triages WHERE id = ?').get(empty.id)))
check('the stray does not', !db.prepare('SELECT id FROM triages WHERE id = ?').get(stray.id))

section('Pressing Start makes it history')
const form = new FormData()
for (let i = 0; i < 2; i += 1) {
  form.append('cvs', new Blob([await makePdf([
    `Applicant ${i} ${RUN}`, 'Operations analyst', 'ANALYST, Co 2020 - present',
    '  Reviewed transactions daily and built the reconciliation process.', 'SKILLS: Excel, SQL',
  ])], { type: 'application/pdf' }), `hist-${i}-${RUN}.pdf`)
}
await fetch(`${BASE}/api/hr/triage/${empty.id}/files`, {
  method: 'POST', headers: { authorization: H.authorization }, body: form,
})
/* Enough capacity whatever the welcome grant happens to be. */
db.prepare('UPDATE companies SET triage_cv_balance = triage_cv_balance + 10 WHERE id = ?').run(org.company.id)
const launched = await fetch(`${BASE}/api/hr/triage/${empty.id}/launch`, { method: 'POST', headers: H, body: '{}' })
check('the draft launches', launched.ok, `HTTP ${launched.status} — launch answers 201 Created`)
check('and now it is in the rail', (await rail()).some((t) => t.id === empty.id))
check('New after launching is blank again', !(await openNew()).triage.id,
  'a launched Triage is history, not a draft to reopen')

section('New is honoured while a Triage is open')
const tab = read('../client/src/components/TriageTab.jsx')
check('the workspace is keyed per instruction from the rail',
  /<TriageWorkspace[\s\S]{0,1500}key=\{open \?/.test(tab),
  'without a key the new id prop was ignored and New looked dead')
check('and a resumed draft is adopted before the builder can create a second one',
  /if \(!which && data\?\.triage\?\.id\) setId\(data\.triage\.id\)/.test(tab))

section('The search box is locked while searching')
const hero = read('../client/src/components/SearchHero.jsx')
check('read-only while busy, not only once finished', /readOnly=\{submitted \|\| busy\}/.test(hero),
  'the landing hero never passes submitted, so busy is what locks it')
check('and a pasted screenshot cannot replace it mid-search',
  /if \(!acceptsImages \|\| busy \|\| submitted\) return/.test(hero))

section('Cleanup')
/* Let the launched Triage's background work settle before removing its rows. */
for (let i = 0; i < 40; i += 1) {
  const state = await json(await fetch(`${BASE}/api/hr/triage/${empty.id}`, { headers: H })).catch(() => ({}))
  if (!state.working) break
  await new Promise((resolve) => setTimeout(resolve, 500))
}
const stored = db.prepare(`
  SELECT a.stored_name FROM triage_applicants a JOIN triages t ON t.id = a.triage_id WHERE t.company_id = ?
`).all(org.company.id).map((r) => r.stored_name).filter(Boolean)
db.prepare('DELETE FROM triage_applicants WHERE triage_id IN (SELECT id FROM triages WHERE company_id = ?)').run(org.company.id)
db.prepare('DELETE FROM triage_cost_events WHERE triage_id IN (SELECT id FROM triages WHERE company_id = ?)').run(org.company.id)
db.prepare('DELETE FROM triage_drops WHERE triage_id IN (SELECT id FROM triages WHERE company_id = ?)').run(org.company.id)
db.prepare('DELETE FROM triage_batches WHERE triage_id IN (SELECT id FROM triages WHERE company_id = ?)').run(org.company.id)
db.prepare('DELETE FROM triages WHERE company_id = ?').run(org.company.id)
for (const name of stored) {
  const p = new URL(`../server/uploads/${name}`, import.meta.url).pathname.slice(1)
  if (fs.existsSync(p)) fs.unlinkSync(p)
}
const recruiters = db.prepare('SELECT id FROM recruiters WHERE company_id = ?').all(org.company.id).map((r) => r.id)
if (recruiters.length) {
  db.prepare(`DELETE FROM recruiter_password_resets WHERE recruiter_id IN (${recruiters.join(',')})`).run()
  db.prepare('DELETE FROM recruiters WHERE company_id = ?').run(org.company.id)
}
db.prepare('DELETE FROM billing_ledger WHERE company_id = ?').run(org.company.id)
db.prepare('DELETE FROM companies WHERE id = ?').run(org.company.id)
check('test company removed', !db.prepare('SELECT id FROM companies WHERE id = ?').get(org.company.id))
db.close()

finish()
