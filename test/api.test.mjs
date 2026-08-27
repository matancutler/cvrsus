/**
 * End-to-end API tests. Requires the server to be running:
 *
 *   npm run dev:server     (in another terminal)
 *   npm run test:api
 *
 * Test candidates are deleted at the end, so the suite is safe to re-run.
 */
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import {
  BASE, approveCompanyById, contactProofs, createReporter, json, makePdf, makePng,
  proveContact, registerAndSignIn, registerCompany, serverEnv,
} from './helpers.mjs'

const { check, section, finish } = createReporter()
const env = serverEnv()

/*
 * Audit §15 removed the company sign-up secret, so there is nothing to pass in
 * and no argument to read. Registration is open; what a new company may DO is
 * the gate, and these tests approve their own companies to get past it.
 */

const MARKER = '@cking-test.example.com'
const RUN = Date.now().toString(36)

/*
 * Phone numbers per run, like the emails.
 *
 * They were fixed strings, which was fine while a number identified nobody.
 * The apply route resolves an identity by phone as well as by email now and
 * refuses a second account for either, so a run whose cleanup did not happen
 * left a number that poisoned every run after it. The tails stay readable so
 * the fixtures are still told apart at a glance — and 9999 is still reused
 * deliberately below, which is the point of that check.
 */
const PHONE_RUN = String(Date.now()).slice(-6, -3)
const phoneFor = (tail) => `052-${PHONE_RUN}-${tail}`


const CV_LINES = [
  'Dana Reyes',
  'Senior Frontend Engineer - Tel Aviv-Yafo',
  'SUMMARY',
  'Senior frontend engineer with 8 years of experience building large React',
  'applications in TypeScript. Led a team of four and mentored two juniors.',
  'EXPERIENCE',
  'Senior Frontend Engineer, Volt Analytics - Mar 2019 - Present',
  'Rebuilt the customer dashboard in React and TypeScript.',
  'Introduced Next.js for server rendering and moved styling to Tailwind CSS.',
  'Frontend Developer, Kestrel Media - Jan 2017 - Feb 2019',
  'Built responsive interfaces with JavaScript, HTML, CSS and Sass.',
  'Improved accessibility to meet WCAG 2.1 AA.',
  'SKILLS',
  'React, TypeScript, JavaScript, Next.js, GraphQL, CSS, Sass, Git, mentoring',
]

const OTHER_CV_LINES = [
  'Sam Chidi Okafor',
  'Data Engineer - Haifa',
  'Data engineer with 5 years of experience building batch and streaming pipelines.',
  'Data Engineer, Harmattan Logistics - Jun 2020 - Present',
  'Built ETL pipelines in Python using Airflow, Spark and dbt on AWS.',
  'SKILLS',
  'Python, SQL, PostgreSQL, Airflow, Spark, AWS, Docker, Pandas, ETL',
]

const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})

async function apply(fields, lines = CV_LINES, { withPhoto = false, verify = true } = {}) {
  const form = new FormData()
  form.append('cv', new Blob([await makePdf(lines)], { type: 'application/pdf' }), 'cv.pdf')
  if (withPhoto) form.append('photo', new Blob([makePng()], { type: 'image/png' }), 'me.png')
  // City is required now; both contact details are proved before an account
  // exists, so the tests walk the same round trip a person does.
  if (!('location' in fields)) form.append('location', 'Tel Aviv')
  if (verify && fields.email && fields.phone) {
    const proofs = await contactProofs(fields)
    for (const [key, value] of Object.entries(proofs)) form.append(key, value)
  }
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  // The 18+ affirmation and agreement the form now sends and the route now requires.
  if (!form.has('consent')) form.append('consent', 'true')
  return fetch(`${BASE}/api/candidates`, { method: 'POST', body: form })
}

// ------------------------------------------------------------------ health ---

section('Health')
let health
try {
  health = await json(await fetch(`${BASE}/api/health`))
} catch {
  console.error(`\nCould not reach ${BASE}. Start it with: npm run dev:server\n`)
  process.exit(1)
}
check('server responds', health.ok === true,
  `${health.candidates} candidates, ${health.companies} companies`)

// ---------------------------------------------------- company (parent account) ---

section('Company account')

check('a company with no administrator name is rejected',
  (await registerCompany({ companyName: `Acme Hiring ${RUN}`, lastName: '' })).status === 400)
/*
 * Registration is rate limited to ten an hour per connection, and each of these
 * negatives spends one — so the failure cases are chosen to cover the most
 * ground per request rather than exhaustively. "short" breaks three of §17's
 * four rules at once; the fourth gets its own check because it is the one a
 * plausible-looking password still misses.
 */
check('a weak administrator password is rejected',
  (await registerCompany({
    companyName: `Acme Hiring ${RUN}`, password: 'short', confirmPassword: 'short',
  })).status === 400)
check('a password with no special character is rejected',
  (await registerCompany({
    companyName: `Acme Hiring ${RUN}`, password: 'Longenough1', confirmPassword: 'Longenough1',
  })).status === 400)
check('a mismatched confirmation is rejected',
  (await registerCompany({
    companyName: `Acme Hiring ${RUN}`, confirmPassword: 'Different1!',
  })).status === 400)

// §17 — email, phone and website are all mandatory now.
check('a missing administrator email is rejected',
  (await registerCompany({ companyName: `Acme Hiring ${RUN}`, email: '' })).status === 400)
check('a website that is not an address is rejected',
  (await registerCompany({ companyName: `Acme Hiring ${RUN}`, website: 'not a website' })).status === 400)

const acme = await registerAndSignIn({ companyName: `Acme Hiring ${RUN}` })
const company = acme.company
const maya = { token: acme.token, recruiter: acme.recruiter }
check('company registers and gets a join key', Boolean(company.joinKey), company.joinKey)
check('join key is formatted in readable blocks', /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(company.joinKey))
check('the administrator account is created with it', maya.recruiter.username === 'maya.cohen',
  maya.recruiter.username)
// Via registerAndSignIn, which reads the key from the database the way an
// operator hands it over. Registration itself no longer returns either — see
// the block below.
check('signing in with the company key works', typeof maya.token === 'string')
check('the administrator holds the admin flag', maya.recruiter.isOrgAdmin === true)

