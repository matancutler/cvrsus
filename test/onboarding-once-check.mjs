/**
 * The questions a CV cannot answer are asked once, and then never again.
 *
 * They used to be driven by `location.state.onboarding`, set by the redirect
 * out of signup. That is the right idea — it is a fact about the arrival rather
 * than about the account — and the wrong mechanism: history.state survives a
 * reload, so refreshing the profile page brought the dialog back, and so did
 * any tab the browser restored. Candidates were re-asked for answers they had
 * already given.
 *
 * The account records having been asked, which a reload cannot undo. These
 * checks go through the API the portal uses, because the bug was never in the
 * dialog — it was in what the page believed on load.
 */
import { BASE, contactProofs, createReporter, json, makePdf } from './helpers.mjs'

const { check, section, finish } = createReporter()

const RUN = Date.now().toString(36)
const MARKER = `@cking-onboard-${RUN}.example.com`

const email = `ada.${RUN}${MARKER}`
const phone = `052-${Math.floor(1000000 + Math.random() * 8999999)}`

const form = new FormData()
form.append('cv', new Blob([await makePdf([
  'Ada Onboard', 'Operations analyst - Tel Aviv',
  'ANALYST, SomeCo 2020 - present', '  Reviewed transactions and reported daily.',
  'SKILLS: Excel, SQL',
])], { type: 'application/pdf' }), 'cv.pdf')
for (const [k, v] of Object.entries({
  firstName: 'Ada', lastName: 'Onboard', email, phone,
  location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
})) form.append(k, v)
for (const [k, v] of Object.entries(await contactProofs({ email, phone }))) form.append(k, v)
form.append('consent', 'true')

const created = await json(await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form }))

const code = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: email }),
}))
const { token } = await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ identifier: email, code: code.devCode }),
}))

/* What the portal asks on every load. The bug lived in this answer. */
async function me() {
  return json(await fetch(`${BASE}/api/candidate/me`, {
    headers: { authorization: `Bearer ${token}` },
  }))
}

const stamp = () => fetch(`${BASE}/api/candidate/me/onboarded`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: '{}',
})

section('A new candidate is asked')
check('a brand new account needs onboarding', (await me()).needsOnboarding === true)

section('A reload before answering does not skip the question')
check('still asked', (await me()).needsOnboarding === true,
  'the dialog must survive a refresh that happens BEFORE it is answered')

section('Answering it is remembered')
check('the account accepts the answer', (await stamp()).status === 200)
check('and is not asked again', (await me()).needsOnboarding === false)

section('Nor on any later load — the whole complaint')
check('a later load still says answered', (await me()).needsOnboarding === false,
  'this is what a refresh and a fresh sign-in both look like to the server')

section('Recording it twice does not move the date')
const { default: Database } = await import('better-sqlite3')
const db = new Database(new URL('../server/data/cking.db', import.meta.url).pathname.slice(1))
const read = () => db.prepare('SELECT onboarded_at FROM candidates WHERE id = ?').get(created.id)?.onboarded_at

const first = read()
await stamp()
check('the first stamp is the one kept', first === read(),
  `${first} then ${read()} — a retry must not make an old account look new`)

section('Everyone who already had an account keeps it')
/*
 * Scoped to accounts that predate this run.
 *
 * The backfill stamps what exists when the server boots; a candidate created
 * after that is new and SHOULD be unstamped, which is the whole point. Another
 * suite's fixture sitting in the database would otherwise fail this check for
 * behaving correctly, so the question is asked only of rows old enough to have
 * been there for the migration.
 */
const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
const older = db.prepare(
  `SELECT COUNT(*) n FROM candidates WHERE onboarded_at IS NULL AND created_at < ?`,
).get(cutoff).n
check('no pre-existing candidate is left unstamped', older === 0,
  `${older} would meet the dialog again on their next sign-in`)

section('Cleanup')
const { deleteCandidateCompletely } = await import('../server/src/profiles.js')
/* It returns the stored filenames precisely so the caller unlinks them — the
   rows go first so a failure here can never leave a live row pointing at a
   file that is gone. Leaving them behind makes api.test's orphan sweep fail on
   this suite's litter. */
const { unlinkSync, existsSync } = await import('node:fs')
const orphaned = deleteCandidateCompletely(created.id)
for (const name of orphaned) {
  const path = new URL(`../server/uploads/${name}`, import.meta.url).pathname.slice(1)
  if (existsSync(path)) unlinkSync(path)
}
check('test candidate removed', !db.prepare('SELECT id FROM candidates WHERE id = ?').get(created.id))
check('and the CV it uploaded is off disk', orphaned.every((name) => (
  !existsSync(new URL(`../server/uploads/${name}`, import.meta.url).pathname.slice(1))
)), `${orphaned.length} file(s)`)
db.close()

finish()
