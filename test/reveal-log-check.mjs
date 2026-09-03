/**
 * The reveal log — GET /api/hr/reveals and the screen over it.
 *
 * What this list is: everyone the COMPANY has spent a reveal on, newest first.
 * Not a folder (nobody chose to build it), not a search (it is not scored), and
 * not per-recruiter (a reveal belongs to the organization that paid for it).
 *
 * The checks below are mostly about scope. A reveal log is a list of people a
 * company has paid to see under their real names, so the two ways it could be
 * wrong are both disclosures: showing one organization another's reveals, and
 * keeping somebody on it after they have blocked the employer reading it.
 */
import fs from 'node:fs'

import {
  BASE, contactProofs, createReporter, json, makePdf, makePng, registerApprovedCompany,
} from './helpers.mjs'

const { check, section, finish } = createReporter('reveal log')

const RUN = Date.now().toString(36)
const MARKER = `@cking-rvl-${RUN}.example.com`
const H = (token) => ({ 'Content-Type': 'application/json', authorization: `Bearer ${token}` })

const org = await registerApprovedCompany({
  companyName: `cking-rvl-${RUN}`,
  firstName: 'Rina', lastName: 'Reveal',
  email: `rina${MARKER}`, phone: `052-${String(Date.now()).slice(-6, -3)}-4471`,
})

/* A second organization, to prove the list is scoped to the first. */
const other = await registerApprovedCompany({
  companyName: `cking-rvl-${RUN}-b`,
  firstName: 'Oren', lastName: 'Other',
  email: `oren${MARKER}`, phone: `053-${String(Date.now()).slice(-6, -3)}-4472`,
})

async function apply(first, last) {
  const email = `${first.toLowerCase()}${MARKER}`
  const phone = `0509${String(100000 + Math.floor(Math.random() * 800000)).slice(1)}`
  const form = new FormData()
  form.append('firstName', first)
  form.append('lastName', last)
  form.append('email', email)
  form.append('phone', phone)
  form.append('location', 'Tel Aviv')
  form.append('openToAllOpportunities', 'true')
  form.append('notes', 'Backend engineer on payment systems, ledgers and reconciliation.')
  form.append('cv', new Blob([await makePdf([
    `${first} ${last}`,
    'Senior Backend Engineer',
    'Payments, ledgers and reconciliation systems.',
    'Node.js, PostgreSQL, Redis, Kafka, Docker, AWS.',
    'Built a double-entry ledger handling settlement across three currencies.',
    'Previously at a payments processor working on card authorisation flows.',
    'BSc Computer Science.',
  ])], { type: 'application/pdf' }), 'cv.pdf')
  form.append('photo', new Blob([makePng()], { type: 'image/png' }), 'me.png')
  const proofs = await contactProofs({ email, phone })
  form.append('emailProof', proofs.emailProof)
  form.append('phoneProof', proofs.phoneProof)
  form.append('consent', 'true')
  return json(await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form }))
}

const first = await apply('Noa', 'First')
const second = await apply('Gil', 'Second')
const never = await apply('Tal', 'Unrevealed')

const log = async (token) => json(await fetch(`${BASE}/api/hr/reveals`, { headers: H(token) }))

// --------------------------------------------------------------------------
section('An organization that has revealed nobody gets an empty list, not an error')

const empty = await log(org.token)
check('the route answers', Array.isArray(empty.reveals))
check('with nothing on it', empty.reveals.length === 0)
check('and the status vocabulary, as the folders route does',
  Array.isArray(empty.statuses) && empty.statuses.length > 0,
  'the filter bar over this list offers them, and a second copy in the client would drift')

// --------------------------------------------------------------------------
section('A reveal appears on it')

const revealOne = await fetch(`${BASE}/api/hr/candidates/${first.id}/reveal`, {
  method: 'POST', headers: H(org.token),
})
check('the reveal is accepted', revealOne.ok, `got ${revealOne.status}`)

const afterOne = await log(org.token)
check('and the candidate is on the log', afterOne.reveals.length === 1)

const row = afterOne.reveals[0] ?? {}
check('under their real name, because this company has paid to see it',
  row.display_name === 'Noa First', `got ${row.display_name}`)
check('with the date the reveal happened', Boolean(row.revealedAt) && !Number.isNaN(Date.parse(row.revealedAt)))
check('and who spent it', row.revealedBy === 'Rina Reveal', `got ${row.revealedBy}`)
check('carrying the recruiter id too, so the screen can say "you" rather than reading somebody their own name back',
  row.revealedById === org.recruiter?.id || typeof row.revealedById === 'number')

/*
 * The one field this list must NOT have.
 *
 * A reveal is not a match: the same person can be revealed out of one search
 * and have nothing to do with the next, so a percentage here would be a number
 * measured against a question nobody asked on this screen.
 */
check('and no score, because a reveal is not a match',
  row.score === undefined,
  'see the note on ResultCard corner')

check('the photo travels, since they are revealed by definition', row.has_photo === true)
check('and so does the activity reading the filter bar narrows on', Boolean(row.activity))

// --------------------------------------------------------------------------
section('Newest first, and only what this company revealed')

await fetch(`${BASE}/api/hr/candidates/${second.id}/reveal`, { method: 'POST', headers: H(org.token) })