/*
 * Registering does not sign anyone in, and does not hand over the company key.
 *
 * The key is the credential every recruiter at the company signs in with, so
 * returning it at registration would make the review a formality behind a door
 * that was already open. This registers a throwaway company and inspects the
 * raw response, because that is the only place the omission is observable.
 */
{
  const raw = await registerCompany({
    companyName: `NoSession ${RUN}`, email: `nosession.${RUN}@example.com`,
  })
  const body = await raw.json()

  check('registering returns no session token', body.token === undefined)
  check('and sets no session cookie',
    !(raw.headers.getSetCookie() ?? []).some((c) => c.startsWith('cvrsus_session')))
  check('and does not hand over the company key',
    !/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/.test(JSON.stringify(body)),
    'it is released by whoever approves the company')
  check('it says the account is in review', body.status === 'in-review')
  check('and echoes back where the answer will go',
    body.contact?.email === `nosession.${RUN}@example.com` && Boolean(body.contact?.phone))
}

/*
 * §15 — the gate that replaced the sign-up secret. A company that has just
 * registered reaches no candidate until it is approved, so this is checked
 * BEFORE approving and everything downstream runs after.
 */
check('a new company starts pending approval', acme.company.approvalStatus === 'pending')
check('a pending company cannot list candidates',
  (await fetch(`${BASE}/api/hr/candidates`, { headers: jsonHeaders(maya.token) })).status === 403)
check('a pending company cannot search',
  (await fetch(`${BASE}/api/hr/search`, {
    method: 'POST', headers: jsonHeaders(maya.token), body: JSON.stringify({ prompt: 'anyone' }),
  })).status === 403)

/*
 * The gate opens for 'approved' and nothing else.
 *
 * It used to test `=== 'pending'`, which meant every other value — a decline, a
 * typo, a state added later — granted full access to candidate profiles. This
 * writes a status the code has never heard of, because that is the case a
 * fail-open gate gets wrong and a fail-closed one gets right.
 */
{
  const { default: db } = await import('../server/src/db.js')
  const restore = db.prepare(`SELECT approval_status FROM companies WHERE id = ?`)
    .get(company.id).approval_status

  db.prepare(`UPDATE companies SET approval_status = 'something-new' WHERE id = ?`).run(company.id)
  check('an unrecognised approval status refuses rather than admits',
    (await fetch(`${BASE}/api/hr/candidates`, { headers: jsonHeaders(maya.token) })).status === 403,
    'the gate must open for "approved" alone')

  const { declineCompany } = await import('../server/src/accounts.js')
  declineCompany(company.id, 'test run')
  const declined = await fetch(`${BASE}/api/hr/candidates`, { headers: jsonHeaders(maya.token) })
  check('a declined company reaches no candidate', declined.status === 403)
  check('and is told it was refused, not that it is still waiting',
    /has not been approved to use Cursus/.test((await declined.json()).error ?? ''))
  check('the decline is recorded rather than the company deleted',
    db.prepare(`SELECT declined_reason FROM companies WHERE id = ?`).get(company.id)
      .declined_reason === 'test run')

  db.prepare(`UPDATE companies SET approval_status = ? WHERE id = ?`).run(restore, company.id)
}

await approveCompanyById(company.id)
check('approving clears a decline',
  (await import('../server/src/db.js')).default
    .prepare(`SELECT approval_status FROM companies WHERE id = ?`).get(company.id)
    .approval_status === 'approved')
check('an approved company can list candidates',
  (await fetch(`${BASE}/api/hr/candidates`, { headers: jsonHeaders(maya.token) })).status === 200)

const rival = await registerAndSignIn({
  companyName: `Rival Corp ${RUN}`, email: 'ron@rival.example.com',
})
const second = rival.company
await approveCompanyById(second.id)
check('a second company gets a different key', second.joinKey !== company.joinKey)

// ------------------------------------------------ recruiters (subsidiary accounts) ---

section('Recruiter accounts')

/** Only an administrator can create an account, and only in their own company. */
async function addRecruiter(token, body) {
  const form = new FormData()
  for (const [key, value] of Object.entries({
    password: 'Longenough1!', confirmPassword: 'Longenough1!', ...body,
  })) form.append(key, value)

  return fetch(`${BASE}/api/recruiter`, {
    method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: form,
  })
}

check('self-service registration no longer exists',
  (await fetch(`${BASE}/api/recruiter/register`, {
    method: 'POST', headers: jsonHeaders(),
    body: JSON.stringify({ joinKey: company.joinKey, firstName: 'Ghost', lastName: 'User' }),
  })).status === 404)
check('creating an account needs a session',
  (await addRecruiter(null, { firstName: 'Ghost', lastName: 'User' })).status === 401)

/*
 * Pricing §14.1 — the one included seat is the administrator's own, so every
 * colleague below needs capacity bought first.
 */
/* Seats are a subscription now, so this sets the plan rather than adding to it:
   the argument is the total number of additional seats to be on. */
const buySeats = (token, seats) => fetch(`${BASE}/api/company/seat-plan`, {
  method: 'PUT', headers: jsonHeaders(token), body: JSON.stringify({ seats }),
})
const refused = await addRecruiter(maya.token, { firstName: 'Noa', lastName: 'Levi' })
check('the included seat is used up by the administrator', refused.status === 402,
  `HTTP ${refused.status}`)
check('and the refusal points at the Seats tab, not at reveals',
  /Seats tab/.test((await refused.json()).error ?? ''))

check('subscribing to two additional seats succeeds',
  (await buySeats(maya.token, 2)).status === 200)

// Name only — the starting password is derived, not supplied, so these are the
// only fields that can be wrong.
check('missing last name rejected',
  (await addRecruiter(maya.token, { firstName: 'Noa', lastName: '' })).status === 400)
check('missing first name rejected',
  (await addRecruiter(maya.token, { firstName: '', lastName: 'Levi' })).status === 400)

// The name cannot identify a person, so a duplicate must still produce a
// distinct login.
const mayaTwo = await json(await addRecruiter(maya.token, { firstName: 'Maya', lastName: 'Cohen' }))
check('duplicate name gets a distinct username', mayaTwo.created.username === 'maya.cohen2',
  mayaTwo.created.username)
check('the response carries what the administrator must pass on',
  mayaTwo.created.joinKey === company.joinKey
  && mayaTwo.created.name === 'Maya Cohen'
  // username123, so a deduped username carries its suffix into the password
  // rather than colliding with the first Maya Cohen's.
  && mayaTwo.created.password === 'maya.cohen2123',
  mayaTwo.created.password)

const noaCreated = await json(await addRecruiter(maya.token, { firstName: 'Noa', lastName: 'Levi' }))
check('a colleague is added to the same company', noaCreated.created.username === 'noa.levi',
  noaCreated.created.username)
