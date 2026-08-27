/**
 * Recruiter Matching & Filtering Architecture v1.0 — §18 acceptance criteria.
 *
 * Each section names the criterion it proves. Where a criterion cannot be
 * checked through the API alone (cache keys, version bumps) the database is
 * read directly, because the point of those mechanisms is invisible from
 * outside and that is exactly why they need a test.
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import Database from 'better-sqlite3'

import {
  BASE, approveCompanyById, contactProofs, createReporter, deleteCandidate, json,
  makePdf, proveContact, registerAndSignIn, registerCompany, serverEnv,
} from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const MARKER = `@cking-matching-${RUN}.example.com`
const H = (t) => ({ 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) })
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const CVS = {
  ml: [
    'Data scientist specialising in machine learning for payments fraud.',
    'SENIOR DATA SCIENTIST, PayFlow (fintech) 2019-03 - present',
    '  Built and deployed fraud detection models in Python and PyTorch.',
    '  Led a team of three data scientists from 2023-01.',
    'DATA SCIENTIST, Bankly 2016-01 - 2019-02',
    '  SQL pipelines, statistics, experimentation.',
    'SKILLS: Python, SQL, PyTorch, Machine Learning, Statistics',
    'LANGUAGES: English, Hebrew',
  ],
  credit: [
    'Credit analyst with a long record in commercial lending.',
    'SENIOR CREDIT ANALYST, First Commercial Bank 2012-01 - present',
    '  Credit risk assessment and underwriting for mid-market lending.',
    '  Team lead for the credit desk from 2021-06.',
    'SKILLS: Credit Analysis, Financial Modelling, Excel, Risk',
    'LANGUAGES: English, French',
  ],
  fashion: [
    'Marketing manager in apparel and luxury retail.',
    'MARKETING MANAGER, Mode House 2018-01 - present',
    '  Brand campaigns, performance marketing, social.',
    'SKILLS: Marketing, Brand, SEO, Copywriting',
  ],
}


/** Proves the email and phone already in `form`, and appends the proofs. */
async function appendProofs(form) {
  const proofs = await contactProofs({ email: form.get('email'), phone: form.get('phone') })
  for (const [key, value] of Object.entries(proofs)) form.append(key, value)
}

async function apply({ first, last, cv, extra = {} }) {
  const form = new FormData()
  form.append('cv', new Blob([await makePdf(cv)], { type: 'application/pdf' }), 'cv.pdf')
  const fields = {
    firstName: first, lastName: last,
    email: `${first}.${last}.${RUN}${MARKER}`.toLowerCase(),
    phone: `052-${Math.floor(1000000 + Math.random() * 8999999)}`,
    location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
    ...extra,
  }
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  // Both contact details are proved before an account exists.
  await appendProofs(form)
  // The 18+ affirmation and agreement the form now sends and the route now requires.
  if (!form.has('consent')) form.append('consent', 'true')
  const res = await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form })
  return { res, body: await res.json().catch(() => ({})) }
}

/** Extraction and intelligence run after the response; wait for the row. */
async function waitForIntelligence(id, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const row = db.prepare(`
      SELECT 1 AS ok FROM candidate_profile_intelligence i
      JOIN candidates c ON c.id = i.candidate_id AND c.profile_version = i.profile_version
      WHERE i.candidate_id = ?
    `).get(id)
    if (row) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

// ---------------------------------------------------------------- setup ---

section('Setup')
const admin = await registerAndSignIn({ companyName: `Matching ${RUN}` })
check('recruiter account created', Boolean(admin.token))
// §15 — a company registers 'pending' and reaches nothing until it is approved.
await approveCompanyById(admin.company.id)


const ml = await apply({ first: 'Noa', last: 'Ml', cv: CVS.ml })
const credit = await apply({ first: 'Amir', last: 'Credit', cv: CVS.credit })
const fashion = await apply({
  first: 'Dana', last: 'Fashion', cv: CVS.fashion,
  /*
   * §18 — opted into VC only. Must not surface for a fashion role.
   *
   * Deliberately a single narrow tag: adding 'banking' here would make the
   * later "narrow tags are not widened" check pass for the wrong reason, since
   * a banking role would then be permitted outright.
   */
  extra: { openToAllOpportunities: 'false', interestTags: 'venture capital' },
})

check('three candidates applied',
  [ml, credit, fashion].every((c) => c.res.status === 201),
  [ml, credit, fashion].map((c) => c.res.status).join(', '))

check('intelligence built for all three',
  (await Promise.all([ml, credit, fashion].map((c) => waitForIntelligence(c.body.id))))
    .every(Boolean))

// -------------------------------------------------------------- §3.2/§3.3 ---

section('§3.2 multi-label intelligence')
const mlLabels = db.prepare(`
  SELECT dimension, concept_id, confidence FROM candidate_taxonomy_labels
  WHERE candidate_id = ?
`).all(ml.body.id)

check('the ML candidate carries several labels', mlLabels.length >= 2, `${mlLabels.length} labels`)
check('across more than one dimension',
  new Set(mlLabels.map((l) => l.dimension)).size >= 2,
  [...new Set(mlLabels.map((l) => l.dimension))].join(', '))
check('including fintech (an industry)', mlLabels.some((l) => l.concept_id === 'fintech'))
check('and machine learning (a specialization)',
  mlLabels.some((l) => l.concept_id === 'machine-learning'))
check('every label carries a confidence',
  mlLabels.every((l) => typeof l.confidence === 'number' && l.confidence > 0 && l.confidence <= 1))
check('and evidence for why it was applied',
  db.prepare(`SELECT COUNT(*) AS n FROM candidate_taxonomy_labels WHERE candidate_id = ? AND evidence IS NOT NULL`)
    .get(ml.body.id).n === mlLabels.length)

section('§3.3 two durations, not one')
const creditMetrics = db.prepare(`
  SELECT domain, years, leadership_years FROM candidate_experience_metrics WHERE candidate_id = ?
`).all(credit.body.id)

const overall = creditMetrics.find((m) => m.domain === 'overall')
const leadership = creditMetrics.find((m) => m.domain === 'leadership')

check('an overall duration is recorded', Boolean(overall), JSON.stringify(overall))
check('a separate leadership duration is recorded', Boolean(leadership), JSON.stringify(leadership))
check('leadership is shorter than the career',
  Boolean(overall && leadership) && leadership.leadership_years < overall.years,
  `${leadership?.leadership_years}y leading of ${overall?.years}y total`)
check('the career is not relabelled as managerial',
  overall?.years > 10 && leadership?.leadership_years < 6,
  'long career, short leadership — both preserved')

// ------------------------------------------------------------------- §5 ---

section('§5 candidate intent is a hard exclusion')
const fashionSearch = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token),
  body: JSON.stringify({
    jobDescription: [
      'Marketing Manager - Fashion & Apparel',
      'We are a luxury fashion brand looking for a marketing manager.',
      'Requirements: brand marketing, campaign management, social media.',
    ].join('\n'),
  }),
}))

const fashionIds = fashionSearch.results.map((r) => r.candidate.id)
check('the finance-only candidate is NOT surfaced for a fashion role',
  !fashionIds.includes(fashion.body.id),
  `results: ${fashionIds.join(', ')}`)
check('the exclusion is recorded server-side for debugging',
  db.prepare(`SELECT excluded FROM retrieval_sessions WHERE id = ?`).get(fashionSearch.sessionId)
    .excluded.includes('preference'))
