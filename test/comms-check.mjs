/**
 * Automated communications: the rules, not the wording.
 *
 * Most of this brief is copy, and copy is reviewed by reading it. What can
 * actually be wrong is the *when* — and every rule in the document is a rule
 * about not sending: once per decision, only on the transition to zero, only
 * the first search, only the automatic hide. Those are what this checks.
 *
 * Email and Slack both go to the console here, because no provider is wired.
 * That is a delivery gap and not a logic one: the functions are called with the
 * right arguments at the right moments, which is the part that would still be
 * wrong after a mailer is plugged in.
 */
import fs from 'node:fs'

import db from '../server/src/db.js'
import { approveCompany, declineCompany } from '../server/src/accounts.js'
import { activityStatus, hideStaleProfiles } from '../server/src/profiles.js'
import {
  sendCandidateWelcome,
  sendRecruiterApproved,
  sendRecruiterDeclined,
  sendRecruiterUnderReview,
} from '../server/src/notify.js'
import { createReporter } from './helpers.mjs'

const { section, check, finish } = createReporter('Automated communications')
const RUN = Date.now().toString(36)
const MARK = `cking-comms-${RUN}`

/* ------------------------------------------------------------ fixtures --- */

let seq = 0
function makeCompany(name, status = 'pending') {
  seq += 1
  const now = new Date().toISOString()
  return db.prepare(`
    INSERT INTO companies (name, join_key, created_at, approval_status)
    VALUES (?, ?, ?, ?)
  `).run(`${MARK}-${name}`, `${MARK}-${seq}`.toUpperCase(), now, status).lastInsertRowid
}

function makeAdmin(companyId, first = 'Ada') {
  seq += 1
  return db.prepare(`
    INSERT INTO recruiters (company_id, username, first_name, last_name, email,
                            is_org_admin, is_active, created_at, password_hash)
    VALUES (?, ?, ?, 'Admin', ?, 1, 1, ?, 'x')
  `).run(companyId, `${MARK}.${seq}`.toLowerCase(), first,
    `${first}.${seq}@${MARK}.example.com`.toLowerCase(), new Date().toISOString()).lastInsertRowid
}

/* ------------------------------------------------------- what they say --- */

section('The templates say what the brief says')

const welcome = await sendCandidateWelcome({ to: 'a@b.example.com', name: 'Ada' })
check('the candidate welcome is the welcome', welcome.subject === 'Welcome to Cursus', welcome.subject)
check('and tells them they do not have to apply',
  /don't need to search or apply/.test(welcome.body),
  'the whole proposition, in the first email they get')

const review = await sendRecruiterUnderReview({ to: 'a@b.example.com', name: 'Ada' })
check('a new recruiter is told they are being reviewed',
  review.subject === 'Your Cursus account is being reviewed', review.subject)
check('and is promised the key rather than given it',
  /company key/.test(review.body) && !/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(review.body),
  'the key is the credential; it does not go out before approval')

const approved = await sendRecruiterApproved({
  to: 'a@b.example.com', name: 'Ada', companyName: 'Acme', companyKey: 'AAAA-BBBB-CCCC',
})
check('approval carries the key', /AAAA-BBBB-CCCC/.test(approved.body))
check('and says it belongs to the company, not the person',
  /covers every account created under Acme/.test(approved.body))
check('and that it is a password',
  /Treat it like a password/.test(approved.body))

const declined = await sendRecruiterDeclined({ to: 'a@b.example.com', name: 'Ada' })
check('a refusal asks them to get in touch',
  /cvrsvs\.com\/contact/.test(declined.body))
check('and gives no reason in the email',
  !/because|reason|unverified|fraud/i.test(declined.body),
  'the specifics belong in the support conversation, not in a template')

/* ------------------------------------------------------ once, and once --- */

section('A review decision is announced once')

const pending = makeCompany('approve-once')
makeAdmin(pending)

let before = db.prepare(
  `SELECT COUNT(*) n FROM analytics_events WHERE name = 'recruiter_approved' AND actor_id = ?`,
).get(pending).n
approveCompany(pending, { reviewedBy: 'a tester' })
approveCompany(pending, { reviewedBy: 'a tester' })
const approvals = db.prepare(
  `SELECT COUNT(*) n FROM analytics_events WHERE name = 'recruiter_approved' AND actor_id = ?`,
).get(pending).n
check('approving twice is one approval', approvals - before === 1, `${approvals - before}`)

const refused = makeCompany('decline-once')
makeAdmin(refused)
declineCompany(refused, 'could not verify', { reviewedBy: 'a tester' })
declineCompany(refused, 'still could not verify', { reviewedBy: 'a tester' })
const refusals = db.prepare(
  `SELECT COUNT(*) n FROM analytics_events WHERE name = 'recruiter_declined' AND actor_id = ?`,
).get(refused).n
check('and declining twice is one decision', refusals === 1, `${refusals}`)
/* The second call still records the fuller reason — an operator adding detail
   to a decision already made — it simply does not announce it again. The email
   never carried the reason either way. */