check('the new account is not an administrator',
  noaCreated.colleagues.find((p) => p.id === noaCreated.created.id)?.is_org_admin === 0)

// Sign in as the colleague, since only the administrator gets a token directly.
// Their password is the one the creation call returned.
const signIn = async (joinKey, username, password) => (await json(await fetch(`${BASE}/api/recruiter/login`, {
  method: 'POST', headers: jsonHeaders(),
  body: JSON.stringify({ joinKey, username, password }),
}))).token
check('the starting password is derived from the name',
  noaCreated.created.password === 'noa.levi123', noaCreated.created.password)
const noa = {
  token: await signIn(company.joinKey, 'noa.levi', noaCreated.created.password),
  recruiter: { id: noaCreated.created.id },
}

check('a non-administrator cannot create accounts',
  (await addRecruiter(noa.token, { firstName: 'Ghost', lastName: 'User' })).status === 403)

/*
 * Pricing §11.4 — bought capacity runs out too, and the way past it is buying
 * more rather than being told to stop. Five accounts exist by now; the sixth is
 * refused until another seat is paid for.
 */
const overflow = await addRecruiter(maya.token, { firstName: 'Ori', lastName: 'Sixth' })
check('an account beyond the subscribed seats is refused',
  overflow.status === 402, `HTTP ${overflow.status}`)

/* Three, not "one more": the route takes the total to be on. */
check('raising the subscription succeeds', (await buySeats(maya.token, 3)).status === 200)
check('and then the account can be created',
  (await addRecruiter(maya.token, { firstName: 'Ori', lastName: 'Sixth' })).status === 201)

const outsider = { token: rival.token, recruiter: rival.recruiter }
check('same name in another company keeps the plain username',
  outsider.recruiter.username === 'maya.cohen')

section('Recruiter login')
async function login(body) {
  return fetch(`${BASE}/api/recruiter/login`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body),
  })
}
const creds = { joinKey: company.joinKey, username: 'maya.cohen', password: 'Longenough1!' }
check('wrong password rejected', (await login({ ...creds, password: 'wrong-password' })).status === 401)
check('unknown company key rejected',
  (await login({ ...creds, joinKey: 'ZZZZ-ZZZZ-ZZZZ' })).status === 401)
check('unknown username rejected', (await login({ ...creds, username: 'nobody.here' })).status === 401)
check('correct credentials sign in', (await login(creds)).status === 200)

// Both companies have a "maya.cohen" with the same password, so the company key
// is the only thing separating them. It must pick the right account.
const scopedA = await json(await login(creds))
const scopedB = await json(await login({ ...creds, joinKey: second.joinKey }))
check('the company key scopes which account signs in',
  scopedA.recruiter.id === maya.recruiter.id
  && scopedB.recruiter.id === outsider.recruiter.id
  && scopedA.recruiter.id !== scopedB.recruiter.id,
  `${scopedA.recruiter.company} vs ${scopedB.recruiter.company}`)

/*
 * The tokens from *those* sign-ins, not the ones held above.
 *
 * A recruiter account is signed in on one device at a time, so each login just
 * made is now the account's only live session and every token issued earlier is
 * dead. Nothing about that is incidental to this file: the section above exists
 * to sign these two in repeatedly, so carrying the older tokens forward would
 * be carrying sessions the product has deliberately ended.
 *
 * mayaToken is reassigned again by the password-reset section below.
 */
let mayaToken = scopedA.token
const noaToken = noa.token
const outsiderToken = scopedB.token

const me = await json(await fetch(`${BASE}/api/recruiter/me`, { headers: jsonHeaders(mayaToken) }))
check('recruiter sees their company', me.recruiter.company === `Acme Hiring ${RUN}`)
// The admin in the included seat, and three in bought ones.
check('recruiter sees colleagues', me.colleagues.length === 4, `${me.colleagues.length} accounts`)

section('Role separation')
check('candidate routes reject a recruiter token',
  (await fetch(`${BASE}/api/candidate/me`, { headers: jsonHeaders(mayaToken) })).status === 401)

// ------------------------------------------------------- candidate account ---

section('Application creates an account')
const applied = await json(await apply({
  firstName: 'Dana', lastName: 'Reyes', email: `dana.${RUN}${MARKER}`,
  phone: phoneFor('4567'), location: 'Tel Aviv-Yafo', availability: 'Within 1 month',
  notes: 'Senior frontend engineer who has mentored juniors.',
}, CV_LINES, { withPhoto: true }))
check('application accepted', applied.id > 0, `${applied.skillsDetected} skills`)
check('response names the sign-in identifiers',
  applied.account.email === `dana.${RUN}${MARKER}` && applied.account.phone === phoneFor('4567'))

const sam = await json(await apply({
  firstName: 'Sam', middleName: 'Chidi', lastName: 'Okafor', email: `sam.${RUN}${MARKER}`,
  phone: phoneFor('6543'), location: 'Haifa', availability: 'Immediately',
}, OTHER_CV_LINES))
check('second application accepted', sam.id > 0)

// ------------------------------------------------------- CV auto-fill ---

section('The CV fills the form in')
/*
 * The six identity fields, read out of an uploaded CV before any account
 * exists. The model path needs an API key; the deterministic reader under it
 * does not, so this asserts what is true either way — which is also what a
 * deployment without ANTHROPIC_API_KEY actually gives its candidates.
 */
const parseForm = new FormData()
parseForm.append('cv', new Blob([await makePdf([
  'Yael Miriam Ben-Ari',
  'Senior Product Designer',
  'Tel Aviv, Israel | yael.benari@example.com | +972 54 221 8890',
  '',
  'EXPERIENCE',
  'Senior Product Designer, Paymint - Mar 2021 to present',
  '  Owned the checkout redesign end to end.',
  'SKILLS',
  'Figma, prototyping, user research',
])], { type: 'application/pdf' }), 'cv.pdf')

const parsed = await json(await fetch(`${BASE}/api/candidate/parse-cv`, {
  method: 'POST', body: parseForm,
}))

check('the first name is read', parsed.fields.firstName === 'Yael', parsed.fields.firstName)
check('the middle name is read', parsed.fields.middleName === 'Miriam', parsed.fields.middleName)
check('the last name is read', parsed.fields.lastName === 'Ben-Ari', parsed.fields.lastName)
check('the email is read', parsed.fields.email === 'yael.benari@example.com', parsed.fields.email)
check('the phone number is read', parsed.fields.phone === '+972 54 221 8890', parsed.fields.phone)
check('the city is read', parsed.fields.city === 'Tel Aviv', parsed.fields.city)

