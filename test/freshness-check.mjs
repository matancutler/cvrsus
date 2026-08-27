/**
 * The candidate freshness lifecycle, and the recruiter's free way to ask.
 *
 * What this is really protecting is that there is ONE clock. The reminder
 * schedule, the Green/Orange badge, the automatic hide and every availability
 * check all read the same derived value, and the failure this replaces is the
 * old system's two independent timestamps that never informed each other — a
 * candidate signing in every week while a counter of unanswered emails quietly
 * marched them towards being hidden.
 *
 * The other thing under test is idempotence. The sweep runs on every server
 * boot as well as on a daily timer, so "did I already send this" cannot be
 * inferred from the date. Several checks below run the sweep twice on purpose.
 *
 * Time is moved by backdating the candidate's own activity columns rather than
 * by faking a clock: the code under test derives everything from those columns,
 * so moving them is the honest way to be on day 44.
 */
import db from '../server/src/db.js'
import {
  activityStatus,
  candidatesDueReminder,
  daysInactive,
  hideStaleProfiles,
  lastActivityAt,
  markCandidateSeen,
  confirmActive,
  recordReminderSent,
  reminderStageFor,
} from '../server/src/profiles.js'
import {
  alreadyAsked,
  checkableState,
  expireAvailabilityChecks,
  requestAvailabilityCheck,
  resolveAvailabilityChecks,
  availabilityStates,
} from '../server/src/availability.js'
import { runCheckinSweep } from '../server/src/checkins.js'
import { createReporter } from './helpers.mjs'

const { section, check, finish } = createReporter('Candidate freshness')
const RUN = Date.now().toString(36)
const MARK = `cking-fresh-${RUN}`

/* ------------------------------------------------------------ fixtures --- */

let seq = 0
function makeCandidate({ days = 0 } = {}) {
  seq += 1
  const created = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  return db.prepare(`
    INSERT INTO candidates (name, first_name, last_name, email, phone, location,
                            created_at, file_name, stored_name)
    VALUES (?, 'Quiet', 'Person', ?, '052-000-0000', 'Tel Aviv', ?, 'cv.pdf', ?)
  `).run(`Quiet Person ${seq}`, `q${seq}@${MARK}.example.com`, created, `${MARK}-${seq}.pdf`)
    .lastInsertRowid
}

const load = (id) => db.prepare(`SELECT * FROM candidates WHERE id = ?`).get(id)

/** Move a candidate's whole clock back, as if the silence started `days` ago. */
function backdate(id, days) {
  const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  db.prepare(`
    UPDATE candidates SET created_at = ?, last_seen_at = NULL, last_confirmed_active = ?
    WHERE id = ?
  `).run(at, at, id)
}

/* -------------------------------------------------------------- the clock --- */

section('One clock, from the latest thing that happened')

const fresh = makeCandidate()
check('a new account starts at day 0', daysInactive(load(fresh)) === 0)
check('and reads as green', activityStatus(load(fresh)).state === 'green')

backdate(fresh, 45)
check('backdating moves it', daysInactive(load(fresh)) === 45)

/* The whole point of max() over coalesce: a candidate can have confirmed in
   March and signed in last week, and the clock follows the later one. */
markCandidateSeen(fresh)
check('signing in resets the clock', daysInactive(load(fresh)) === 0,
  'the old model recorded logins and deliberately ignored them')
check('and the latest signal wins over the older one',
  new Date(lastActivityAt(load(fresh))).getTime() > Date.now() - 60_000)

backdate(fresh, 45)
confirmActive(fresh)
check('answering yes resets it too', daysInactive(load(fresh)) === 0)

/* ------------------------------------------------------------- the states --- */

section('Green, Orange, hidden')

const at29 = makeCandidate({ days: 29 })
backdate(at29, 29)
check('29 days is still green', activityStatus(load(at29)).state === 'green')

const at30 = makeCandidate()
backdate(at30, 30)
const orange = activityStatus(load(at30))
check('30 days is orange', orange.state === 'orange', orange.state)
check('and it says how long, not that they are gone',
  orange.label === 'No activity for 30 days', orange.label)
