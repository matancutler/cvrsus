/**
 * The live JD demo on the recruiter landing page.
 *
 * The feature is a search anybody on the internet can run against the real
 * candidate pool, which makes it the one place in this product where a mistake
 * is published rather than merely wrong. Most of what is checked here is
 * therefore about what does NOT come back: no name, no contact detail, no
 * filename, no candidate id, and nothing that spends a reveal.
 *
 * The masking assertions deliberately search the raw response text for the real
 * values from the database rather than checking that particular keys are
 * absent. A field renamed or nested one level deeper would slip past a key
 * check and still be a leak; a value that is genuinely not in the payload
 * cannot be found however it is spelled.
 */
import fs from 'node:fs'

import {
  BASE, approveCompanyById, contactProofs, createReporter, json, makePdf, registerAndSignIn,
} from './helpers.mjs'

const { check, section, finish } = createReporter()

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')

/*
 * Read-only, straight at the database.
 *
 * "No reveal was spent" is a claim about rows that no API answer reports, so
 * asserting it through HTTP would mean asserting something adjacent and hoping.
 * Opened read-only so this suite cannot alter what it is measuring.
 */
const { default: Database } = await import('better-sqlite3')
const ledgerDb = new Database(
  new URL('../server/data/cking.db', import.meta.url).pathname.slice(1),
  { readonly: true },
)
const countRows = (from) => ledgerDb.prepare(`SELECT COUNT(*) AS n FROM ${from}`).get().n
/* Tagged cking- so the repo's fixture cleanup finds everything this suite makes. */
const RUN = `cking-demo-${Date.now().toString(36)}`

const JD = 'We are hiring a senior full stack engineer in Tel Aviv to work on our React and '
  + 'Node.js platform. You will own backend services, work with PostgreSQL and AWS, and mentor '
  + 'two junior engineers. Five or more years of commercial experience required.'

const jsonHeaders = (token) => ({
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})

/*
 * A throttled search would fail half the assertions below for a reason that has
 * nothing to do with what they test, so it is called out rather than left to
 * surface as a mysterious absence. This suite runs a dozen searches from one
 * client fingerprint, and the durable limit counts stored rows — so repeated
 * runs against a long-lived server need the allowance raised.
 */
let throttled = false

async function demoSearch(jobDescription = JD) {
  const response = await fetch(`${BASE}/api/public/demo/search`, {
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ jobDescription }),
  })
  const text = await response.text()
  if (response.status === 429) throttled = true
  return { status: response.status, text, body: JSON.parse(text || '{}') }
}

// ------------------------------------------------------------- a candidate ---

/* Someone for the demo to find, with a name and contact details that are
   distinctive enough that finding them in a response is unambiguous. */
const email = `dana@${RUN}.example.com`
const phone = `05299${String(Date.now()).slice(-5)}`
const form = new FormData()
form.append('cv', new Blob([await makePdf([
  'Dana Publicdemo', 'Senior Full Stack Engineer',
  'React, Node.js, TypeScript, PostgreSQL, AWS', 'Tel Aviv', '7 years of experience',
])], { type: 'application/pdf' }), 'Dana Publicdemo CV.pdf')
form.append('location', 'Tel Aviv')
form.append('firstName', 'Dana')
form.append('lastName', 'Publicdemo')
form.append('email', email)
form.append('phone', phone)
for (const [k, v] of Object.entries(await contactProofs({ email, phone }))) form.append(k, v)

// The 18+ affirmation and agreement the form now sends and the route now requires.
if (!form.has('consent')) form.append('consent', 'true')
const applied = await json(await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form }))

section('A stranger can search without an account')
const search = await demoSearch()
check('the public search answers', search.status === 200, `${search.status}`)
check('it hands back a search token', typeof search.body.searchToken === 'string'
  && search.body.searchToken.length >= 16)
check('and says how many candidates were considered',
  Number.isFinite(search.body.considered))