check('a reason added afterwards is kept',
  db.prepare(`SELECT declined_reason FROM companies WHERE id = ?`).get(refused).declined_reason
    === 'still could not verify',
  'recording more about a refusal is not a second refusal')

section('Approving a declined company is the undo, and says so again')

approveCompany(refused, { reviewedBy: 'a tester' })
check('the reversal is its own decision',
  db.prepare(
    `SELECT COUNT(*) n FROM analytics_events WHERE name = 'recruiter_approved' AND actor_id = ?`,
  ).get(refused).n === 1,
  'declined then approved is two decisions and two emails, which is right')

/* ------------------------------------------------- sixty days of quiet --- */

section('Sixty days of silence hides the profile')

/*
 * Driven by the clock, not by counting unanswered emails.
 *
 * The old rule hid somebody after two expired check-in tokens, which meant a
 * candidate whose email bounced could be hidden while one who never received a
 * check-in stayed visible forever — the same silence producing opposite
 * outcomes depending on what our mail server managed. Now the only question is
 * how long it has been since the candidate did anything.
 */
const quietAt = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

const candidateId = db.prepare(`
  INSERT INTO candidates (name, first_name, last_name, email, phone, location, created_at,
                          file_name, stored_name, hidden_from_search)
  VALUES ('Quiet Person', 'Quiet', 'Person', ?, '052-000-0000', 'Tel Aviv', ?,
          'cv.pdf', ?, 0)
`).run(`quiet@${MARK}.example.com`, quietAt(59), `${MARK}.pdf`).lastInsertRowid

const clockAt = (days) => db.prepare(`
  UPDATE candidates SET created_at = ?, last_seen_at = NULL, last_confirmed_active = NULL
  WHERE id = ?
`).run(quietAt(days), candidateId)

let result = hideStaleProfiles()
check('fifty-nine days does not hide anybody',
  db.prepare(`SELECT hidden_from_search FROM candidates WHERE id = ?`).get(candidateId)
    .hidden_from_search === 0,
  'the candidate is Orange and still findable — the recruiter decides')
check('and nobody is reported as hidden', (result.hidden ?? []).length === 0)

clockAt(60)
result = hideStaleProfiles()
const after = db.prepare(
  `SELECT hidden_from_search, auto_hidden_at, deactivated_at FROM candidates WHERE id = ?`,
).get(candidateId)
check('sixty does', after.hidden_from_search === 1, JSON.stringify(after))
check('and it is recorded as having gone quiet, not as a decision',
  Boolean(after.auto_hidden_at) && after.deactivated_at === null,
  'both hide the profile; only one of them is something the candidate said')
check('the sweep reports who it hid, so they can be written to',
  (result.hidden ?? []).some((row) => row.id === candidateId))
check('and the status says silence rather than refusal',
  activityStatus(db.prepare(`SELECT * FROM candidates WHERE id = ?`).get(candidateId)).state
    === 'hidden')

result = hideStaleProfiles()
check('a later pass hides nobody again',
  (result.hidden ?? []).length === 0,
  'already hidden — the notification fires on the crossing, not on the state')

/* ----------------------------------------------------------- the split --- */

section('What Slack is not told')

const source = fs.readFileSync(new URL('../server/src/index.js', import.meta.url), 'utf8')
for (const [what, pattern] of [
  ['every search', /track\('search_run'/],
  ['every reveal', /track\('candidate_revealed'/],
  ['every reply', /track\('candidate_replied'/],
]) {
  check(`${what} is tracked`, pattern.test(source))
}
check('but a search only reaches Slack the first time',
  /activatedOnce\('recruiter_first_search'/.test(source)
  && !/notifySlack\('New search/.test(source),
  'a channel that reports every search is a channel nobody reads')
check('and a reply never does',
  !/notifySlack\([^)]*[Rr]epl/.test(source),
  'ordinary product traffic belongs in analytics')

const sweepSource = fs.readFileSync(new URL('../server/src/checkins.js', import.meta.url), 'utf8')
check('a candidate hiding themselves is not announced internally',
  /Candidate automatically hidden/.test(sweepSource)
  && !/notifySlack\([^)]*manually/i.test(sweepSource),
  'using a control the product offers is not an event to report on somebody')

/* ------------------------------------------------------------ cleanup --- */

section('Cleanup')

db.prepare(`DELETE FROM freshness_checkins WHERE candidate_id = ?`).run(candidateId)
const mine = db.prepare(`SELECT id, email FROM candidates WHERE email = ?`)
  .get(`quiet@${MARK}.example.com`)
if (mine) db.prepare(`DELETE FROM candidates WHERE id = ?`).run(mine.id)

for (const row of db.prepare(`SELECT id, name FROM companies WHERE name LIKE ?`).all(`${MARK}-%`)) {
  if (!row.name.startsWith(MARK)) throw new Error(`refusing to remove ${row.id}: not this run's`)
  db.prepare(`DELETE FROM recruiters WHERE company_id = ?`).run(row.id)
  db.prepare(`DELETE FROM analytics_events WHERE actor_id = ? AND actor_type = 'company'`).run(row.id)
  db.prepare(`DELETE FROM companies WHERE id = ?`).run(row.id)
}
check('test data removed', true)

finish()