// Nothing is stored and no account is touched: this runs before either exists.
check('parsing created no account',
  (await json(await fetch(`${BASE}/api/health`))).candidates === health.candidates + 2,
  'only the two real applications above')

// A file with no readable text is a real thing, and the form simply stays
// empty rather than erroring at somebody who uploaded a scan.
const blankForm = new FormData()
blankForm.append('cv', new Blob([await makePdf(['x'])], { type: 'application/pdf' }), 'cv.pdf')
const blank = await fetch(`${BASE}/api/candidate/parse-cv`, { method: 'POST', body: blankForm })
check('an unreadable CV returns no fields rather than an error',
  blank.status === 200 && Object.keys((await blank.json()).fields).length === 0)

section('Candidate sign-in by code')
function rawRequestCode(identifier) {
  return fetch(`${BASE}/api/candidate/request-code`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ identifier }),
  })
}

async function requestCode(identifier) {
  return json(await rawRequestCode(identifier))
}

// The sign-in page offers to create a profile when there is no account, so the
// server has to say so rather than pretending a code was sent.
const unknownEmail = await rawRequestCode(`nobody.${RUN}${MARKER}`)
const unknownEmailBody = await unknownEmail.json()
check('unknown email is reported as having no account', unknownEmail.status === 404)
check('the message names the email address', /email address/i.test(unknownEmailBody.error),
  unknownEmailBody.error)

const unknownPhone = await rawRequestCode('050-000-0000')
const unknownPhoneBody = await unknownPhone.json()
check('unknown phone is reported as having no account', unknownPhone.status === 404)
check('the message names the phone number', /phone number/i.test(unknownPhoneBody.error),
  unknownPhoneBody.error)

const byEmail = await requestCode(`dana.${RUN}${MARKER}`)
check('email is detected as the channel', byEmail.channel === 'email')
check('destination is masked in the response', byEmail.maskedTo.includes('@')
  && !byEmail.maskedTo.startsWith('dana.'), byEmail.maskedTo)
check('a code is issued', /^\d{6}$/.test(byEmail.devCode ?? ''))

async function verify(identifier, code) {
  return fetch(`${BASE}/api/candidate/verify-code`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ identifier, code }),
  })
}

const wrongCode = byEmail.devCode === '000000' ? '111111' : '000000'
check('wrong code rejected', (await verify(`dana.${RUN}${MARKER}`, wrongCode)).status === 401)

const signedIn = await json(await verify(`dana.${RUN}${MARKER}`, byEmail.devCode))
check('correct code signs the candidate in', typeof signedIn.token === 'string', signedIn.name)
check('a code cannot be reused', (await verify(`dana.${RUN}${MARKER}`, byEmail.devCode)).status === 401)

/*
 * The candidate chooses the channel, so the phone number must work too, and in
 * a different format from the one they registered with.
 *
 * Built from the registered number rather than written out, because the
 * fixtures are per run now — a literal here went on testing a number that
 * belonged to a previous run's candidate, and then to nobody at all.
 */
const samDigits = phoneFor('6543').replace(/\D/g, '')
const samInternational = `+972 ${samDigits.slice(1, 3)} ${samDigits.slice(3, 6)} ${samDigits.slice(6)}`
const byPhone = await requestCode(samInternational)
check('phone is detected as the channel', byPhone.channel === 'phone')
const samSignedIn = await json(await verify(samInternational, byPhone.devCode))
check('phone in a different format resolves to the same account',
  typeof samSignedIn.token === 'string', samSignedIn.name)
check('phone sign-in reached the right person', samSignedIn.name === 'Sam Chidi Okafor')

const danaToken = signedIn.token
check('recruiter routes reject a candidate token',
  (await fetch(`${BASE}/api/hr/candidates`, { headers: jsonHeaders(danaToken) })).status === 401)

// ---------------------------------------------------------- profile editing ---

section('Candidate edits their profile')
const before = await json(await fetch(`${BASE}/api/candidate/me`, { headers: jsonHeaders(danaToken) }))
check('candidate reads their own profile', before.candidate.email === `dana.${RUN}${MARKER}`)
check('extracted CV text is not exposed to the candidate', before.candidate.cv_text === undefined)
check('photo presence is reported', before.candidate.hasPhoto === true)

/*
 * Both contact details change here, and a changed one has to be proved.
 *
 * Being signed in says the request belongs to this account; it says nothing
 * about whether the person holds the new address, and every future sign-in code
 * goes to whatever is stored. Unchanged details still need nothing.
 */
const edit = new FormData()
for (const [key, value] of Object.entries({
  firstName: 'Dana', middleName: 'Rae', lastName: 'Reyes',
  email: `dana.updated.${RUN}${MARKER}`, phone: phoneFor('9999'),
  location: 'Haifa', availability: 'Immediately', notes: 'Updated professional summary.',
  emailProof: await proveContact('email', `dana.updated.${RUN}${MARKER}`),
  phoneProof: await proveContact('phone', phoneFor('9999')),
})) edit.append(key, value)

/* The refusal that makes the rule worth having. */
const unproved = new FormData()
for (const [key, value] of Object.entries({
  firstName: 'Dana', lastName: 'Reyes', location: 'Haifa',
  email: `dana.hijacked.${RUN}${MARKER}`, phone: phoneFor('9999'),
})) unproved.append(key, value)
check('pointing the account at an unproved address is refused',
  (await fetch(`${BASE}/api/candidate/me`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${danaToken}` }, body: unproved,
  })).status === 400,
  'otherwise a borrowed session redirects every future sign-in code')

const edited = await json(await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: { Authorization: `Bearer ${danaToken}` }, body: edit,
}))
check('name parts update', edited.candidate.middle_name === 'Rae')
check('full name recomposed', edited.candidate.name === 'Dana Rae Reyes', edited.candidate.name)
check('city updates', edited.candidate.location === 'Haifa')
check('summary updates', edited.candidate.notes === 'Updated professional summary.')

/* Contacts unchanged from the edit above, so this fails for the reason it is
   testing — a missing last name — rather than for a missing proof. */
const badEdit = new FormData()
badEdit.append('firstName', 'Dana')
badEdit.append('lastName', '')
badEdit.append('email', `dana.updated.${RUN}${MARKER}`)
badEdit.append('phone', phoneFor('9999'))
check('edit enforces the same required fields as the application form',
  (await fetch(`${BASE}/api/candidate/me`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${danaToken}` }, body: badEdit,
  })).status === 400)