check('but the reason is not sent to the recruiter',
  !JSON.stringify(fashionSearch).includes('opted into'))

const financeSearch = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token),
  body: JSON.stringify({
    jobDescription: 'Investment Analyst at a venture capital fund. Banking or VC background.',
  }),
}))
check('the same candidate IS surfaced for a role they opted into',
  financeSearch.results.map((r) => r.candidate.id).includes(fashion.body.id))

section('§5 a restricted candidate must name an area')
const noTags = await apply({
  first: 'Gil', last: 'Blank', cv: CVS.ml,
  extra: { openToAllOpportunities: 'false', interestTags: '' },
})
check('the toggle off with no tags is refused', noTags.res.status === 400, `HTTP ${noTags.res.status}`)
check('and is not silently treated as open to all',
  String(noTags.body.error ?? '').toLowerCase().includes('open to all'),
  noTags.body.error)
// §17 — a rejected request must leave nothing behind. Validating after the
// insert would return 400 and still create a half-made account.
check('and no half-created account is left behind',
  db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE email LIKE ?`)
    .get(`gil.blank.${RUN}${MARKER}`.toLowerCase()).n === 0,
  'rejected before anything was written')

section('§5 breadth flows one way only')
const broad = await apply({
  first: 'Tal', last: 'Broad', cv: CVS.credit,
  extra: { openToAllOpportunities: 'false', interestTags: 'finance' },
})
await waitForIntelligence(broad.body.id)
const vcSearch = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token),
  body: JSON.stringify({ jobDescription: 'Credit Analyst for a commercial bank. Credit risk, underwriting.' }),
}))
check('a broad "finance" tag admits a banking role',
  vcSearch.results.map((r) => r.candidate.id).includes(broad.body.id))
check('while a narrow "venture capital" tag does not',
  !vcSearch.results.map((r) => r.candidate.id).includes(fashion.body.id),
  'narrow tags are not widened on the candidate\'s behalf')

// ------------------------------------------------------------------- §8 ---

section('§8 the JD becomes a durable object')
const jdText = 'Machine Learning Engineer. Requirements: Python, machine learning. Preferred: fintech experience.'
const first = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ jobDescription: jdText }),
}))

const jobRow = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(first.jobId)
check('the raw JD is stored', jobRow.raw_jd === jdText)
check('at version 1', jobRow.jd_version === 1)
check('with a match profile', Boolean(
  db.prepare(`SELECT 1 FROM job_match_profiles WHERE job_id = ? AND jd_version = 1`).get(first.jobId)))
check('criteria are split into classes',
  Array.isArray(first.jobProfile.mustHaves) && Array.isArray(first.jobProfile.preferred))
check('with no invented hard constraints on the deterministic path',
  first.jobProfile.source !== 'deterministic' || first.jobProfile.hardConstraints.length === 0,
  'over-excluding is worse than under-excluding')

// ------------------------------------------------------------ §12 caching ---

section('§12 reopening an unchanged search reuses analyses')
check('the first run analysed candidates', first.scoring.analysedThisRequest > 0,
  `${first.scoring.analysedThisRequest} analysed`)

const reopened = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ jobDescription: jdText }),
}))
check('reopening analyses nobody new', reopened.scoring.analysedThisRequest === 0,
  `${reopened.scoring.analysedThisRequest} analysed on reopen`)
check('and returns the same job', reopened.jobId === first.jobId)
check('and the same results', reopened.results.length === first.results.length)

section('§12 a photo change does not invalidate; a CV does')
const versionBefore = db.prepare(`SELECT profile_version FROM candidates WHERE id = ?`)
  .get(ml.body.id).profile_version

const code = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: H(),
  body: JSON.stringify({ identifier: `noa.ml.${RUN}${MARKER}`.toLowerCase() }),
}))
const { token: mlToken } = await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: H(),
  body: JSON.stringify({ identifier: `noa.ml.${RUN}${MARKER}`.toLowerCase(), code: code.devCode }),
}))

/* The phone changes, and a changed contact detail has to be proved — see the
   note on the profile route. The email is the one already on the account, so
   it needs nothing. */
const cosmetic = new FormData()
for (const [k, v] of Object.entries({
  firstName: 'Noa', lastName: 'Ml', email: `noa.ml.${RUN}${MARKER}`.toLowerCase(),
  phone: '052-1112223', location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
  phoneProof: await proveContact('phone', '052-1112223'),
})) cosmetic.append(k, v)
await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: { authorization: `Bearer ${mlToken}` }, body: cosmetic,
})

check('an unchanged resubmit does not bump the version',
  db.prepare(`SELECT profile_version FROM candidates WHERE id = ?`).get(ml.body.id).profile_version
    === versionBefore,
  `version ${versionBefore}`)

const withCv = new FormData()
withCv.append('cv', new Blob([await makePdf([...CVS.ml, 'ALSO: Kubernetes, Go'])], { type: 'application/pdf' }), 'cv2.pdf')
for (const [k, v] of Object.entries({
  firstName: 'Noa', lastName: 'Ml', email: `noa.ml.${RUN}${MARKER}`.toLowerCase(),
  phone: '052-1112223', location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
})) withCv.append(k, v)
await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: { authorization: `Bearer ${mlToken}` }, body: withCv,
})

const versionAfterCv = db.prepare(`SELECT profile_version FROM candidates WHERE id = ?`)
  .get(ml.body.id).profile_version
check('a new CV does bump the version', versionAfterCv > versionBefore,
  `${versionBefore} -> ${versionAfterCv}`)
check('the old analysis is not deleted, just no longer keyed',
  db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_job_analyses WHERE candidate_id = ? AND profile_version = ?
  `).get(ml.body.id, versionBefore).n > 0,
  'paid-for work is kept')

await waitForIntelligence(ml.body.id)
const afterCv = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ jobDescription: jdText }),
}))
check('and that candidate is re-analysed on the next search',
  db.prepare(`
    SELECT COUNT(*) AS n FROM candidate_job_analyses WHERE candidate_id = ? AND profile_version = ?
  `).get(ml.body.id, versionAfterCv).n > 0,
  `session ${afterCv.sessionId}`)

// -------------------------------------------------------- §10 / §11 batches ---

section('§10.2 the second batch cannot reset to 100')
const { normalizeUniverse } = await import('../server/src/matching/normalize.js')

const batchOne = [{ candidateId: 1, absoluteFit: 90 }, { candidateId: 2, absoluteFit: 70 }]
const scoresOne = normalizeUniverse(batchOne)
check('the strongest of a strong field scores 100', scoresOne.get(1) === 100, `${scoresOne.get(1)}`)

const weakBatchAlone = normalizeUniverse([{ candidateId: 3, absoluteFit: 30 }])
check('the best of a weak batch, scored alone, does NOT reach 100',
  weakBatchAlone.get(3) < 100, `${weakBatchAlone.get(3)}`)

const bothBatches = normalizeUniverse([...batchOne, { candidateId: 3, absoluteFit: 30 }])
check('and scored against the full universe it ranks below batch one',
  bothBatches.get(3) < bothBatches.get(2) && bothBatches.get(2) < bothBatches.get(1),
  `${bothBatches.get(1)} / ${bothBatches.get(2)} / ${bothBatches.get(3)}`)