/* §2 — a rigid format is not required, but a fragment is not a brief. */
const tooShort = await demoSearch('developer')
check('a scrap of a description is refused', tooShort.status === 400)
check('with a message that says what is missing rather than a schema',
  /paste a bit more/i.test(tooShort.body.error ?? ''), tooShort.body.error)

section('Nothing identifying crosses the wire')
/*
 * The whole payload, searched for the real values. Every one of these is a
 * field the spec names as forbidden in the public preview.
 */
for (const [label, value] of [
  ['a surname', 'Publicdemo'],
  ['an email address', email],
  ['a telephone number', phone],
  ['a CV filename', 'Dana Publicdemo CV.pdf'],
]) {
  check(`${label} never appears`, !search.text.includes(value))
}
check('nor does the candidate\'s own id',
  !JSON.stringify(search.body.results ?? []).includes(`"id"`),
  '§8 — an id in a public response is an invitation to walk the range')

/* What a card may carry, as an allowlist. A field added to the candidate row
   later must not appear here by default. */
const ALLOWED = ['token', 'score', 'title', 'location', 'experience', 'skills', 'availability', 'reason']
for (const card of search.body.results ?? []) {
  const extra = Object.keys(card).filter((key) => !ALLOWED.includes(key))
  check('a card carries only the agreed fields', extra.length === 0, extra.join(', '))
}
/*
 * The heading, when the candidate recorded no job title.
 *
 * It falls back to the taxonomy the matcher already assigned — and specifically
 * to the canonical concept label, not the raw_label stored beside it. That one
 * is free text the model wrote out of the CV and has been seen to carry things
 * like "Backend engineer - Tel Aviv"; a fixed vocabulary cannot carry anything
 * that was not already in it, which is the property a public endpoint needs.
 */
const demoSource = read('../server/src/publicDemo.js')
check('an untitled profile is named from the taxonomy, not called a stub',
  /candidate\.desired_role \|\| taxonomyHeadline\(candidateId\)/.test(demoSource))
/* Scoped to what is selected, not to the word appearing anywhere: the comment
   above that query names raw_label in order to say why it is not used, and a
   bare search would read its own explanation as the violation. */