// Signing in with the updated phone number proves the change really landed.
const afterEdit = await requestCode(phoneFor('9999'))
check('updated phone works for sign-in', /^\d{6}$/.test(afterEdit.devCode ?? ''))

// ------------------------------------------------------------- view counter ---

section('Profile views')
const start = await json(await fetch(`${BASE}/api/candidate/me`, { headers: jsonHeaders(danaToken) }))
check('a new profile has no views', start.views.recruiters === 0, JSON.stringify(start.views))

await fetch(`${BASE}/api/hr/candidates/${applied.id}`, { headers: jsonHeaders(mayaToken) })
const afterOne = await json(await fetch(`${BASE}/api/candidate/me`, { headers: jsonHeaders(danaToken) }))
check('opening a profile records one recruiter', afterOne.views.recruiters === 1)

await fetch(`${BASE}/api/hr/candidates/${applied.id}`, { headers: jsonHeaders(mayaToken) })
const afterRepeat = await json(await fetch(`${BASE}/api/candidate/me`, { headers: jsonHeaders(danaToken) }))
check('the same recruiter looking twice is still one recruiter',
  afterRepeat.views.recruiters === 1 && afterRepeat.views.views === 2,
  `${afterRepeat.views.recruiters} recruiters, ${afterRepeat.views.views} views`)

await fetch(`${BASE}/api/hr/candidates/${applied.id}`, { headers: jsonHeaders(noaToken) })
await fetch(`${BASE}/api/hr/candidates/${applied.id}`, { headers: jsonHeaders(outsiderToken) })
const afterMore = await json(await fetch(`${BASE}/api/candidate/me`, { headers: jsonHeaders(danaToken) }))
check('distinct recruiters are counted separately', afterMore.views.recruiters === 3,
  `${afterMore.views.recruiters} recruiters`)
check('companies are counted too', afterMore.views.companies === 2,
  `${afterMore.views.companies} companies`)

/*
 * What the candidate is actually shown is reveals, not openings.
 *
 * Three recruiters across two companies have now opened this profile, so the
 * old counter reads 3 — and the number on the candidate's page must still be 0.
 * Reading is not an event worth telling somebody about; handing over a surname,
 * an email and a phone is.
 */
check('reading a profile does not move the number the candidate sees',
  afterMore.views.revealedCompanies === 0,
  `${afterMore.views.recruiters} recruiters had opened it`)

await fetch(`${BASE}/api/hr/candidates/${applied.id}/reveal`, {
  method: 'POST', headers: jsonHeaders(mayaToken),
})
const afterReveal = await json(await fetch(`${BASE}/api/candidate/me`, { headers: jsonHeaders(danaToken) }))
check('a reveal does', afterReveal.views.revealedCompanies === 1,
  `${afterReveal.views.revealedCompanies} companies`)
check('and it is dated', Boolean(afterReveal.views.lastRevealedAt), afterReveal.views.lastRevealedAt)

// Access is granted per company, so a colleague at the same firm is not a
// second company holding the details.
await fetch(`${BASE}/api/hr/candidates/${applied.id}/reveal`, {
  method: 'POST', headers: jsonHeaders(noaToken),
})
const afterColleague = await json(await fetch(`${BASE}/api/candidate/me`, { headers: jsonHeaders(danaToken) }))
check('a colleague at the same company does not count twice',
  afterColleague.views.revealedCompanies === 1,
  `${afterColleague.views.revealedCompanies} companies`)

await fetch(`${BASE}/api/hr/candidates/${applied.id}/reveal`, {
  method: 'POST', headers: jsonHeaders(outsiderToken),
})
const afterSecondCompany = await json(await fetch(`${BASE}/api/candidate/me`, { headers: jsonHeaders(danaToken) }))
check('a second company does', afterSecondCompany.views.revealedCompanies === 2,
  `${afterSecondCompany.views.revealedCompanies} companies`)

// --------------------------------------------------------------- folders ---

section('Folders')
const created = await json(await fetch(`${BASE}/api/hr/folders`, {
  method: 'POST', headers: jsonHeaders(mayaToken), body: JSON.stringify({ name: 'Phone screen' }),
}))
const shortlist = await json(await fetch(`${BASE}/api/hr/folders`, {
  method: 'POST', headers: jsonHeaders(mayaToken), body: JSON.stringify({ name: 'Shortlist' }),
}))
check('folders are created', shortlist.folders.length === 2,
  shortlist.folders.map((f) => f.name).join(', '))
check('a folder needs a name', (await fetch(`${BASE}/api/hr/folders`, {
  method: 'POST', headers: jsonHeaders(mayaToken), body: JSON.stringify({ name: '  ' }),
})).status === 400)

const screenId = created.id
const shortlistId = shortlist.id

const placed = await json(await fetch(`${BASE}/api/hr/folders/${screenId}/items`, {
  method: 'POST', headers: jsonHeaders(mayaToken), body: JSON.stringify({ candidateId: applied.id }),
}))
check('a candidate lands in the folder',
  placed.folders.find((f) => f.id === screenId).items.length === 1)

// Dragging to another folder must move, not duplicate.
const moved = await json(await fetch(`${BASE}/api/hr/folders/${shortlistId}/items`, {
  method: 'POST', headers: jsonHeaders(mayaToken), body: JSON.stringify({ candidateId: applied.id }),
}))
check('dragging to another folder moves rather than copies',
  moved.folders.find((f) => f.id === screenId).items.length === 0
  && moved.folders.find((f) => f.id === shortlistId).items.length === 1)

const renamed = await json(await fetch(`${BASE}/api/hr/folders/${shortlistId}`, {
  method: 'PATCH', headers: jsonHeaders(mayaToken), body: JSON.stringify({ name: 'Onsite' }),
}))
check('folders can be renamed',
  renamed.folders.find((f) => f.id === shortlistId).name === 'Onsite')

/*
 * Folders belong to the company, not to the person who made them.
 *
 * They used to be private — this block asserted the opposite of what it asserts
 * now — which meant two recruiters working the same role kept two shortlists,
 * neither could see the other's, and a reveal one of them paid for was
 * invisible to the other. Noa is a second seat at the same company; the
 * outsider is a seat at a different one, and that boundary has not moved.
 */