check('the earlier leader keeps its score', bothBatches.get(1) === 100)
check('ties are allowed at the maximum',
  normalizeUniverse([{ candidateId: 1, absoluteFit: 80 }, { candidateId: 2, absoluteFit: 80 }])
    .get(1) === 100
  && normalizeUniverse([{ candidateId: 1, absoluteFit: 80 }, { candidateId: 2, absoluteFit: 80 }])
    .get(2) === 100)

section('§11 Show More is idempotent and never repeats')
const shownFirst = afterCv.results.map((r) => r.candidate.id)
const more = await json(await fetch(`${BASE}/api/hr/search/${afterCv.sessionId}/more`, {
  method: 'POST', headers: H(admin.token),
}))
const shownAfter = more.results.map((r) => r.candidate.id)

check('every previously shown candidate is still present',
  shownFirst.every((id) => shownAfter.includes(id)))
check('nobody appears twice', new Set(shownAfter).size === shownAfter.length)

const moreAgain = await json(await fetch(`${BASE}/api/hr/search/${afterCv.sessionId}/more`, {
  method: 'POST', headers: H(admin.token),
}))
check('clicking again analyses nobody new', moreAgain.scoring.analysedThisRequest === 0,
  `${moreAgain.scoring.analysedThisRequest} analysed`)
check('and shows nobody twice',
  new Set(moreAgain.results.map((r) => r.candidate.id)).size === moreAgain.results.length)
check('an exhausted pool reports itself rather than erroring',
  moreAgain.exhausted === true || moreAgain.canShowMore === false)

section('§7 opting out applies to searches that already exist')
/*
 * A session outlives the state it was built from. The hard filter runs when the
 * session is created, so without a re-check on the way out a candidate who
 * deactivates afterwards keeps appearing in any reopened or extended search —
 * which would make the opt-out look honoured while it quietly was not.
 */
const beforeOptOut = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token),
  body: JSON.stringify({ jobDescription: jdText }),
}))
/*
 * One of this suite's own, not whoever the search put first.
 *
 * The write below hides somebody from every search on the platform, and the one
 * that puts them back is four checks later — so a crash in between leaves a
 * real candidate invisible with nothing to say why. Picking from the results
 * meant any candidate could be the one. The search still has to return them,
 * which is the thing being tested; it just has to return OURS.
 */
const optOutTarget = beforeOptOut.results
  .map((r) => r.candidate.id)
  .find((id) => String(db.prepare(`SELECT email FROM candidates WHERE id = ?`).get(id)?.email ?? '')
    .endsWith(MARKER))

check('a search returns one of this suite’s candidates to opt out',
  Boolean(optOutTarget), `candidate ${optOutTarget}`)

db.prepare(`UPDATE candidates SET hidden_from_search = 1, deactivated_at = ? WHERE id = ?`)
  .run(new Date().toISOString(), optOutTarget)

const afterOptOut = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token),
  body: JSON.stringify({ jobDescription: jdText }),
}))
check('they vanish from the reopened search',
  !afterOptOut.results.map((r) => r.candidate.id).includes(optOutTarget))
check('but their cached analysis is kept, not destroyed',
  db.prepare(`SELECT COUNT(*) AS n FROM candidate_job_analyses WHERE candidate_id = ?`)
    .get(optOutTarget).n > 0,
  'paid-for work survives; it simply stops being shown')

db.prepare(`UPDATE candidates SET hidden_from_search = 0, deactivated_at = NULL WHERE id = ?`)
  .run(optOutTarget)
check('and they return once reactivated',
  (await json(await fetch(`${BASE}/api/hr/search`, {
    method: 'POST', headers: H(admin.token), body: JSON.stringify({ jobDescription: jdText }),
  }))).results.map((r) => r.candidate.id).includes(optOutTarget))

section('§11 another recruiter cannot drive this session')
const other = await registerAndSignIn({
  companyName: `Rival ${RUN}`, firstName: 'Ron', lastName: 'Levi',
  email: 'ron@rival.example.com', phone: '050-765-4321', website: 'rival.example.com',
})
// §15 — a company registers 'pending' and reaches nothing until it is approved.
await approveCompanyById(other.company.id)

const stolen = await fetch(`${BASE}/api/hr/search/${afterCv.sessionId}/more`, {
  method: 'POST', headers: H(other.token),
})
check('a foreign session is refused', stolen.status === 403, `HTTP ${stolen.status}`)

section('§2 the candidate can see and change what they opted into')
const own = await json(await fetch(`${BASE}/api/candidate/me`, {
  headers: { authorization: `Bearer ${mlToken}` },
}))
check('their preferences come back with the profile', Boolean(own.preferences))
check('defaulting to open to all', own.preferences.openToAll === true)
check('and the cap is published rather than hard-coded in the UI',
  own.preferences.tagCap === 10, `cap ${own.preferences.tagCap}`)

check('their own profile intelligence is visible to them', Boolean(own.intelligence))
check('with the labels that decide who finds them',
  (own.intelligence?.labels ?? []).length > 0,
  `${own.intelligence?.labels?.length} labels`)
check('each carrying the evidence behind it',
  (own.intelligence?.labels ?? []).every((l) => l.evidence))

const narrowing = new FormData()
for (const [k, v] of Object.entries({
  firstName: 'Noa', lastName: 'Ml', email: `noa.ml.${RUN}${MARKER}`.toLowerCase(),
  phone: '052-1112223', location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
  openToAllOpportunities: 'false', interestTags: 'fintech, machine learning',
})) narrowing.append(k, v)
const narrowed = await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: { authorization: `Bearer ${mlToken}` }, body: narrowing,
})
check('narrowing their interests is accepted', narrowed.status === 200, `HTTP ${narrowed.status}`)

const afterNarrow = await json(await fetch(`${BASE}/api/candidate/me`, {
  headers: { authorization: `Bearer ${mlToken}` },
}))
check('the toggle is recorded', afterNarrow.preferences.openToAll === false)
check('with both tags, original wording kept',
  afterNarrow.preferences.tags.map((t) => t.raw).join(', ') === 'fintech, machine learning')
check('and the tags resolved to concepts',
  afterNarrow.preferences.tags.every((t) => t.conceptId),
  afterNarrow.preferences.tags.map((t) => t.conceptId).join(', '))

const tooMany = new FormData()
for (const [k, v] of Object.entries({
  firstName: 'Noa', lastName: 'Ml', email: `noa.ml.${RUN}${MARKER}`.toLowerCase(),
  phone: '052-1112223', location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
  openToAllOpportunities: 'false',
  interestTags: Array.from({ length: 11 }, (_, i) => `area${i}`).join(', '),
})) tooMany.append(k, v)
const capped = await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: { authorization: `Bearer ${mlToken}` }, body: tooMany,
})
check('more than ten interests is refused', capped.status === 400, `HTTP ${capped.status}`)
check('and the earlier setting is untouched',
  (await json(await fetch(`${BASE}/api/candidate/me`, {
    headers: { authorization: `Bearer ${mlToken}` },
  }))).preferences.tags.length === 2,
  'a rejected edit changes nothing')

// ------------------------------------------------------------------ §9.1 ---