check('and from the canonical label rather than the free-text one',
  /getConcept\(labels\.concept_id\)\?\.label/.test(demoSource)
  && !/SELECT[^`]*raw_label/.test(demoSource),
  'raw_label is written by the model from the CV and is not a fixed vocabulary')

/* Coarse by design: an exact figure next to a title and a city describes one
   person rather than a kind of person. */
check('experience is a band, not a number',
  (search.body.results ?? []).every((c) => c.experience === null || Number.isNaN(Number(c.experience))))

section('Card handles are opaque and scoped to one search')
const second = await demoSearch(`${JD} Hybrid, two days a week on site.`)
const first = search.body.results?.[0]
check('the demo returned something to reveal', Boolean(first), 'no results to test against')

if (first) {
  const sameCandidateAgain = (second.body.results ?? [])
    .find((c) => c.location === first.location && c.title === first.title)
  check('the same candidate gets a different handle in another search',
    !sameCandidateAgain || sameCandidateAgain.token !== first.token,
    'equal tokens across searches would let two results be correlated to one person')

  const crossed = await fetch(`${BASE}/api/public/demo/reveal-intent`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ searchToken: second.body.searchToken, candidateToken: first.token }),
  })
  check('a handle from one search is worthless against another', crossed.status === 404)
}

section('Reveal asks for an account and reveals nothing')
const intentResponse = await fetch(`${BASE}/api/public/demo/reveal-intent`, {
  method: 'POST',
  headers: jsonHeaders(),
  body: JSON.stringify({ searchToken: search.body.searchToken, candidateToken: first?.token }),
})
const intentText = await intentResponse.text()
const intent = JSON.parse(intentText || '{}')

check('the gate opens', intentResponse.status === 200 && intent.signupRequired === true)
check('the offer is stated by the server, not by the page',
  intent.freeReveals === 10 && intent.creditCardRequired === false,
  'a number typed into the client is free to drift from the credit actually granted')
for (const [label, value] of [['a surname', 'Publicdemo'], ['an email', email], ['a phone', phone]]) {
  check(`pressing reveal returns no ${label}`, !intentText.includes(value))
}
/*
 * Counted, not argued.
 *
 * §3 and §14.8: a public search must not itself consume a reveal, and a reveal
 * is deducted only after an authorized one succeeds. Both tables are read
 * either side of a full demo — search, then press Reveal — so this fails if any
 * path through the public routes ever reaches the ledger.
 */
const ledger = () => ({
  reveals: countRows('reveals'),
  spend: countRows("billing_ledger WHERE product = 'reveal' AND event = 'consume'"),
})
const before = ledger()
await demoSearch(`${JD} Equity offered.`)
await fetch(`${BASE}/api/public/demo/reveal-intent`, {
  method: 'POST',
  headers: jsonHeaders(),
  body: JSON.stringify({ searchToken: search.body.searchToken, candidateToken: first?.token }),
})
const after = ledger()
check('a public search spends no reveal',
  after.reveals === before.reveals && after.spend === before.spend,
  `reveals ${before.reveals}->${after.reveals}, ledger ${before.spend}->${after.spend}`)

section('The search survives account creation')
/*
 * Claimed at registration, because that is the only request that knows both the
 * token and the account being made — registering deliberately does not sign
 * anybody in, so there is no later moment that holds both facts.
 */
const claiming = await demoSearch(`${JD} Reporting to the VP Engineering.`)
const company = await registerAndSignIn({
  companyName: `${RUN}-a`,
  firstName: 'Maya',
  lastName: 'Cohen',
  email: `maya@${RUN}-a.example.com`,
  phone: `05288${String(Date.now()).slice(-5)}`,
  demoSearchToken: claiming.body.searchToken,
})
await approveCompanyById(company.company.id)

const me = await json(await fetch(`${BASE}/api/recruiter/me`, {
  headers: jsonHeaders(company.token),
}))
check('the workspace is told there is a search waiting', Boolean(me.resumeSearch))
check('and it carries the job description, so nothing is retyped',
  me.resumeSearch?.jobDescription?.startsWith('We are hiring a senior full stack engineer'),
  me.resumeSearch?.jobDescription?.slice(0, 40))

section('The free reveals are the existing grant, once')
/*
 * Not a new promotional path: registration already credits the complimentary
 * balance, guarded by a timestamp column so a retry cannot grant twice. The
 * demo advertises that grant rather than adding a second one, which is what
 * makes "do not grant another 10 because someone repeats the demo" true by
 * construction.
 */
check('a new organization holds exactly the advertised number',
  me.wallet?.balance === intent.freeReveals,
  `balance ${me.wallet?.balance} vs offered ${intent.freeReveals}`)

const wallet = read('../server/src/wallet.js')
check('the grant is guarded by a stamp rather than by counting',
  /complimentary_granted_at IS NULL/.test(wallet),
  'counting ledger rows would race; the column makes a second grant impossible')

section('A claimed search cannot be taken twice')
const rival = await registerAndSignIn({
  companyName: `${RUN}-b`,
  firstName: 'Noa',
  lastName: 'Levi',
  email: `noa@${RUN}-b.example.com`,
  phone: `05277${String(Date.now()).slice(-5)}`,
  demoSearchToken: claiming.body.searchToken,
})
await approveCompanyById(rival.company.id)
const rivalMe = await json(await fetch(`${BASE}/api/recruiter/me`, {
  headers: jsonHeaders(rival.token),
}))
check('a second company replaying the same token gets nothing',
  rivalMe.resumeSearch === null,
  'otherwise a token overheard once moves somebody else\'s search onto your account')
check('and the first company still has it', Boolean((await json(await fetch(
  `${BASE}/api/recruiter/me`, { headers: jsonHeaders(company.token) },
))).resumeSearch))

section('The demo is bounded')
const demo = read('../server/src/publicDemo.js')
check('its limits come from the environment, not from the interface',
  /process\.env\.PUBLIC_DEMO_MAX_SEARCHES/.test(demo)
  && /process\.env\.PUBLIC_DEMO_MIN_SCORE/.test(demo),
  '§8 — a threshold that only exists in the client is one an attacker edits out')
check('the route carries its own rate limit',
  read('../server/src/index.js').includes('limits.demo'))
check('and a second limit that survives a restart',
  /FROM public_searches WHERE client_hash = \? AND created_at > \?/.test(demo),
  'express-rate-limit counts in memory, so a restart hands everyone a fresh allowance')
check('the client is fingerprinted rather than stored',
  /createHmac\('sha256', secret\)/.test(demo) && !/INSERT INTO public_searches[\s\S]{0,200}req\.ip/.test(demo))

section('The demo runs the real pipeline')
check('it calls the same search the product uses',
  demo.includes("from './matching/pipeline.js'") && demo.includes('runSearch('),
  '§3 — a preview that used different logic would misrepresent the product')
check('an anonymous search is owned by nobody',
  /ANONYMOUS_RECRUITER_ID = 0/.test(demo),
  'recruiter ids start at 1, so no account can read one through the authenticated routes')

section('The demo is an overlay, not a route')
const app = read('../client/src/App.jsx')
check('no demo route was added',
  !/path="\/demo"/.test(app) && !/path="\/recruiter-demo"/.test(app) && !/path="\/search"/.test(app))
/*
 * Opened from the header, so it is shell state rather than page state — a
 * recruiter reading About or Pricing can try a real role without first working
 * out which page the demo lives on. Whatever they were reading stays mounted
 * underneath, because the overlay is rendered beside the router rather than
 * inside it.
 */
check('it is a piece of shell state, not page state',
  /const \[demoOpen, setDemoOpen\]/.test(app))
check('and opens from the header nav', /className="nav-link nav-demo"/.test(app))
check('with the page still mounted under it', app.includes('<LiveDemo open={demoOpen}'))
check('the landing page no longer owns a copy',
  !read('../client/src/pages/UploadPage.jsx').includes('LiveDemo'),
  'two mounts would be two independent searches')
/* A phone has no header nav, so the drawer carries it or it is unreachable. */
check('and it is reachable on a phone',
  read('../client/src/components/MobileNav.jsx').includes('onDemo'))

const liveDemo = read('../client/src/components/LiveDemo.jsx')

section('The demo shows the product, not a form in a box')
/*
 * The argument the demo has to make is "this is what you would be buying", and
 * a bespoke preview makes it badly: it shows the results without the product
 * they arrive in. So the overlay is the workspace — rail, composer, result
 * rows — with one live control.
 */
check('the overlay is shaped like the workspace', /className="demo-portal"/.test(liveDemo))
check('with the rail and the dock shown', /function DemoRail/.test(liveDemo)
  && /className="demo-dock"/.test(liveDemo))
/*
 * `inert` rather than `disabled` or pointer-events: it takes the whole subtree
 * out of the tab order AND out of the accessibility tree, so a keyboard cannot
 * land on a dead button and a screen reader is not read a menu that does
 * nothing. Pointer-events alone leaves both of those wrong.
 */
check('and both taken out of reach with inert',
  (liveDemo.match(/inert=""/g) ?? []).length >= 2)
/*
 * The composer is the product's own component, not a copy of it — so the demo
 * cannot drift from the thing it demonstrates, and the flow a stranger learns
 * is the flow they keep after signing up. Only the paperclip is muted, because
 * reading a JD out of a PDF is behind the authenticated route.
 */
check('the search is what stays live',
  /<SearchHero/.test(liveDemo) && /onSubmit=\{\(\) => submit\(\)\}/.test(liveDemo))
check('and it is the real composer, not a lookalike',
  liveDemo.includes("import SearchHero from './SearchHero.jsx'")
  && !/className="demo-composer"/.test(liveDemo))
/*
 * The paperclip works here too. It reads a JD out of a PDF, which the recruiter
 * route does behind their session — so the demo has its own entry point with
 * the demo's rate limit on it rather than a muted button or a loosened one.
 */
check('the attachment control is live, through the public route',
  /uploadPath="\/api\/public\/demo\/jd-text"/.test(liveDemo))
check('and that route is rate-limited like the rest of the demo',
  /app\.post\('\/api\/public\/demo\/jd-text', limits\.demo/.test(read('../server/src/index.js')),
  'it is the only file upload a stranger can make')
/* Reveal has to keep working: it is the conversion point the whole feature
   exists for, and an inert one would make the demo a dead end. */
check('and reveal, which is the point of the whole feature',
  /onReveal=\{\(\) => reveal\(card\)\}/.test(liveDemo))
/*
 * A result row opens a profile, as it does in the authenticated search. Reading
 * someone is free and reveals nothing, so it must not be the gesture that asks
 * for an account — that is Reveal's job, and they are separate layers.
 */
/*
 * And the rows are the product's rows, class for class — .result, .result-main,
 * .score — rather than a parallel set that merely resembles them. A demo whose
 * rows are a lookalike teaches a layout the recruiter will never see again.
 */
check('a result row opens a masked profile',
  /<li className="result">/.test(liveDemo) && /className="demo-profile"/.test(liveDemo))
check('and the row is the product\'s own',
  /className="result-main"/.test(liveDemo)
  && /className="result-identity"/.test(liveDemo)
  && /className=\{`score score-\$\{band\}`\}/.test(liveDemo))
/*
 * Save is not a button on the row any more — not here and not in the panel,
 * which moved every per-row action into the corner behind the dots. The demo
 * draws that corner and wires exactly one of it, so a visitor sees the row they
 * will actually get rather than a pair of buttons that no longer exists.
 */
check('the corner is the panel’s, with Reveal the struck-through eye',
  /className="icon-button result-reveal"/.test(liveDemo)
  && /<EyeOff \/>/.test(liveDemo))
check('and the rest of it is drawn rather than dead',
  (liveDemo.match(/<span className="icon-button" inert=""/g) ?? []).length === 3,
  'inert takes a control out of the tab order and the accessibility tree at once')
/* The loud call to action did not go with it: opening a card still leads to a
   full-width Reveal, which is where the panel keeps its own. */
check('and the opened profile still asks for the account',
  /className="btn btn-primary demo-reveal"/.test(liveDemo))

/*
 * Both destinations in the rail, drawn with the panel's own nav classes.
 *
 * Triage is a separately paid product area and the rail is the only place the
 * demo says it exists; showing Folders alone described a workspace with one
 * destination. Scenery, like the rest of the aside, which is inert as a whole.
 */
check('the rail carries Folders and Triage, in the panel’s own nav',
  /className="ws-nav-item">Folders<span className="ws-nav-count">/.test(liveDemo)
  && /className="ws-nav-item">Triage<span className="ws-nav-count">/.test(liveDemo))
check('and the whole rail stays unpressable',
  /<aside className="demo-rail" inert=""/.test(liveDemo),
  'one attribute on the container rather than a disabled state on each item')
check('which is a different layer from the sign-up gate',
  /const \[profile, setProfile\]/.test(liveDemo) && !/setGateFor\(card\)[\s\S]{0,60}setProfile/.test(liveDemo))
/*
 * And it shows the preview already sent rather than fetching more. Opening a
 * profile must not widen what the public endpoint discloses; the card and the
 * dialog are two readings of one masked payload.
 */
/*
 * Counted rather than pattern-matched around the profile code: the component
 * may talk to exactly two endpoints, the search and the reveal gate. A third
 * call is the only way opening a profile could disclose more than the list
 * already had, so counting them is the assertion — and it cannot be fooled by
 * where in the file the call happens to sit.
 */
const calls = [...liveDemo.matchAll(/(?:get|post|sendForm)\('([^']+)'/g)].map((m) => m[1]).sort()
check('and discloses nothing the row had not',
  JSON.stringify(calls) === JSON.stringify([
    '/api/public/demo/limits',
    '/api/public/demo/reveal-intent',
    '/api/public/demo/search',
    '/api/public/demo/triage',
  ]),
  `talks to: ${calls.join(', ')}`)
check('the results are not unmounted while the gate is open',
  /\{gateFor && \(/.test(liveDemo) && !/gateFor \? \([\s\S]{0,80}CompanySignUpForm/.test(liveDemo),
  'abandoning the sign-up has to return the recruiter to the list they were reading')
check('the gate hands the search token to registration',
  liveDemo.includes('demoSearchToken={search?.searchToken ?? null}'))
check('closing the demo keeps the search', /Deliberately keeps the search/.test(liveDemo))

// ------------------------------------------------------- Triage, in demo ---

section('A stranger can sort their own CVs')
/*
 * The other half of the product, on the visitor's own documents.
 *
 * Nothing here is about the candidate pool — these are files the visitor
 * uploaded — so what has to be proved is not masking but restraint: that the
 * ceiling holds, that a file we cannot read says so rather than scoring zero,
 * and above all that when the response has been sent the server is holding
 * none of it.
 */
const triageJd = 'Senior Backend Engineer in Tel Aviv.\n'
  + 'Requirements: Node.js, TypeScript, PostgreSQL.\n'
  + 'Preferred: Kubernetes, AWS.\n'
  + 'Five years of commercial experience building production services.'

const limits = await json(await fetch(`${BASE}/api/public/demo/limits`))
check('the limit is stated by the server, not typed into the page',
  Number.isInteger(limits.triageMaxFiles) && limits.triageMaxFiles > 0,
  'the placeholder says "up to N CVs" and has to read N from here')
check('and the composer builds its sentence from it',
  liveDemo.includes('maxCvs={limits?.triageMaxFiles ?? 0}')
  && read('../client/src/components/SearchHero.jsx')
    .includes('You can also upload up to ${maxCvs} CVs to try our Triage feature.'),
  'a number written twice is a number that will disagree with itself')

const asCv = async (name, lines) => [name, await makePdf(lines)]
const pile = [
  await asCv('strong.pdf', ['Rina Backend', 'rina@example.com', 'Tel Aviv',
    'Node.js, TypeScript, PostgreSQL, Kubernetes, AWS, system design. Seven years.']),
  await asCv('weak.pdf', ['Dana Designer', 'dana@example.com', 'Tel Aviv',
    'Figma, Sketch, user research, design systems. Six years of product design.']),
]

const triageForm = new FormData()
triageForm.append('jobDescription', triageJd)
for (const [name, bytes] of pile) {
  triageForm.append('cvs', new Blob([bytes], { type: 'application/pdf' }), name)
}
/* A scan: a PDF with no text layer at all. */
triageForm.append(
  'cvs',
  new Blob([Buffer.from('%PDF-1.4\n% nothing readable in here\n')], { type: 'application/pdf' }),
  'scan.pdf',
)

const runsBefore = countRows('public_demo_runs')
const uploadDir = new URL('../server/uploads/', import.meta.url).pathname.slice(1)
const uploadsBefore = new Set(fs.readdirSync(uploadDir))
const applicantsBefore = countRows('triage_applicants')
const sorted = await json(await fetch(`${BASE}/api/public/demo/triage`, {
  method: 'POST', body: triageForm,
}))

check('the pile comes back ranked', sorted.ranked.length === 2)
check('and the stronger CV is first',
  sorted.ranked[0]?.fileName === 'strong.pdf' && sorted.ranked[0].rank === 1
  && sorted.ranked[1]?.rank === 2,
  `${sorted.ranked.map((r) => `${r.fileName}:${r.rank}`).join(', ')}`)

/*
 * The number the preliminary pass produced never leaves the server.
 *
 * §3 forbids showing that pass as a score and §4 forbids inventing a Triage
 * percentage beside Search's; the paid results view honours both by never
 * serialising prelim_score (see applicantView in server/src/triage.js). The
 * demo runs ONLY that pass, so publishing its number — and the demo did, as a
 * "match" percentage — is exactly what the two sections rule out.
 */
check('and no row carries a score, a sort key or a component count',
  sorted.ranked.every((row) => row.score === undefined
    && row.sortKey === undefined && row.components === undefined),
  `row keys: ${Object.keys(sorted.ranked[0] ?? {}).join(', ')}`)

check('each row says who it is and what it evidences',
  sorted.ranked[0]?.name === 'Rina Backend' && sorted.ranked[0].matched.length > 0)
check('a file with no text layer is reported, not scored',
  sorted.unreadable.length === 1 && sorted.unreadable[0].fileName === 'scan.pdf'
  && sorted.unreadable[0].score === null,
  '"we could not read this" and "this is a poor match" are different answers')
check('and it carries its own reason rather than a blanket one',
  /scan|image-only/i.test(sorted.unreadable[0]?.reason ?? ''))
check('and the count considered is every file handed over', sorted.considered === 3)

/*
 * The part that matters most. A stranger's CVs are the most sensitive thing
 * this server is ever handed, and it has no business keeping them.
 */
check('nothing was written to disk',
  fs.readdirSync(uploadDir).filter((name) => !uploadsBefore.has(name)).length === 0,
  'the files are unlinked in a finally, so a failure cannot leave them behind either')
check('and no Triage row was created for it',
  countRows('triage_applicants') === applicantsBefore,
  'the demo is not a free tier of the paid product — it stores nothing at all')

const overFull = new FormData()
overFull.append('jobDescription', triageJd)
for (let i = 0; i <= limits.triageMaxFiles; i += 1) {
  overFull.append('cvs', new Blob([pile[0][1]], { type: 'application/pdf' }), `bulk-${i}.pdf`)
}
const refused = await fetch(`${BASE}/api/public/demo/triage`, { method: 'POST', body: overFull })
const refusedBody = await refused.json().catch(() => ({}))
check(`more than ${limits.triageMaxFiles} files is refused`, refused.status === 400)
check('and the refusal names the rule rather than the parser',
  new RegExp(String(limits.triageMaxFiles)).test(refusedBody.error ?? ''),
  `said: ${refusedBody.error}`)

const noBrief = new FormData()
noBrief.append('jobDescription', 'developer')
noBrief.append('cvs', new Blob([pile[0][1]], { type: 'application/pdf' }), 'a.pdf')
const briefTooShort = await fetch(`${BASE}/api/public/demo/triage`, { method: 'POST', body: noBrief })
check('a scrap of a description is refused here too', briefTooShort.status === 400)

const noFiles = new FormData()
noFiles.append('jobDescription', triageJd)
check('and so is a run with nothing to sort',
  (await fetch(`${BASE}/api/public/demo/triage`, { method: 'POST', body: noFiles })).status === 400)

/*
 * A brief the deterministic reader can make nothing of.
 *
 * parseJobDescription, keywordsFrom and the title tokeniser are ASCII-only, so
 * a job description in a non-Latin script yields no requirements, no keywords
 * and no title — and scoreCandidate then returns zero for every CV. Ordering
 * that is ordering nothing, and rendering it as a ranking would be the demo's
 * most confident lie.
 */
const hebrewBrief = new FormData()
hebrewBrief.append('jobDescription', 'דרוש מנהל משרד לחברה מובילה בתל אביב. ניסיון של '
  + 'חמש שנים לפחות בניהול משרד, אחריות על ספקים ותקציב, וידע במערכות מידע.')
hebrewBrief.append('cvs', new Blob([pile[0][1]], { type: 'application/pdf' }), 'x.pdf')
const unreadableBrief = await fetch(`${BASE}/api/public/demo/triage`, {
  method: 'POST', body: hebrewBrief,
})
check('a brief with no readable requirements is refused, not ranked at zero',
  unreadableBrief.status === 400,
  'every CV would score 0 and the page would present that as an order')

/*
 * The durable half of the rate limit has to count these runs.
 *
 * express-rate-limit counts in memory and forgets on restart, which is why the
 * search demo also writes a row. Triage persists nothing by design, so it needs
 * its own record or the throttle it consults is one only searches can move.
 */
const runsAfter = countRows('public_demo_runs')
check('every demo Triage run is recorded against the connection',
  runsAfter > runsBefore,
  `${runsBefore} -> ${runsAfter}: without this the route reads a counter nothing on `
  + 'its path ever increments, and is unthrottled once the server restarts')


section('Somebody who hides from a company is not in the demonstration')

/*
 * A block names a company; an anonymous visitor has none.
 *
 * The signed-in case can ask "is this viewer's organisation on the list", and
 * the demonstration cannot: the person at the keyboard could be from the
 * company the candidate is hiding from, and there is no way to find out. So the
 * demonstration withholds anyone who has blocked anybody at all.
 *
 * The Privacy Policy says this in as many words, which is the reason it is
 * tested rather than assumed.
 */
const shownBefore = await json(await fetch(`${BASE}/api/public/demo/search`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jobDescription: JD }),
}))
const wasThere = (shownBefore.results ?? []).length
check('the demonstration returns somebody to begin with', wasThere > 0)

const hiddenId = ledgerDb.prepare(`SELECT id FROM candidates WHERE email LIKE ? LIMIT 1`)
  .get(`%${RUN}%`)?.id
check('and this run made a candidate to hide', Boolean(hiddenId))

/* A second handle, writable, opened only for this fixture: ledgerDb above is
   deliberately read-only so the suite cannot alter what it measures, and this
   one is closed again as soon as the block row is gone. */
const blockDb = new Database(new URL('../server/data/cking.db', import.meta.url).pathname.slice(1))
blockDb.prepare(`
  INSERT OR IGNORE INTO blocked_companies (candidate_id, raw_name, normalized, created_at)
  VALUES (?, 'Some Company They Fear', 'some company they fear', ?)
`).run(hiddenId, new Date().toISOString())

const afterBlock = await json(await fetch(`${BASE}/api/public/demo/search`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jobDescription: JD, refresh: true }),
}))
check('a candidate hiding from any company is out of the demonstration entirely',
  !(afterBlock.results ?? []).some((r) => r.id === hiddenId || r.candidateId === hiddenId),
  'the blocked company is not the viewer, because the demonstration has no viewer')

blockDb.prepare(`DELETE FROM blocked_companies WHERE candidate_id = ?`).run(hiddenId)
blockDb.close()

section('The page serves')
check('the landing page is served', (await fetch(`${BASE}/?join=recruiter`)).status === 200)
check('no search in this run was throttled', !throttled,
  'raise PUBLIC_DEMO_MAX_SEARCHES on the test server — the durable limit counts stored '
  + 'rows, so consecutive runs against one server exhaust it and the claim checks fail '
  + 'for a reason that is not about claiming')

/* The fixtures this suite makes are all tagged cking-, which is what the
   repository's fixture cleanup looks for. Nothing is deleted here: candidate
   removal goes through an authenticated route, and reaching for the database
   directly is how an earlier suite came to leak uploads. */
void applied

finish()