const colleagueFolders = await json(await fetch(`${BASE}/api/hr/folders`, { headers: jsonHeaders(noaToken) }))
check('a colleague at the same company sees the folders',
  colleagueFolders.folders.some((f) => f.id === shortlistId),
  `sees ${colleagueFolders.folders.length}`)
check('and is told who made each one',
  colleagueFolders.folders.find((f) => f.id === shortlistId)?.created_by === 'Maya Cohen')

check('a colleague can rename one', (await fetch(`${BASE}/api/hr/folders/${shortlistId}`, {
  method: 'PATCH', headers: jsonHeaders(noaToken), body: JSON.stringify({ name: 'Onsite' }),
})).status === 200)

/* The boundary that must not have moved with it. */
const outsiderFolders = await json(await fetch(`${BASE}/api/hr/folders`, { headers: jsonHeaders(outsiderToken) }))
check('another company sees none of them', outsiderFolders.folders.length === 0,
  `sees ${outsiderFolders.folders.length}`)
check('and cannot rename one', (await fetch(`${BASE}/api/hr/folders/${shortlistId}`, {
  method: 'PATCH', headers: jsonHeaders(outsiderToken), body: JSON.stringify({ name: 'Hijacked' }),
})).status === 404)

const ranked = await json(await fetch(`${BASE}/api/hr/match`, {
  method: 'POST', headers: jsonHeaders(mayaToken),
  body: JSON.stringify({ jobDescription: 'React and TypeScript engineer', filters: {} }),
}))
const danaRow = ranked.results.find((r) => r.candidate.id === applied.id)
check('search results show which folder a candidate is in', danaRow?.folder?.name === 'Onsite',
  danaRow?.folder?.name ?? 'none')

const dropped = await json(await fetch(`${BASE}/api/hr/folders/${shortlistId}`, {
  method: 'DELETE', headers: jsonHeaders(mayaToken),
}))
check('deleting a folder removes it', dropped.folders.length === 1)

// ------------------------------------------------------------------ chat ---

section('Chat')
check('candidate cannot cold-message a recruiter', (await fetch(
  `${BASE}/api/candidate/threads/${maya.recruiter.id}`,
  { method: 'POST', headers: jsonHeaders(danaToken), body: JSON.stringify({ body: 'Hire me' }) },
)).status === 403)

/*
 * Messaging sits on the far side of the reveal: a conversation carries the
 * recruiter's name and company to the candidate and gives them a reply address,
 * which is the same access a reveal grants in the other direction.
 */
// Sam, who this company has never revealed — Dana was revealed further up, and
// asking about her would only prove the route is idempotent.
const unrevealed = await fetch(`${BASE}/api/hr/threads/${sam.id}`, {
  method: 'POST', headers: jsonHeaders(mayaToken),
  body: JSON.stringify({ body: 'Hi Sam' }),
})
check('a recruiter cannot message a candidate they have not revealed',
  unrevealed.status === 402, `HTTP ${unrevealed.status}`)
check('and the refusal says why', /Reveal this candidate/.test((await unrevealed.json()).error ?? ''))

const opened = await json(await fetch(`${BASE}/api/hr/threads/${applied.id}`, {
  method: 'POST', headers: jsonHeaders(mayaToken),
  body: JSON.stringify({ body: 'Hi Dana — are you free for a call this week?' }),
}))
check('recruiter opens a thread once they have revealed them', opened.messages.length === 1)

// Only in the recruiter's own message list, and only because the reveal has
// already handed them the surname.
const threadList = await json(await fetch(`${BASE}/api/hr/threads`, { headers: jsonHeaders(mayaToken) }))
const listed = threadList.threads.find((t) => t.candidate_id === applied.id)
check('the thread list shows the full name of a revealed candidate',
  listed?.display_name === 'Dana Reyes', listed?.display_name)

const inbox = await json(await fetch(`${BASE}/api/candidate/threads`, { headers: jsonHeaders(danaToken) }))
check('candidate sees the thread', inbox.threads.length === 1)
check('thread is attributed to a named recruiter',
  inbox.threads[0].first_name === 'Maya' && inbox.threads[0].last_name === 'Cohen')
check('thread shows the company', inbox.threads[0].company_name === `Acme Hiring ${RUN}`)
check('unread is counted', inbox.threads[0].unread === 1)

const thread = await json(await fetch(`${BASE}/api/candidate/threads/${maya.recruiter.id}`, {
  headers: jsonHeaders(danaToken),
}))
check('candidate reads the message', thread.messages[0].body.startsWith('Hi Dana'))
check('opening the thread marks it read',
  (await json(await fetch(`${BASE}/api/candidate/threads`, { headers: jsonHeaders(danaToken) })))
    .threads[0].unread === 0)

const replied = await json(await fetch(`${BASE}/api/candidate/threads/${maya.recruiter.id}`, {
  method: 'POST', headers: jsonHeaders(danaToken),
  body: JSON.stringify({ body: 'Yes — Thursday afternoon works.' }),
}))
check('candidate can now reply', replied.messages.length === 2)
check('reply is attributed to the candidate', replied.messages[1].sender === 'candidate')

const recruiterView = await json(await fetch(`${BASE}/api/hr/candidates/${applied.id}`, {
  headers: jsonHeaders(mayaToken),
}))
check('recruiter sees the reply in the thread', recruiterView.thread.length === 2)

const colleagueThread = await json(await fetch(`${BASE}/api/hr/threads/${applied.id}`, {
  headers: jsonHeaders(noaToken),
}))
check('a different recruiter has a separate conversation', colleagueThread.messages.length === 0)

check('empty messages are rejected', (await fetch(`${BASE}/api/hr/threads/${applied.id}`, {
  method: 'POST', headers: jsonHeaders(mayaToken), body: JSON.stringify({ body: '   ' }),
})).status === 400)

section('Password reset')
/*
 * Two kinds of recruiter account, two different answers.
 *
 * An organization administrator registered themselves and proved the address on
 * the account, so a reset can be mailed to it. Every other account was created
 * by that administrator, who chose the password and is accountable for the
 * seat — mailing a reset to an address they entered on somebody else's behalf
 * would route recovery around the only person meant to control it.
 */
const forgot = (body) => fetch(`${BASE}/api/recruiter/forgot-password`, {
  method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body),
})
const mayaKey = company.joinKey

const adminAsked = await json(await forgot({ joinKey: mayaKey, username: 'maya.cohen' }))
check('an administrator is sent a link', adminAsked.sent === true)
/* Enough to tell which of your mailboxes to open, and not enough to be an
   address: the reply is readable by whoever asked, who is not necessarily the
   account holder. */