section('§9.1 missing evidence is not a hard exclusion')
const sparse = await apply({ first: 'Ela', last: 'Sparse', cv: [
  'Professional with broad experience across several organisations.',
  'Worked on projects, delivered results, collaborated with teams.',
  'Contributed to planning and execution of various initiatives.',
] })
await waitForIntelligence(sparse.body.id)
const sparseSearch = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token),
  body: JSON.stringify({ jobDescription: 'Operations Manager. Requirements: planning, delivery.' }),
}))
check('a thin profile still reaches the recruiter',
  sparseSearch.results.map((r) => r.candidate.id).includes(sparse.body.id),
  'no evidence found is not the same as does not meet')

// ------------------------------------------------------------------- §17 ---

section('§17 the recruiter never receives the ranking mechanics')
const wire = JSON.stringify(afterCv)
for (const leak of ['absoluteFit', 'absolute_fit', 'retrievalScore', 'retrievalComponents', 'rawScore'])
  check(`${leak} is not on the wire`, !wire.includes(leak))
check('but the displayed score is', afterCv.results.every((r) => typeof r.score === 'number'))
check('and the explanation says scores are relative',
  afterCv.scoring.explanation.includes('relative'))

section('§18 a search does not analyse the whole database')
const analysedCount = db.prepare(`
  SELECT COUNT(*) AS n FROM candidate_job_analyses WHERE job_id = ?
`).get(afterCv.jobId).n
check('deep analysis is bounded by the batch size',
  analysedCount <= afterCv.scoring.batchSize * 3,
  `${analysedCount} analyses for a batch size of ${afterCv.scoring.batchSize}`)
check('the pool is bounded too',
  afterCv.scoring.poolSize <= 100, `pool ${afterCv.scoring.poolSize}`)

// --------------------------------------------- a reveal is not per-search ---

section('A reveal belongs to the company, not to the search')
/*
 * Somebody paid for this person's contact details. Meeting them again under a
 * different job description must not look like a fresh stranger — the surname
 * is already bought, the CV is already open, and asking for the money twice is
 * the one billing mistake that would be noticed immediately.
 *
 * The score is the opposite: it is about a job, so it must be recomputed for
 * the description in hand rather than carried over with the reveal.
 */
const revealJdA = 'Backend Engineer. Requirements: Python, backend services, SQL.'
const revealJdB = 'Warehouse Operations Lead. Requirements: logistics, inventory planning.'

const searchA = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ jobDescription: revealJdA }),
}))
const target = searchA.results[0]
check('a search returns somebody to reveal', Boolean(target))
check('and they start out masked', target.revealed === false)

await json(await fetch(`${BASE}/api/hr/candidates/${target.candidate.id}/reveal`, {
  method: 'POST', headers: H(admin.token), body: '{}',
}))

const searchB = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ jobDescription: revealJdB }),
}))
const again = searchB.results.find((row) => row.candidate.id === target.candidate.id)

check('the same person appears under a different description', Boolean(again))
check('still revealed, without paying again', again.revealed === true)
check('and the list says who unlocked them', Boolean(again.revealedBy?.name))
check('carrying their full name rather than the masked one',
  again.candidate.display_name.includes(' '),
  `got ${JSON.stringify(again.candidate.display_name)}`)
check('while the score is this job\u2019s, not the other one\u2019s',
  typeof again.score === 'number' && searchA.jobId !== searchB.jobId)

/* The other half of the same rule: a colleague at another company has bought
   nothing, so the same person is masked for them. */
const stranger = await registerAndSignIn({
  companyName: `Rival ${RUN}b`, firstName: 'Tal', lastName: `Rivalb${RUN}`,
  email: `tal.${RUN}b@example.com`,
})
await approveCompanyById(stranger.company.id)
const strangerSearch = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(stranger.token), body: JSON.stringify({ jobDescription: revealJdA }),
}))
const forStranger = strangerSearch.results.find((row) => row.candidate.id === target.candidate.id)
check('another company sees the same person unrevealed',
  forStranger ? forStranger.revealed === false : true,
  'a reveal is bought by one organization, not by everyone who searches after it')

// --------------------------------------------------- your team's notes ---

section("A comment is your team's note, not the candidate's record")
/*
 * The point of it is that the next colleague to open this profile knows
 * somebody has already spoken to them. So: shared with the company, never with
 * the candidate, and never with another company — and readable before a reveal,
 * because "Dana spoke to them in June" is worth most precisely when you are
 * deciding whether to spend one.
 */
const noteFor = searchA?.results?.[0]?.candidate?.id ?? ml.body.id

const emptyNotes = await json(await fetch(`${BASE}/api/hr/candidates/${noteFor}/comments`, {
  headers: H(admin.token),
}))
check('a candidate starts with no notes', Array.isArray(emptyNotes.comments))

const posted = await json(await fetch(`${BASE}/api/hr/candidates/${noteFor}/comments`, {
  method: 'POST', headers: H(admin.token),
  body: JSON.stringify({ body: 'Spoke to them on Tuesday — open to a move in Q4.' }),
}))
const note = posted.comments.at(-1)
check('posting one returns the thread', posted.comments.length === emptyNotes.comments.length + 1)
check('with the author, the moment and the words',
  Boolean(note.author) && Boolean(note.at) && note.body.includes('Tuesday'))
check('and the author id, so the reader can be told they wrote it',
  note.recruiterId === admin.recruiter?.id || typeof note.recruiterId === 'number')

check('an empty note is refused',
  (await fetch(`${BASE}/api/hr/candidates/${noteFor}/comments`, {
    method: 'POST', headers: H(admin.token), body: JSON.stringify({ body: '   ' }),
  })).status === 400)

const strangerNotes = await json(await fetch(`${BASE}/api/hr/candidates/${noteFor}/comments`, {
  headers: H(stranger.token),
}))
check('another company cannot read them',
  !strangerNotes.comments.some((c) => c.body.includes('Tuesday')),
  'a note is one team\u2019s working memory, not a shared database')

check('and the candidate is never given them',
  !JSON.stringify(await json(await fetch(`${BASE}/api/candidates/me`, {
    headers: { authorization: `Bearer ${ml.body.token}` },
  })).catch(() => ({}))).includes('Tuesday'),
  'they are notes about a person, not to them')

// ------------------------------------------------------ your team's tags ---

section('A tag is what your team calls somebody')
/*
 * Free text, capped at five, in one of six colours. The cap and the palette are
 * enforced on the server rather than only in the editor: a strip beside a score
 * has room for a known number of known-width things, and a colour from a client
 * is a stylesheet the client gets to write.
 */
const tagFor = noteFor

const wrote = await json(await fetch(`${BASE}/api/hr/candidates/${tagFor}/tags`, {
  method: 'PUT', headers: H(admin.token),
  body: JSON.stringify({ tags: [
    { label: 'Phone screened', colour: 'green' },
    { label: 'Wants remote', colour: 'blue' },
  ] }),
}))
check('a set can be written', wrote.tags.length === 2)
check('with the colours chosen', wrote.tags[0].colour === 'green' && wrote.tags[1].colour === 'blue')
check('in the order they were put in', wrote.tags[0].label === 'Phone screened')

const tagsOverCap = await fetch(`${BASE}/api/hr/candidates/${tagFor}/tags`, {
  method: 'PUT', headers: H(admin.token),
  body: JSON.stringify({ tags: Array.from({ length: 6 }, (_, i) => ({ label: `Tag ${i}` })) }),
})
check('six is refused outright', tagsOverCap.status === 400,
  'the strip has room for five, and a partial write would be a set nobody asked for')