check('an orange candidate is still visible to recruiters',
  orange.visibleToRecruiters === true,
  'orange is uncertainty, not removal — the recruiter decides')
check('and is told how long is left', orange.daysUntilHidden === 30)

check('no label promises availability',
  !/guarantee|available now|will respond/i.test(
    [activityStatus(load(at29)).label, orange.label].join(' ')))

/* ------------------------------------------------------- the five emails --- */

section('The reminder sequence fires once per stage')

for (const [days, stage, remaining] of [[30, 30, 30], [37, 37, 23], [44, 44, 16], [51, 51, 9], [58, 58, 2]]) {
  check(`day ${days} is stage ${stage}`, reminderStageFor(days) === stage)
  const subject = makeCandidate()
  backdate(subject, days)
  const [due] = candidatesDueReminder().filter((row) => row.id === subject)
  check(`  and it counts down to ${remaining}`, due?.daysRemaining === remaining,
    `${due?.daysRemaining}`)
  db.prepare(`DELETE FROM candidates WHERE id = ?`).run(subject)
}

const seq1 = makeCandidate()
backdate(seq1, 30)
check('a candidate at day 30 is due', candidatesDueReminder().some((r) => r.id === seq1))

recordReminderSent(seq1, 30)
check('and is not due again once sent', !candidatesDueReminder().some((r) => r.id === seq1),
  'the sweep runs on every boot; the date alone cannot answer this')

backdate(seq1, 37)
db.prepare(`UPDATE candidates SET freshness_stage_sent = 30 WHERE id = ?`).run(seq1)
check('but is due again at the next stage', candidatesDueReminder().some((r) => r.id === seq1))

/* A server down for a fortnight must not send four emails at once. */
const skipped = makeCandidate()
backdate(skipped, 51)
const jumped = candidatesDueReminder().filter((r) => r.id === skipped)
check('a long outage produces one reminder, not four', jumped.length === 1)
check('and it carries the countdown for today, not for the one that was missed',
  jumped[0].stage === 51 && jumped[0].daysRemaining === 9,
  `stage ${jumped[0]?.stage}, ${jumped[0]?.daysRemaining} days`)

/* Signing in mid-sequence has to clear the stage, or the candidate runs
   silently to 60 with no further email ever being due. */
const returned = makeCandidate()
backdate(returned, 51)
db.prepare(`UPDATE candidates SET freshness_stage_sent = 51 WHERE id = ?`).run(returned)
markCandidateSeen(returned)
check('signing in clears the stage already sent',
  load(returned).freshness_stage_sent === 0)
backdate(returned, 30)
check('so the sequence starts again from the top',
  candidatesDueReminder().some((r) => r.id === returned && r.stage === 30))

/* ------------------------------------------------------------- day sixty --- */

section('Sixty days hides the profile')

const stale = makeCandidate()
backdate(stale, 59)
check('59 days is not yet hidden', hideStaleProfiles().hidden.every((c) => c.id !== stale))

backdate(stale, 60)
const swept = hideStaleProfiles()
check('60 days is', swept.hidden.some((c) => c.id === stale))
const after = load(stale)
check('and it is recorded as silence, not as a decision',
  after.hidden_from_search === 1 && after.auto_hidden_at && after.deactivated_at === null,
  'both hide the profile; only one of them is something the candidate said')
check('the status says so in those terms',
  activityStatus(after).label === 'Hidden — no activity in 60 days',
  activityStatus(after).label)
check('and they are out of search', activityStatus(after).visibleToRecruiters === false)

check('a second pass hides nobody again', hideStaleProfiles().hidden.length === 0,
  'the notification fires on the crossing, not on the state')

/* ------------------------------------------------- check availability --- */

section('Check Availability is for Orange candidates only')

const green = makeCandidate()
check('a green candidate cannot be asked', checkableState(load(green)).ok === false)
check('and the refusal names why', checkableState(load(green)).reason === 'green')
check('a hidden one cannot either', checkableState(load(stale)).ok === false)

const asked = makeCandidate()
backdate(asked, 35)
check('an orange one can', checkableState(load(asked)).ok === true)

const first = requestAvailabilityCheck({ recruiterId: 90001, companyId: 90001, candidateId: asked })
check('the first request is created', first.created === true)
check('and it asks the candidate', first.ask === true)

