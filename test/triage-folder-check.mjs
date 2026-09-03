/**
 * A Triage applicant, filed into a folder.
 *
 * A folder used to hold exactly one kind of thing: a marketplace candidate, by
 * a NOT NULL foreign key into `candidates`. It now holds two, and the second is
 * a CV somebody uploaded to a Triage — which has no profile behind it, no
 * freshness clock and no inbox.
 *
 * So the checks here are about the seam. Can one be filed at all; does the
 * folder list carry both kinds; does a row that came from a Triage say so; and
 * — the one that matters most — can an applicant id from another organization
 * be filed into this one's folder, which would put somebody else's candidate
 * name, email and phone number on this company's screen.
 */
import fs from 'node:fs'

import {
  BASE, createReporter, json, makePdf, registerApprovedCompany,
} from './helpers.mjs'

const { check, section, finish } = createReporter('triage folders')

const RUN = Date.now().toString(36)
const MARKER = `cking-tfd-${RUN}`
const H = (token) => ({ 'Content-Type': 'application/json', authorization: `Bearer ${token}` })

const org = await registerApprovedCompany({
  companyName: MARKER,
  firstName: 'Tova', lastName: 'Triage',
  email: `tova@${MARKER}.example.com`, phone: `052-${String(Date.now()).slice(-6, -3)}-8813`,
})

const other = await registerApprovedCompany({
  companyName: `${MARKER}-b`,
  firstName: 'Eyal', lastName: 'Elsewhere',
  email: `eyal@${MARKER}.example.com`, phone: `053-${String(Date.now()).slice(-6, -3)}-8814`,
})

/** A Triage with one CV in it, belonging to whoever's token is passed. */
async function triageWithOneCv(token, title, who) {
  const created = await json(await fetch(`${BASE}/api/hr/triage`, {
    method: 'POST', headers: H(token), body: JSON.stringify({ title }),
  }))
  const made = created.triage ?? created

  const form = new FormData()
  form.append('cvs', new Blob([await makePdf([
    who,
    'Senior Backend Engineer',
    'Payments, ledgers and reconciliation systems.',
    'Node.js, PostgreSQL, Redis, Kafka, Docker, AWS.',
    'Built a double-entry ledger handling settlement across three currencies.',
    'Previously at a payments processor working on card authorisation flows.',
    'BSc Computer Science.',
  ])], { type: 'application/pdf' }), `${who.replace(/\s+/g, '-')}.pdf`)

  const uploaded = await fetch(`${BASE}/api/hr/triage/${made.id}/files`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form,
  })

  return { id: made.id, uploadStatus: uploaded.status, uploaded: await json(uploaded) }
}

const mine = await triageWithOneCv(org.token, 'Backend engineer', 'Noa Applicant')
check('a Triage accepts a CV', mine.uploadStatus === 200 || mine.uploadStatus === 201,
  `got ${mine.uploadStatus}`)

const applicantId = mine.uploaded?.files?.[0]?.id ?? mine.uploaded?.applicants?.[0]?.id
check('and reports the applicant it stored', Number.isInteger(applicantId),
  `got ${JSON.stringify(mine.uploaded).slice(0, 200)}`)

const folder = await json(await fetch(`${BASE}/api/hr/folders`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ name: 'Backend shortlist' }),
}))
check('a folder is created', Number.isInteger(folder.id))

// --------------------------------------------------------------------------
section('Filing one')

const filed = await fetch(`${BASE}/api/hr/folders/${folder.id}/triage-items`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ applicantId }),
})
check('the applicant is filed', filed.ok, `got ${filed.status}`)

const afterFiling = await json(filed)
const shortlist = (afterFiling.folders ?? []).find((f) => f.id === folder.id)
check('and comes back on the folder', shortlist?.items?.length === 1,
  `got ${shortlist?.items?.length}`)

const row = shortlist?.items?.[0] ?? {}
check('under the name read off the CV', Boolean(row.display_name), `got ${row.display_name}`)
check('with no candidate id, because there is no profile behind them',
  row.candidate_id === null, `got ${row.candidate_id}`)
check('and the applicant id instead', row.triage_applicant_id === applicantId)

/*
 * The chip. This is the whole of the user-visible difference between the two
 * kinds of row, so it is the thing that must not be absent.
 */
check('the row says which Triage it came from', row.fromTriage?.id === mine.id,
  `got ${JSON.stringify(row.fromTriage)}`)
check('and names it', row.fromTriage?.title === 'Backend engineer',
  `got ${row.fromTriage?.title}`)

check('it carries no pipeline status, since none of them apply to a CV',
  row.status === null,
  'nothing to reveal, no inbox to message — a seventh key would be a stage that means nothing')

check('the filing index says where they are',
  afterFiling.filed?.[applicantId]?.id === folder.id,
  `got ${JSON.stringify(afterFiling.filed)}`)

// --------------------------------------------------------------------------
section('Filing twice is filing once')

const again = await fetch(`${BASE}/api/hr/folders/${folder.id}/triage-items`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ applicantId }),
})
const afterAgain = await json(again)
check('a second file changes nothing',
  (afterAgain.folders ?? []).find((f) => f.id === folder.id)?.items?.length === 1)