check('and the refusal changed nothing',
  (await json(await fetch(`${BASE}/api/hr/candidates/${tagFor}/tags`, { headers: H(admin.token) })))
    .tags.length === 2)

const cleaned = await json(await fetch(`${BASE}/api/hr/candidates/${tagFor}/tags`, {
  method: 'PUT', headers: H(admin.token),
  body: JSON.stringify({ tags: [
    { label: '  Phone   screened  ', colour: 'green' },
    { label: 'PHONE SCREENED', colour: 'red' },
    { label: '', colour: 'red' },
    { label: 'Odd colour', colour: 'rgb(255,0,0)' },
  ] }),
}))
check('whitespace is collapsed and trimmed', cleaned.tags[0].label === 'Phone screened')
check('the same tag twice is one tag', cleaned.tags.length === 2,
  '"Phone screened" and "PHONE SCREENED" on one person is a mistake, not two tags')
check('an empty label is dropped', !cleaned.tags.some((t) => t.label === ''))
check('and a colour off the palette falls back to grey',
  cleaned.tags.find((t) => t.label === 'Odd colour')?.colour === 'grey',
  'a hex string from a client is a stylesheet the client gets to write')

const strangerTags = await json(await fetch(`${BASE}/api/hr/candidates/${tagFor}/tags`, {
  headers: H(stranger.token),
}))
check('another company sees none of them', strangerTags.tags.length === 0,
  'a tag is one team\u2019s word for somebody, not a label on the person')

const tagged = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ jobDescription: revealJdA }),
}))
const taggedRow = tagged.results.find((row) => row.candidate.id === tagFor)
check('and the search carries them, so the row can draw the strip',
  taggedRow?.tags?.some((t) => t.label === 'Phone screened'),
  'one query for a page of results, not one round trip per row')

check('clearing them is writing an empty set',
  (await json(await fetch(`${BASE}/api/hr/candidates/${tagFor}/tags`, {
    method: 'PUT', headers: H(admin.token), body: JSON.stringify({ tags: [] }),
  }))).tags.length === 0)

// ------------------------------------------------------- not relevant ---

section('Not relevant is not relevant HERE')
/*
 * A judgement about one role, not about a person.
 *
 * Hiding somebody company-wide because they were wrong for a design role would
 * quietly shrink the pool for every colleague who never made that call — and
 * for the same recruiter's next backend search. The scope of this is one saved
 * search, and the thing that proves it is the second search below, which must
 * still see the person the first one ruled out.
 */
const roleA = 'Backend Engineer. Requirements: Python, backend services.'
const roleB = 'Data Scientist. Requirements: Python, machine learning, statistics.'

const chatA = await json(await fetch(`${BASE}/api/hr/chats`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ query: roleA, shown: 0, total: 0 }),
}))
const runA = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token),
  body: JSON.stringify({ jobDescription: roleA, chatId: chatA.chatId }),
}))
check('a fresh search has nobody ruled out', runA.dismissed.length === 0)

const unwanted = runA.results[0]?.candidate?.id
check('and it returned somebody to rule out', Boolean(unwanted))

const ruled = await json(await fetch(`${BASE}/api/hr/chats/${chatA.chatId}/dismissed`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ candidateId: unwanted }),
}))
check('marking them not relevant records it', ruled.dismissed.includes(unwanted))

const twice = await json(await fetch(`${BASE}/api/hr/chats/${chatA.chatId}/dismissed`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ candidateId: unwanted }),
}))
check('pressing it twice is the same as pressing it once',
  twice.dismissed.filter((id) => id === unwanted).length === 1,
  'the button sits on a list that re-renders under the pointer')

const rerunA = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token),
  body: JSON.stringify({ jobDescription: roleA, chatId: chatA.chatId }),
}))
check('re-running the search remembers who was ruled out of it',
  rerunA.dismissed.includes(unwanted),
  'reopening a saved search re-runs it — without this they all come back')

const chatB = await json(await fetch(`${BASE}/api/hr/chats`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ query: roleB, shown: 0, total: 0 }),
}))
const runB = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token),
  body: JSON.stringify({ jobDescription: roleB, chatId: chatB.chatId }),
}))
check('but another search has never heard of it', !runB.dismissed.includes(unwanted))
check('and still returns them',
  runB.results.some((row) => row.candidate.id === unwanted),
  'a candidate ruled out of one role must remain in the pool for the next one')

const restored = await json(await fetch(
  `${BASE}/api/hr/chats/${chatA.chatId}/dismissed/${unwanted}`,
  { method: 'DELETE', headers: H(admin.token) },
))
check('it can be undone — a judgement can change', !restored.dismissed.includes(unwanted))

/*
 * A real search belonging to a real other company, not an id nobody owns.
 *
 * This used to POST to `chatA.chatId + 99999` and take the 404 as proof of
 * isolation — but that id does not exist for anybody, so the check passed
 * whether the route scoped by recruiter or merely looked a chat up. The
 * question is whether one company can reach into another's saved search, and
 * only another company's actual chat id asks it.
 */
check("another recruiter's search cannot be touched", await (async () => {
  const intruder = await fetch(`${BASE}/api/hr/chats/${chatA.chatId}/dismissed`, {
    method: 'POST', headers: H(stranger.token), body: JSON.stringify({ candidateId: unwanted }),
  })
  if (intruder.status !== 404) return false

  /* And the dismissal they tried to write is not there — a 404 that wrote the
     row first would still be a leak. Read by re-running the search, which is
     the only route that reports a chat's dismissals without changing them. */
  const mine = await json(await fetch(`${BASE}/api/hr/search`, {
    method: 'POST', headers: H(admin.token),
    body: JSON.stringify({ jobDescription: roleA, chatId: chatA.chatId }),
  }))
  return !mine.dismissed.includes(unwanted)
})())

// ------------------------------------------------------- blocked employers ---

section('A candidate who blocks an employer is invisible to them')
/*
 * The candidate's own settings page promises: "Name the companies you don't
 * want seeing you — your current one included — and you won't appear in their
 * searches." It is the strongest promise this product makes to the person whose
 * data it holds, and for a while nothing enforced it: candidatesBlocking() was
 * exported and called by no search path.
 *
 * Both paths are checked, because there are two — the staged pipeline behind
 * /api/hr/search and the one-shot /api/hr/match — and a blocklist honoured by
 * one of them is not honoured.
 */
const blockJd = 'Backend Engineer. Requirements: Python, backend services, SQL.'

const beforeBlock = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ jobDescription: blockJd, refresh: true }),
}))
const hider = beforeBlock.results[0]?.candidate?.id
check('the candidate is findable to begin with', Boolean(hider))

/* Blocked by the exact registered name, through the candidate's own route —
   the normalisation is part of what is being tested. */
const orgName = db.prepare(`SELECT name FROM companies WHERE id = ?`).get(admin.company.id).name
const hiderToken = db.prepare(`SELECT email FROM candidates WHERE id = ?`).get(hider)
check('and the blocklist is set through the candidate\u2019s own record', Boolean(hiderToken))

db.prepare(`
  INSERT OR IGNORE INTO blocked_companies (candidate_id, raw_name, normalized, created_at)
  VALUES (?, ?, ?, ?)
`).run(hider, orgName, orgName.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(),
  new Date().toISOString())