check('and told which mailbox, without being told the address',
  typeof adminAsked.hint === 'string'
  && adminAsked.hint.includes('*') && adminAsked.hint.includes('@'),
  adminAsked.hint)

const seatAsked = await json(await forgot({ joinKey: mayaKey, username: 'noa.levi' }))
check('a seat the administrator created is sent to the administrator',
  seatAsked.sent === false && seatAsked.askAdministrator === true)

/* The same answer for an account that does not exist, or this becomes a way of
   testing who works at a company whose key you happen to know. */
const unknownAsked = await json(await forgot({ joinKey: mayaKey, username: 'nobody.here' }))
check('an unknown username is answered identically',
  JSON.stringify(unknownAsked) === JSON.stringify(seatAsked))

const resetToken = adminAsked.devToken
check('the token is echoed only because OTP_ECHO is on', typeof resetToken === 'string')

const redeem = (body) => fetch(`${BASE}/api/recruiter/reset-password`, {
  method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body),
})
check('a weak password is refused',
  (await redeem({ token: resetToken, password: 'short' })).status === 400,
  'the reset uses the same rule the sign-up form does')

/*
 * The reset form asks for the password twice, because it is masked and there is
 * no current password to fall back on if it goes in wrong — a typo here spends
 * the link and locks somebody out of the account they just proved was theirs.
 * The route checks it too, so the form and the server cannot disagree about
 * what the rule is.
 */
const mismatched = await redeem({
  token: resetToken, password: 'Rotated1!x', confirmPassword: 'Rotated1!y',
})
check('two different passwords are refused', mismatched.status === 400, `HTTP ${mismatched.status}`)
check('and it says which way it failed',
  /do not match/i.test((await mismatched.json()).error ?? ''))
check('the link survives the mistake',
  (await redeem({ token: resetToken, password: 'Rotated1!x', confirmPassword: 'Rotated1!x' })).status === 200,
  'a mismatch must not spend the one use the link has')

check('and cannot be spent twice',
  (await redeem({ token: resetToken, password: 'Another1!x' })).status === 400,
  'a replayed link must not be able to set the password again')

const afterReset = await fetch(`${BASE}/api/recruiter/login`, {
  method: 'POST',
  headers: jsonHeaders(),
  body: JSON.stringify({ joinKey: mayaKey, username: 'maya.cohen', password: 'Rotated1!x' }),
})
check('the new password works', afterReset.status === 200)
mayaToken = (await json(afterReset)).token

section('Mark as unread')
/*
 * Unread was derived from the other side's messages alone: the mark was stored
 * by clearing read_at on their newest one. So it worked for a candidate, who by
 * definition has been written to, and failed for a recruiter waiting on a first
 * reply — the endpoint answered 404 and the row never changed. That is the most
 * ordinary state a recruiter's thread can be in.
 *
 * Noa has written to nobody, so hers is the one-sided case. Maya's thread has a
 * reply in it and covers the other.
 */
const hrThreads = async (token) =>
  json(await fetch(`${BASE}/api/hr/threads`, { headers: jsonHeaders(token) }))
const noaThreadOf = async () => (await hrThreads(noaToken)).threads
  .find((t) => t.candidate_id === applied.id)

await fetch(`${BASE}/api/hr/threads/${applied.id}`, {
  method: 'POST', headers: jsonHeaders(noaToken), body: JSON.stringify({ body: 'Hello — are you free?' }),
})
const noaBefore = await noaThreadOf()
check('a thread nobody has answered starts read', noaBefore && noaBefore.unread === 0)

const markedOneSided = await fetch(`${BASE}/api/hr/threads/${applied.id}/unread`, {
  method: 'POST', headers: jsonHeaders(noaToken), body: '{}',
})
check('it can still be marked unread', markedOneSided.status === 200,
  'the mark is about the conversation, not about a message in it')
check('and the row says so', (await noaThreadOf())?.unread === 1)

/* Marking it again must not stack — the count is a state, not a tally. */
await fetch(`${BASE}/api/hr/threads/${applied.id}/unread`, {
  method: 'POST', headers: jsonHeaders(noaToken), body: '{}',
})
check('marking twice does not inflate the count', (await noaThreadOf())?.unread === 1)

await fetch(`${BASE}/api/hr/threads/${applied.id}`, { headers: jsonHeaders(noaToken) })
check('opening it clears the mark', (await noaThreadOf())?.unread === 0,
  'otherwise a hand-marked thread stays lit after being read')

/* The original mechanism still has to work where it always did. */
await fetch(`${BASE}/api/hr/threads/${applied.id}`, { headers: jsonHeaders(mayaToken) })
await fetch(`${BASE}/api/hr/threads/${applied.id}/unread`, {
  method: 'POST', headers: jsonHeaders(mayaToken), body: '{}',
})
const mayaThread = (await hrThreads(mayaToken)).threads.find((t) => t.candidate_id === applied.id)
check('a thread with a reply in it marks unread too', mayaThread?.unread === 1)

// -------------------------------------------------------------- CV files ---

section('CV file')
const attachment = await fetch(`${BASE}/api/hr/candidates/${applied.id}/file`, {
  headers: jsonHeaders(mayaToken),
})
const pdfBytes = Buffer.from(await attachment.arrayBuffer())
check('the default serves the original PDF as a download',
  attachment.ok && pdfBytes.subarray(0, 5).toString() === '%PDF-'
  && String(attachment.headers.get('content-disposition')).startsWith('attachment'),
  attachment.headers.get('content-disposition'))

const inline = await fetch(`${BASE}/api/hr/candidates/${applied.id}/file?inline=1`, {
  headers: jsonHeaders(mayaToken),
})
check('inline serves a PDF content type',
  String(inline.headers.get('content-type')).includes('application/pdf'),
  inline.headers.get('content-type'))
check('inline is not forced as a download',
  String(inline.headers.get('content-disposition')).startsWith('inline'),
  inline.headers.get('content-disposition'))

/*
 * The preview used to pass the token in the query string, because neither an
 * <object> nor a plain link can set an Authorization header. It now rides on
 * the session cookie instead: a credential in a URL survives in browser
 * history, server logs and the Referer header sent to the next destination,
 * which is three copies of a session nobody intended to make.
 */
check('a token in the URL is refused',
  (await fetch(`${BASE}/api/hr/candidates/${applied.id}/file?inline=1&token=${encodeURIComponent(mayaToken)}`)).status === 401)