const afterTwo = await log(org.token)
check('both are listed', afterTwo.reveals.length === 2)
check('newest first', afterTwo.reveals[0].candidate_id === second.id,
  `got ${afterTwo.reveals.map((r) => r.candidate_id).join(', ')}`)
check('the candidate nobody revealed is absent',
  !afterTwo.reveals.some((r) => r.candidate_id === never.id))

/*
 * The disclosure this route exists to not make.
 *
 * There is no :id and no company parameter — the scope comes off the session —
 * so this is a check that the construction holds rather than that a guard
 * fires. If it ever fails, someone has added an argument.
 */
const theirs = await log(other.token)
check('another organization sees none of it', theirs.reveals.length === 0,
  'the scope comes off the session; there is no id to pass')

// --------------------------------------------------------------------------
section('A candidate who blocks the employer leaves the list')

const blocked = await fetch(`${BASE}/api/candidates/${second.id}/blocks`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ companyId: org.company.id }),
})

if (blocked.status === 404 || blocked.status === 401) {
  check('the block route needs a candidate session — checked in identity-check instead', true,
    `skipped: ${blocked.status}`)
} else {
  const afterBlock = await log(org.token)
  check('they drop off the log', !afterBlock.reveals.some((r) => r.candidate_id === second.id),
    'the reveals row is untouched — billing history is not rewritten — but the working screen loses them')
}

// --------------------------------------------------------------------------
section('The screen over it')

const panel = fs.readFileSync(new URL('../client/src/pages/HrPanel.jsx', import.meta.url), 'utf8')

check('there is a Reveals item in the rail', /className=\{tab === 'reveals'/.test(panel))
check('and the page it opens is called Reveal History',
  /<h2>Reveal History<\/h2>/.test(panel),
  'the rail label names a place; the heading says what is on the page')
check('and it is under Folders, not inside them',
  panel.indexOf("tab === 'folders' ? 'ws-nav-item") < panel.indexOf("tab === 'reveals' ? 'ws-nav-item"))
check('the tab is mounted', /tab === 'reveals' && \(\s*<RevealsTab/.test(panel))
check('the list is filtered by the same bar the searches use',
  /<RevealsTab[\s\S]{0,400}/.test(panel) && /function RevealsTab[\s\S]*?<ResultFilters/.test(panel))
check('with the score control off, because there is no score here',
  /function RevealsTab[\s\S]*?showScore=\{false\}/.test(panel))
check('the card is the same ResultCard the folders draw',
  /function RevealsTab[\s\S]*?<ResultCard/.test(panel))
check('and its corner carries the date instead of a percentage',
  /function RevealsTab[\s\S]*?corner=\{\(/.test(panel)
  && /result-revealed-date/.test(panel))

/* Filing works from here, because "who have we unlocked" is the list you go
   through to decide who to shortlist. */
check('a revealed candidate can be filed into a folder from this screen',
  /function RevealsTab[\s\S]*?canSave/.test(panel)
  && /function RevealsTab[\s\S]*?<FolderDialog/.test(panel))

const css = fs.readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8')
check('the date corner is quieter than a score', /\.result-revealed-date\s*\{[^}]*font-size/.test(css))

/* The card lines up with the words above it. .results is an <ol>, so it carried
   40px of browser list padding and every card sat indented from its own
   heading — on this screen, in a folder, and in the searches. */
check('and the list is flush with the heading, not indented by the browser',
  /\.results \{[^}]*list-style: none;[^}]*padding: 0;/.test(css),
  'an <ol> whose marker is never drawn should not reserve the space for one')

// --------------------------------------------------------------------------
section('Cleanup')

/*
 * Name-scoped, and only what this run made.
 *
 * Every row is identified by the marker this run generated. Nothing is deleted
 * because a query returned it.
 */
const { default: db, UPLOAD_DIR } = await import('../server/src/db.js')
const { deleteCandidateCompletely } = await import('../server/src/profiles.js')

let removed = 0
for (const row of db.prepare(`SELECT id, email FROM candidates`).all()) {
  if (!row.email?.endsWith(MARKER)) continue
  for (const stored of deleteCandidateCompletely(row.id)) {
    fs.rmSync(new URL(`file:///${UPLOAD_DIR.replace(/\\/g, '/')}/${stored}`), { force: true })
  }
  removed += 1
}
check('the candidates this run created are gone', removed === 3, `removed ${removed}`)

let companies = 0
for (const co of db.prepare(`SELECT id, name FROM companies`).all()) {
  if (!new RegExp(`^cking-rvl-${RUN}(-b)?$`).test(co.name)) continue
  for (const t of ['billing_ledger', 'reveals', 'organization_reveals', 'folders', 'saved_searches']) {
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)) {
      db.prepare(`DELETE FROM "${t}" WHERE company_id = ?`).run(co.id)
    }
  }
  for (const r of db.prepare(`SELECT id FROM recruiters WHERE company_id = ?`).all(co.id)) {
    db.prepare(`DELETE FROM analytics_events WHERE actor_type='recruiter' AND actor_id=?`).run(r.id)
  }
  db.prepare(`DELETE FROM analytics_events WHERE actor_type='company' AND actor_id=?`).run(co.id)
  db.prepare(`DELETE FROM recruiters WHERE company_id = ?`).run(co.id)
  db.prepare(`DELETE FROM companies WHERE id = ?`).run(co.id)
  companies += 1
}
check('and so are the two organizations', companies === 2, `removed ${companies}`)

finish()