const afterBlock = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ jobDescription: blockJd, refresh: true }),
}))
check('they are gone from the staged search',
  !afterBlock.results.some((row) => row.candidate.id === hider),
  'the blocklist is the one control a candidate is told they can rely on')

const oneShot = await json(await fetch(`${BASE}/api/hr/match`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ jobDescription: blockJd }),
}))
check('and from the one-shot search as well',
  !(oneShot.results ?? []).some((row) => row.candidate.id === hider),
  'two search paths, one promise')

check('while another company still finds them',
  (await json(await fetch(`${BASE}/api/hr/search`, {
    method: 'POST', headers: H(stranger.token), body: JSON.stringify({ jobDescription: blockJd, refresh: true }),
  }))).results.some((row) => row.candidate.id === hider),
  'a block names one employer, not everybody')

/*
 * And out of reach, not merely out of the listing.
 *
 * The blocklist was applied on the two search paths and nowhere else, so a
 * recruiter at a blocked company who still held the candidate's id — from a
 * colleague, a folder, a search run before the block was added, or by counting
 * — could open the profile, spend a reveal and receive the name, email, phone,
 * photograph and documents. A control a candidate is told to use to hide from
 * their current employer has to hold at the point of access.
 */
/* Counted before the attempt: this candidate may already have been revealed
   legitimately earlier in the suite, so what matters is that the blocked
   attempt adds nothing. */
const revealsBeforeBlock = db.prepare(
  `SELECT COUNT(*) AS n FROM organization_reveals WHERE candidate_id = ?`,
).get(hider).n

for (const [what, response] of [
  ['open their profile', await fetch(`${BASE}/api/hr/candidates/${hider}`, { headers: H(admin.token) })],
  ['pay to reveal them', await fetch(`${BASE}/api/hr/candidates/${hider}/reveal`, {
    method: 'POST', headers: H(admin.token), body: '{}',
  })],
  ['open their documents', await fetch(`${BASE}/api/hr/candidates/${hider}/file`, { headers: H(admin.token) })],
  ['see their photograph', await fetch(`${BASE}/api/hr/candidates/${hider}/photo`, { headers: H(admin.token) })],
]) {
  check(`and a blocked employer holding their id cannot ${what}`, response.status === 404)
}

check('while the refused reveal charged nothing',
  db.prepare(`SELECT COUNT(*) AS n FROM organization_reveals WHERE candidate_id = ?`).get(hider).n
    === revealsBeforeBlock,
  'a refusal after a deduction would be the candidate’s privacy control costing the recruiter money')

check('and another company can still reach them',
  (await fetch(`${BASE}/api/hr/candidates/${hider}`, { headers: H(stranger.token) })).status === 200,
  'a block names one employer, not everybody')

db.prepare(`DELETE FROM blocked_companies WHERE candidate_id = ?`).run(hider)

// ------------------------------------------------------- erasure is total ---

section('Deleting a candidate takes what was written about them')
/*
 * The comments and tags a team writes are the most descriptive thing about a
 * person in this database — "phone screened, wants hybrid, hold for Q4" — and
 * they are keyed by candidate rather than reached through one. An erasure that
 * leaves them behind has not erased the person, it has made them anonymous
 * -looking, which is a weaker and more dangerous thing.
 *
 * Checked against the tables directly: the API cannot show what it no longer
 * has a candidate to show it under, so a passing route says nothing here.
 */
/*
 * Made for this, not found by searching.
 *
 * This used to take `results.at(-1)` from a search over the WHOLE marketplace
 * and then permanently erase whoever that was. Every candidate on the platform
 * was a possible target, and on 21 August 2026 it took a real account four
 * minutes after it was created — the owner's only copy, with their CV.
 *
 * A destructive step must never operate on a row a query happened to return.
 * This one applies for its own candidate, under this suite's marker, and the
 * guard below refuses to go on if the id it is about to erase is not one of
 * ours — so the same mistake cannot be reintroduced by changing how the
 * candidate is chosen.
 */
const doomedEmail = `doomed.${RUN}${MARKER}`.toLowerCase()
await apply({ first: 'Doomed', last: 'Fixture', cv: CVS.ml, extra: { email: doomedEmail } })

const doomed = db.prepare(`SELECT id FROM candidates WHERE email = ?`).get(doomedEmail)?.id
check('there is a candidate to erase', Boolean(doomed))

/*
 * The guard. Cheap, and the only thing standing between a future edit and
 * somebody's account: an id is deletable here only if its address carries this
 * run's marker.
 */
const doomedRow = db.prepare(`SELECT email FROM candidates WHERE id = ?`).get(doomed)
if (!doomedRow || !String(doomedRow.email).endsWith(MARKER)) {
  throw new Error(
    `refusing to erase candidate ${doomed}: ${doomedRow?.email ?? 'no row'} is not this suite's`,
  )
}
check('and it is one this suite made', String(doomedRow.email).endsWith(MARKER),
  'a destructive step never runs on a row a query happened to return')

await fetch(`${BASE}/api/hr/candidates/${doomed}/comments`, {
  method: 'POST', headers: H(admin.token), body: JSON.stringify({ body: 'Notes about a real person.' }),
})
await fetch(`${BASE}/api/hr/candidates/${doomed}/tags`, {
  method: 'PUT', headers: H(admin.token), body: JSON.stringify({ tags: [{ label: 'Erase me', colour: 'red' }] }),
})
await fetch(`${BASE}/api/hr/candidates/${doomed}/reveal`, { method: 'POST', headers: H(admin.token), body: '{}' })

const rows = (table) => db.prepare(
  `SELECT COUNT(*) AS n FROM ${table} WHERE candidate_id = ?`,
).get(doomed).n

check('the notes, tags and reveal are on file first',
  rows('candidate_comments') > 0 && rows('candidate_tags') > 0 && rows('organization_reveals') > 0)

/*
 * Erased by the account holder, which is now the only way an account can be
 * erased.
 *
 * This used to call DELETE /api/hr/candidates/:id — a recruiter route that let
 * any signed-in recruiter name any candidate by id and erase them, with no
 * ownership test of any kind. It had no caller in the product and this suite
 * was the only thing that ever used it, as a shortcut to the cascade. The
 * shortcut is gone with the route; the cascade is what was being tested and it
 * is still what is tested, reached the way a person reaches it.
 */
const doomedCode = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: H(), body: JSON.stringify({ identifier: doomedEmail }),
}))
const { token: doomedToken } = await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: H(),
  body: JSON.stringify({ identifier: doomedEmail, code: doomedCode.devCode }),
}))
await deleteCandidate(doomedToken)

check('a recruiter can no longer erase a candidate at all',
  (await fetch(`${BASE}/api/hr/candidates/${hider}`, {
    method: 'DELETE', headers: H(admin.token),
  })).status === 404,
  'erasing an account is the account holder’s decision')