check('inline still requires auth',
  (await fetch(`${BASE}/api/hr/candidates/${applied.id}/file?inline=1`)).status === 401)
check('download still requires auth',
  (await fetch(`${BASE}/api/hr/candidates/${applied.id}/file`)).status === 401)

// --------------------------------------------------------------- cleanup ---

section('Cleanup')
/*
 * Found in the database, deleted through the cascade.
 *
 * This used to DELETE /api/hr/candidates/:id, and for a while that worked. The
 * route was then removed — erasing an account is the account holder's decision
 * and a recruiter had no business doing it — and nothing here noticed, because
 * the loop counted attempts rather than results. Every run since has left its
 * two candidates and their files behind while reporting a clean exit, which is
 * what the orphaned-files check below kept tripping over.
 *
 * So the cascade is called directly, the way every other suite calls it, and
 * the assertion asks the database whether the rows are gone instead of trusting
 * a counter.
 */
const { deleteCandidateCompletely } = await import('../server/src/profiles.js')
const { UPLOAD_DIR } = await import('../server/src/db.js')
const nodePath = await import('node:path')
const { unlinkSync } = await import('node:fs')

let removed = 0
let unlinked = 0
{
  const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))
  const mine = db.prepare(`SELECT id, email FROM candidates WHERE email LIKE ?`).all(`%${MARKER}`)

  for (const candidate of mine) {
    /* The LIKE above is the filter; this is the guarantee. Only ever a row this
       run's own marker put there. */
    if (!candidate.email.endsWith(MARKER)) {
      throw new Error(`refusing to erase ${candidate.id}: not this run's`)
    }
    for (const stored of deleteCandidateCompletely(candidate.id)) {
      try { unlinkSync(nodePath.join(UPLOAD_DIR, stored)); unlinked += 1 } catch { /* gone */ }
    }
    removed += 1
  }

  const left = db.prepare(
    `SELECT COUNT(*) AS n FROM candidates WHERE email LIKE ?`,
  ).get(`%${MARKER}`).n
  db.close()

  check('test candidates removed', removed >= 2 && left === 0,
    `${removed} deleted, ${unlinked} file(s), ${left} left`)
}

check('and the roster route answers with a count, not with everybody\u2019s details',
  await (async () => {
    const body = await json(await fetch(`${BASE}/api/hr/candidates`, { headers: jsonHeaders(mayaToken) }))
    return typeof body.total === 'number' && !('candidates' in body)
  })(),
  'it used to return every name, email, phone and filename on file')

// The database may hold candidates this suite did not create, so an empty
// uploads directory is the wrong assertion — the right one is that nothing on
// disk is unreferenced.
const referenced = new Set()
{
  const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))
  for (const row of db.prepare(
    `SELECT stored_name, photo_name FROM candidates`,
  ).all()) {
    for (const name of [row.stored_name, row.photo_name]) if (name) referenced.add(name)
  }
  db.close()
}

// The candidate row only carries the legacy CV columns. Cover letters and the
// additional slots live in the documents table, and a recruiter photo is not on
// a candidate at all — without these, any real upload of one would look orphaned.
{
  const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))
  for (const row of db.prepare(`SELECT stored_name FROM documents`).all()) referenced.add(row.stored_name)
  for (const row of db.prepare(
    `SELECT photo_name FROM recruiters WHERE photo_name IS NOT NULL`,
  ).all()) referenced.add(row.photo_name)
  /* Triage applicant CVs share the uploads directory but live in their own
     table. Without this line every CV in every Triage on the machine reads as
     an orphan here — the same gap that would have had the startup sweep delete
     them, so both places have to know about both owners. */
  for (const row of db.prepare(
    `SELECT stored_name FROM triage_applicants`,
  ).all()) referenced.add(row.stored_name)
  db.close()
}

const uploadDir = new URL('../server/uploads/', import.meta.url)
const { readdirSync, existsSync } = await import('node:fs')
const onDisk = existsSync(uploadDir) ? readdirSync(uploadDir) : []
const orphans = onDisk.filter((file) => !referenced.has(file))

check('no orphaned files left on disk', orphans.length === 0,
  orphans.length ? orphans.join(', ') : `${onDisk.length} file(s), all referenced`)

// There is no API for deleting a company — deliberately, since that would be a
// dangerous thing to expose. The suite tidies up its own rows directly instead,
// matching only the names it creates so real accounts are never touched.
const removedCompanies = cleanUpTestCompanies()
check('test companies removed', removedCompanies >= 3, `${removedCompanies} deleted`)

finish()

function cleanUpTestCompanies() {
  const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

  /*
   * Every name this suite registers. 'NoSession *' was missing, so the
   * throwaway company the registration block creates survived each run and
   * accumulated — four of them before anyone noticed. A suite that leaves rows
   * behind is one you stop trusting to tell you what is really in the database.
   */
  const doomed = db.prepare(`
    SELECT id FROM companies
    WHERE name GLOB 'Acme Hiring *' OR name GLOB 'Rival Corp *' OR name GLOB 'NoSession *'
  `).all().map((row) => row.id)

  if (doomed.length === 0) {
    db.close()
    return 0
  }

  const list = doomed.join(',')
  // Foreign keys are off by default in SQLite, so the children go first.
  db.exec(`
    DELETE FROM messages        WHERE recruiter_id IN (SELECT id FROM recruiters WHERE company_id IN (${list}));
    DELETE FROM message_threads WHERE recruiter_id IN (SELECT id FROM recruiters WHERE company_id IN (${list}));
    DELETE FROM view_events     WHERE company_id IN (${list});
    DELETE FROM reveals         WHERE company_id IN (${list});
    DELETE FROM organization_reveals WHERE company_id IN (${list});
    DELETE FROM billing_ledger  WHERE company_id IN (${list});
    DELETE FROM seat_usage_periods WHERE recruiter_id IN (SELECT id FROM recruiters WHERE company_id IN (${list}));
    DELETE FROM seat_purchases  WHERE company_id IN (${list});
    DELETE FROM folder_items    WHERE folder_id IN (
      SELECT id FROM folders WHERE recruiter_id IN (SELECT id FROM recruiters WHERE company_id IN (${list})));
    DELETE FROM folders         WHERE recruiter_id IN (SELECT id FROM recruiters WHERE company_id IN (${list}));
    DELETE FROM recruiters      WHERE company_id IN (${list});
    DELETE FROM companies       WHERE id IN (${list});
  `)

  db.close()
  return doomed.length
}