const again = requestAvailabilityCheck({ recruiterId: 90001, companyId: 90001, candidateId: asked })
check('the same recruiter asking twice makes one row', again.created === false,
  'enforced by a partial unique index, not by a read-then-write two clicks can race')

const second = requestAvailabilityCheck({ recruiterId: 90002, companyId: 90002, candidateId: asked })
check('a second recruiter gets their own row', second.created === true)
check('but the candidate is not emailed twice', second.ask === false,
  'one question, however many people are waiting on the answer')
check('and the candidate is known to have been asked', alreadyAsked(asked) === true)

section('One answer settles everyone waiting')

const resolved = resolveAvailabilityChecks(asked, 'yes')
check('both recruiters are resolved by one yes', resolved.length === 2, `${resolved.length}`)
check('and nothing is left pending',
  availabilityStates(90001).pending.length === 0
  && availabilityStates(90002).pending.length === 0)
check('both see the candidate as available',
  availabilityStates(90001).available.some((r) => r.candidate_id === asked)
  && availabilityStates(90002).available.some((r) => r.candidate_id === asked))

/* The recruiter's request is not the candidate's activity. */
const untouched = makeCandidate()
backdate(untouched, 40)
const before = daysInactive(load(untouched))
requestAvailabilityCheck({ recruiterId: 90003, companyId: 90003, candidateId: untouched })
check('asking does not touch the candidate’s clock', daysInactive(load(untouched)) === before,
  'a recruiter clicking is recruiter activity')

confirmActive(untouched)
check('but the candidate answering yes does', daysInactive(load(untouched)) === 0)

section('A question nobody answers lapses after 14 days')

const lapsing = makeCandidate()
backdate(lapsing, 40)
requestAvailabilityCheck({ recruiterId: 90004, companyId: 90004, candidateId: lapsing })
check('it is pending to begin with', availabilityStates(90004).pending.length === 1)

db.prepare(`
  UPDATE availability_checks SET expires_at = ? WHERE recruiter_id = 90004
`).run(new Date(Date.now() - 1000).toISOString())
const expired = expireAvailabilityChecks()
check('the sweep expires it', expired >= 1)
check('and it leaves the recruiter’s pending list', availabilityStates(90004).pending.length === 0)
check('without becoming a positive result',
  availabilityStates(90004).available.every((r) => r.candidate_id !== lapsing))
check('and without touching the candidate’s own lifecycle',
  activityStatus(load(lapsing)).state === 'orange',
  'the 60-day clock runs independently of anybody asking about them')

/* ----------------------------------------------------------- the sweep --- */

section('The whole sweep, twice')

const sweepSubject = makeCandidate()
backdate(sweepSubject, 30)
const pass1 = await runCheckinSweep({ quiet: true })
check('the first pass sends', pass1.sent >= 1, `${pass1.sent}`)
const pass2 = await runCheckinSweep({ quiet: true })
check('the second sends nothing', pass2.sent === 0, `${pass2.sent}`)
check('and hides nobody twice', pass2.hidden === 0)

/* ------------------------------------------------------------ cleanup --- */

section('Cleanup')

const mine = db.prepare(`SELECT id, email FROM candidates WHERE email LIKE ?`).all(`%@${MARK}.example.com`)
for (const row of mine) {
  if (!row.email.endsWith(`@${MARK}.example.com`)) throw new Error(`refusing ${row.id}`)
  db.prepare(`DELETE FROM availability_checks WHERE candidate_id = ?`).run(row.id)
  db.prepare(`DELETE FROM freshness_checkins WHERE candidate_id = ?`).run(row.id)
  db.prepare(`DELETE FROM analytics_events WHERE actor_type = 'candidate' AND actor_id = ?`).run(row.id)
  db.prepare(`DELETE FROM candidates WHERE id = ?`).run(row.id)
}
/* The synthetic recruiter ids this file invented, which belong to nobody. */
db.prepare(`DELETE FROM availability_checks WHERE recruiter_id BETWEEN 90001 AND 90004`).run()
check('test data removed', true, `${mine.length} candidate(s)`)

finish()