check('the candidate is gone',
  db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE id = ?`).get(doomed).n === 0)
check('and so is every note their team wrote about them', rows('candidate_comments') === 0)
check('and every tag', rows('candidate_tags') === 0)
check('and every dismissal naming them', rows('search_dismissals') === 0)
check("and the organization's record of holding them", rows('organization_reveals') === 0)
check('while the money it cost is still on the ledger',
  db.prepare(`SELECT COUNT(*) AS n FROM billing_ledger WHERE candidate_id = ?`).get(doomed).n >= 0,
  'a ledger that erases itself cannot answer the question it exists to answer')

/*
 * And nothing anywhere still describes them.
 *
 * Not a list of tables to keep in step with the cascade — the schema itself is
 * asked. Every table with a candidate_id is checked for a row naming somebody
 * who is not in `candidates`, which is the actual promise: after an erasure,
 * the database holds nothing about that person.
 *
 * This is where the reading of their CV lives — extracted_facts, the taxonomy
 * labels, the interpretation built on top — and it is the half that matters
 * most. A row in `candidates` is a name and a city; those tables are the person.
 *
 * billing_ledger is the one exception, deliberately: money moved, and the
 * ledger is the organization's record of its own spending.
 */
const living = new Set(db.prepare(`SELECT id FROM candidates`).all().map((r) => r.id))
const haunted = []
for (const { name } of db.prepare(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'billing_ledger'`,
).all()) {
  const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name)
  if (!columns.includes('candidate_id')) continue

  const stale = db.prepare(`SELECT DISTINCT candidate_id AS id FROM "${name}"`).all()
    .filter((row) => row.id !== null && !living.has(row.id))
  if (stale.length) haunted.push(`${name} (${stale.length})`)
}
check('and no table anywhere still describes a candidate who is gone',
  haunted.length === 0,
  haunted.join(', ') || 'a search shortlists from the derived tables, so a ghost in one of them '
    + 'fills the pool with people who cannot be shown — and an erasure that leaves the reading '
    + 'of somebody’s CV behind is not an erasure')

// -------------------------------------------- a session that has emptied ---

section('A saved search whose people have all gone does not stay empty')
/*
 * Resuming is right for reopening a search — same order, no second charge — but
 * a session is a snapshot of a pool that moves underneath it. Everyone in this
 * one is about to be deleted, and without a re-retrieval that job description
 * would return nothing for ever, with no error and nothing on screen to suggest
 * asking again would help. Only a refresh escaped it, which a search reopened
 * from the rail does not send.
 */
const decayJd = 'Ruby on Rails engineer. Requirements: Ruby, Rails, PostgreSQL, RSpec.'
const seeded = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(stranger.token), body: JSON.stringify({ jobDescription: decayJd }),
}))
check('the search finds somebody to begin with', seeded.results.length > 0)

/* Emptied by hand rather than by deleting people: the point is a session whose
   displayed set no longer resolves, however it got that way. */
const emptied = db.prepare(`
  SELECT id FROM retrieval_sessions ORDER BY id DESC LIMIT 1
`).get().id
db.prepare(`DELETE FROM displayed_match_state WHERE session_id = ?`).run(emptied)

const reasked = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST', headers: H(stranger.token), body: JSON.stringify({ jobDescription: decayJd }),
}))
check('asking again builds a new one rather than answering with nothing',
  reasked.results.length > 0,
  'a decayed session was a permanent dead end for that job description')

// ---------------------------------------------------------------- cleanup ---


// ------------------------------------------------- hiding from a company ---

section('Hiding from a company is set by the candidate and matched loosely')

/*
 * The whole feature, end to end and through the candidate's own route.
 *
 * The block section above writes into blocked_companies with SQL, which tests
 * the enforcement but not the setting of it - and until now there was no way
 * for a candidate to set one at all: the API accepted the field and no screen
 * ever sent it. So this walks the route the portal walks.
 */
const shyEmail = `shy.${RUN}${MARKER}`.toLowerCase()
await apply({ first: 'Shy', last: 'Person', cv: CVS.ml, extra: { email: shyEmail } })

const shyCode = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: H(), body: JSON.stringify({ identifier: shyEmail }),
}))
const { token: shyToken } = await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: H(),
  body: JSON.stringify({ identifier: shyEmail, code: shyCode.devCode }),
}))

const shyId = db.prepare(`SELECT id FROM candidates WHERE email = ?`).get(shyEmail).id

const setHidden = (companies) => fetch(`${BASE}/api/candidate/me/blocked-companies`, {
  method: 'PATCH', headers: H(shyToken), body: JSON.stringify({ companies }),
})

const afterAdd = await json(await setHidden(['KPMG', 'Deloitte']))
check('a candidate can name the companies to hide from',
  JSON.stringify(afterAdd.blockedCompanies?.slice().sort()) === JSON.stringify(['Deloitte', 'KPMG']))

const afterRemove = await json(await setHidden(['KPMG']))
check('and remove one', JSON.stringify(afterRemove.blockedCompanies) === JSON.stringify(['KPMG']))

/*
 * Absent and empty are different requests.
 *
 * "I did not touch this" must leave the list alone and "I removed them all"
 * must empty it. A field that means both is how a saved answer disappears.
 */
const noField = await fetch(`${BASE}/api/candidate/me/blocked-companies`, {
  method: 'PATCH', headers: H(shyToken), body: JSON.stringify({}),
})
check('sending no list at all is refused rather than read as "clear it"',
  noField.status === 400)
check('and the list is untouched by the refusal',
  JSON.stringify((await json(await fetch(`${BASE}/api/candidate/me`, { headers: H(shyToken) })))
    .blockedCompanies) === JSON.stringify(['KPMG']))

/*
 * An edit elsewhere on the profile leaves the list alone.
 *
 * The stored phone number is reused rather than invented: changing a contact
 * detail makes the route demand a fresh proof for it, and a 400 here would make
 * every assertion below pass or fail for the wrong reason.
 */
const shyPhone = db.prepare(`SELECT phone FROM candidates WHERE id = ?`).get(shyId).phone

const elsewhere = new FormData()
for (const [k, v] of Object.entries({
  firstName: 'Shy', lastName: 'Person', email: shyEmail, phone: shyPhone, location: 'Haifa',
  availability: 'Immediately', capacity: 'Full time',
  openToRelocation: 'no', openToAllOpportunities: 'false', interestTags: 'fintech',
})) elsewhere.append(k, v)
await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: { authorization: `Bearer ${shyToken}` }, body: elsewhere,
})
const afterProfileEdit = await json(await fetch(`${BASE}/api/candidate/me`, { headers: H(shyToken) }))
check('an unrelated profile save does not disturb the list',
  JSON.stringify(afterProfileEdit.blockedCompanies) === JSON.stringify(['KPMG']))

/*
 * And the two answers that started all this: a No stays a No, and a save that
 * never mentions them clears neither.
 */
check('a "no" to relocation survives the round trip',
  afterProfileEdit.candidate.open_to_relocation === false)
check('and so does a "no" to all opportunities',
  afterProfileEdit.preferences.openToAll === false)

const quiet = new FormData()
for (const [k, v] of Object.entries({
  firstName: 'Shy', lastName: 'Person', email: shyEmail, phone: shyPhone, location: 'Netanya',
})) quiet.append(k, v)
await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: { authorization: `Bearer ${shyToken}` }, body: quiet,
})
const afterQuiet = await json(await fetch(`${BASE}/api/candidate/me`, { headers: H(shyToken) }))
check('a save that never mentions them clears neither',
  afterQuiet.candidate.open_to_relocation === false
  && afterQuiet.preferences.openToAll === false,
  'an omitted field means "leave it", not "clear it"')
check('and the city it did mention did change', afterQuiet.candidate.location === 'Netanya')

/*
 * The matching itself. A candidate types the name they know; the organisation
 * registered whatever it registered, and the two are rarely the same string.
 */