// --------------------------------------------------------------------------
section('Another organization cannot file this one’s applicants')

const theirFolder = await json(await fetch(`${BASE}/api/hr/folders`, {
  method: 'POST', headers: H(other.token), body: JSON.stringify({ name: 'Theirs' }),
}))

const across = await fetch(`${BASE}/api/hr/folders/${theirFolder.id}/triage-items`, {
  method: 'POST', headers: H(other.token), body: JSON.stringify({ applicantId }),
})
check('an applicant from another company is refused', across.status === 404,
  `got ${across.status} — this would put somebody else's name, email and phone on their screen`)

const intoMine = await fetch(`${BASE}/api/hr/folders/${folder.id}/triage-items`, {
  method: 'POST', headers: H(other.token), body: JSON.stringify({ applicantId }),
})
check('and so is filing into another company’s folder', intoMine.status === 404,
  `got ${intoMine.status}`)

const theirs = await json(await fetch(`${BASE}/api/hr/folders`, { headers: H(other.token) }))
check('their folder is still empty',
  theirs.folders.find((f) => f.id === theirFolder.id)?.items?.length === 0)

// --------------------------------------------------------------------------
section('Taking one out')

const removed = await fetch(`${BASE}/api/hr/folders/triage-items/${applicantId}`, {
  method: 'DELETE', headers: H(org.token),
})
check('the applicant is removed', removed.ok, `got ${removed.status}`)
const afterRemoval = await json(removed)
check('and the folder is empty again',
  (afterRemoval.folders ?? []).find((f) => f.id === folder.id)?.items?.length === 0)
check('and the index no longer names a folder for them',
  !afterRemoval.filed?.[applicantId])

// --------------------------------------------------------------------------
section('Deleting the Triage takes the folder row with it')

await fetch(`${BASE}/api/hr/folders/${folder.id}/triage-items`, {
  method: 'POST', headers: H(org.token), body: JSON.stringify({ applicantId }),
})

const dropped = await fetch(`${BASE}/api/hr/triage/${mine.id}`, {
  method: 'DELETE', headers: H(org.token),
})
check('the Triage is deleted', dropped.ok, `got ${dropped.status}`)

const afterDelete = await json(await fetch(`${BASE}/api/hr/folders`, { headers: H(org.token) }))
check('and the folder row goes with it, rather than naming a CV that no longer exists',
  afterDelete.folders.find((f) => f.id === folder.id)?.items?.length === 0,
  'ON DELETE CASCADE — the rail warns before deleting for exactly this reason')

// --------------------------------------------------------------------------
section('The screens')

const triageTab = fs.readFileSync(new URL('../client/src/components/TriageTab.jsx', import.meta.url), 'utf8')
const panel = fs.readFileSync(new URL('../client/src/pages/HrPanel.jsx', import.meta.url), 'utf8')

check('the Triage card offers Save in folder',
  /label: 'Save in folder'/.test(triageTab))
check('behind the same dialog the rest of the product uses',
  /<FolderDialog/.test(triageTab))
check('and it draws the search card, not a row of its own',
  /className="result-lead"/.test(triageTab) && !/triage-result-main/.test(triageTab))
check('with no reveal chip, because nothing here is locked',
  !/chip-revealed/.test(triageTab))

check('the applicant dialog has Profile and Score',
  /\['profile', 'Profile'\]/.test(triageTab) && /\['score', 'Score'\]/.test(triageTab))
check('and no Messages tab, because there is no inbox behind an applicant',
  !/'messages'/.test(triageTab))

check('a folder row that came from a Triage wears a chip', /chip-triage/.test(panel))
check('naming the Triage rather than saying "Triage"', /From \$\{result\.fromTriage\.title\}/.test(panel))

// --------------------------------------------------------------------------
section('Cleanup')

const { default: db } = await import('../server/src/db.js')

let companies = 0
for (const co of db.prepare(`SELECT id, name FROM companies`).all()) {
  if (!new RegExp(`^${MARKER}(-b)?$`).test(co.name)) continue
  for (const t of ['billing_ledger', 'reveals', 'organization_reveals', 'folders', 'saved_searches']) {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)) {
      db.prepare(`DELETE FROM "${t}" WHERE company_id = ?`).run(co.id)
    }
  }
  for (const t of db.prepare(`SELECT id FROM triages WHERE company_id = ?`).all(co.id)) {
    db.prepare(`DELETE FROM triage_applicants WHERE triage_id = ?`).run(t.id)
  }
  db.prepare(`DELETE FROM triages WHERE company_id = ?`).run(co.id)
  for (const r of db.prepare(`SELECT id FROM recruiters WHERE company_id = ?`).all(co.id)) {
    db.prepare(`DELETE FROM analytics_events WHERE actor_type='recruiter' AND actor_id=?`).run(r.id)
  }
  db.prepare(`DELETE FROM analytics_events WHERE actor_type='company' AND actor_id=?`).run(co.id)
  db.prepare(`DELETE FROM recruiters WHERE company_id = ?`).run(co.id)
  db.prepare(`DELETE FROM companies WHERE id = ?`).run(co.id)
  companies += 1
}
check('the two organizations this run made are gone', companies === 2, `removed ${companies}`)

finish()