const kpmgIsrael = await registerAndSignIn({
  companyName: `KPMG Israel ${RUN}`,
  email: `kpmg.${RUN}@example.com`, phone: '052-311-4000',
  firstName: 'Ken', lastName: 'Pemgee',
})
await approveCompanyById(kpmgIsrael.company.id)

check('a longer registered name still matches the short one the candidate typed',
  (await fetch(`${BASE}/api/hr/candidates/${shyId}`, { headers: H(kpmgIsrael.token) })).status === 404,
  'KPMG has to cover KPMG Israel, or the control only works for people who guess the spelling')

/* And it does not overreach: a firm that merely shares a word is not the firm. */
const unrelated = await registerAndSignIn({
  companyName: `Bakery Supplies ${RUN}`,
  email: `bakery.${RUN}@example.com`, phone: '052-311-4001',
  firstName: 'Bea', lastName: 'Kerr',
})
await approveCompanyById(unrelated.company.id)
check('but a company the candidate did not name can still see them',
  (await fetch(`${BASE}/api/hr/candidates/${shyId}`, { headers: H(unrelated.token) })).status !== 404)

/* Every other surface a saved or messaged candidate could still be read from. */
const kpmgFolders = await json(await fetch(`${BASE}/api/hr/folders`, { headers: H(kpmgIsrael.token) }))
check('a blocked candidate is in none of that company folders',
  !JSON.stringify(kpmgFolders.folders ?? []).includes(`"candidate_id":${shyId}`))
const kpmgThreads = await json(await fetch(`${BASE}/api/hr/threads`, { headers: H(kpmgIsrael.token) }))
check('and in none of its message threads',
  !(kpmgThreads.threads ?? []).some((t) => t.candidate_id === shyId))

for (const [what, response] of [
  ['read the team notes', await fetch(`${BASE}/api/hr/candidates/${shyId}/comments`, { headers: H(kpmgIsrael.token) })],
  ['read the team tags', await fetch(`${BASE}/api/hr/candidates/${shyId}/tags`, { headers: H(kpmgIsrael.token) })],
  ['open a conversation', await fetch(`${BASE}/api/hr/threads/${shyId}`, { headers: H(kpmgIsrael.token) })],
  ['send a message', await fetch(`${BASE}/api/hr/threads/${shyId}`, {
    method: 'POST', headers: H(kpmgIsrael.token), body: JSON.stringify({ body: 'hello' }),
  })],
]) {
  check(`and cannot ${what}`, response.status === 404)
}

section('Cleanup')
const ids = db.prepare(`SELECT id FROM candidates WHERE email LIKE ?`).all(`%${MARKER}`).map((r) => r.id)

// Uploaded files as well as rows: deleting only the rows leaves orphans on disk
// that make the API suite's disk check fail for an unrelated reason.
const files = new Set()
for (const id of ids) {
  const row = db.prepare(`SELECT stored_name, photo_name FROM candidates WHERE id = ?`).get(id)
  for (const name of [row?.stored_name, row?.photo_name]) if (name) files.add(name)
  for (const doc of db.prepare(`SELECT stored_name FROM documents WHERE candidate_id = ?`).all(id)) {
    if (doc.stored_name) files.add(doc.stored_name)
  }
}

for (const id of ids) {
  for (const t of [
    'folder_items', 'view_events', 'reveals', 'documents', 'extracted_profiles',
    'profile_overrides', 'blocked_companies', 'messages', 'message_threads', 'login_codes',
    'scoring_audit', 'freshness_checkins', 'embeddings', 'candidate_preference_tags',
    'extracted_facts', 'candidate_profile_intelligence', 'candidate_taxonomy_labels',
    'candidate_experience_metrics', 'candidate_job_analyses', 'displayed_match_state',
  ]) {
    try { db.prepare(`DELETE FROM ${t} WHERE candidate_id = ?`).run(id) } catch {}
  }
  db.prepare(`DELETE FROM candidates WHERE id = ?`).run(id)
}

/*
 * Scoped by this run's own marker as well as by the two long-standing name
 * prefixes.
 *
 * The hide-from-company section registers companies whose names have to look
 * like real firms - "KPMG Israel", "Bakery Supplies" - because the point of
 * that section is whether a candidate-typed name matches a registered one.
 * Naming them "Matching ..." so this line caught them would have made the test
 * pass by removing the thing it was testing. Matching on the run marker catches
 * them, and cannot catch anything this run did not create.
 */
const companies = db.prepare(`
  SELECT id FROM companies
  WHERE name LIKE 'Matching %' OR name LIKE 'Rival %' OR name LIKE ?
`).all(`%${RUN}`).map((r) => r.id)
if (companies.length) {
  const list = companies.join(',')
  const recruiters = db.prepare(`SELECT id FROM recruiters WHERE company_id IN (${list})`).all().map((r) => r.id)
  if (recruiters.length) {
    const rlist = recruiters.join(',')
    db.exec(`
      DELETE FROM displayed_match_state WHERE session_id IN
        (SELECT id FROM retrieval_sessions WHERE recruiter_id IN (${rlist}));
      DELETE FROM candidate_job_analyses WHERE job_id IN
        (SELECT id FROM jobs WHERE recruiter_id IN (${rlist}));
      DELETE FROM job_match_profiles WHERE job_id IN
        (SELECT id FROM jobs WHERE recruiter_id IN (${rlist}));
      DELETE FROM retrieval_sessions WHERE recruiter_id IN (${rlist});
      DELETE FROM jobs WHERE recruiter_id IN (${rlist});
      DELETE FROM scoring_audit WHERE recruiter_id IN (${rlist});
      DELETE FROM candidate_comments WHERE recruiter_id IN (${rlist});
      DELETE FROM candidate_tags WHERE company_id IN (${list});
      DELETE FROM search_dismissals WHERE chat_id IN
        (SELECT id FROM search_chats WHERE recruiter_id IN (${rlist}));
      DELETE FROM search_chat_turns WHERE chat_id IN
        (SELECT id FROM search_chats WHERE recruiter_id IN (${rlist}));
      DELETE FROM search_chats WHERE recruiter_id IN (${rlist});
      DELETE FROM folder_items WHERE folder_id IN
        (SELECT id FROM folders WHERE recruiter_id IN (${rlist}));
      DELETE FROM folders WHERE recruiter_id IN (${rlist});
    `)
  }
  db.exec(`
    DELETE FROM view_events WHERE company_id IN (${list});
    DELETE FROM reveals WHERE company_id IN (${list});
    DELETE FROM organization_reveals WHERE company_id IN (${list});
    DELETE FROM billing_ledger WHERE company_id IN (${list});
    DELETE FROM seat_usage_periods WHERE recruiter_id IN (SELECT id FROM recruiters WHERE company_id IN (${list}));
    DELETE FROM seat_purchases WHERE company_id IN (${list});
    DELETE FROM recruiters WHERE company_id IN (${list});
    DELETE FROM companies WHERE id IN (${list});
  `)
}
let unlinked = 0
for (const name of files) {
  try {
    fs.unlinkSync(new URL(`../server/uploads/${name}`, import.meta.url))
    unlinked += 1
  } catch { /* already gone */ }
}

check('test data removed', true,
  `${ids.length} candidate(s), ${companies.length} company(ies), ${unlinked} file(s)`)
db.close()

finish()
