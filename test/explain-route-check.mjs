/**
 * Who may ask for an assessment to be explained.
 *
 * The explain route reads a stored judgement of a real person's CV and, when
 * there is one to write, spends money writing about it. Both halves need a
 * gate: the ids it takes — a job id, a triage id, an applicant id — are small
 * integers anybody could guess, and a route that explained whatever it was
 * handed would read one recruiter's shortlist to another, and let a stranger
 * spend this company's money doing it.
 *
 * So the checks here are ownership first and behaviour second. The writing
 * itself is covered by ai-cost-check, which stubs the model; this suite runs
 * against the real server, where there is no API key, so nothing it does can
 * call Claude.
 */
import fs from 'node:fs'

import { BASE, createReporter, json, makePdf, registerApprovedCompany } from './helpers.mjs'

const { check, section, finish } = createReporter()

const RUN = Date.now().toString(36)
const MARK = `cking-explain-${RUN}`

const { default: Database } = await import('better-sqlite3')
const db = new Database(new URL('../server/data/cking.db', import.meta.url).pathname.slice(1))

const phoneFor = () => `052-${Math.floor(1000000 + Math.random() * 8999999)}`

const mine = await registerApprovedCompany({
  companyName: `${MARK} Ltd`, email: `me.${RUN}@${MARK}.example.com`, phone: phoneFor(),
})
const theirs = await registerApprovedCompany({
  companyName: `${MARK}-other Ltd`, email: `them.${RUN}@${MARK}.example.com`, phone: phoneFor(),
})

const as = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
const explain = (token, body) => fetch(`${BASE}/api/hr/analysis/explain`, {
  method: 'POST', headers: as(token), body: JSON.stringify(body),
})

/* Somebody to be judged, so there is a real assessment to ask about. */
const email = `cand.${RUN}@${MARK}.example.com`
const phone = phoneFor()
const { contactProofs } = await import('./helpers.mjs')
const form = new FormData()
form.append('cv', new Blob([await makePdf([
  'Explain Subject', 'Underwriter - Tel Aviv', 'UNDERWRITER, Co 2019 - present',
  '  Reviewed card-not-present transactions and owned the chargeback process.',
  'SKILLS: Underwriting, fraud review, SQL',
])], { type: 'application/pdf' }), 'cv.pdf')
for (const [k, v] of Object.entries({
  firstName: 'Explain', lastName: 'Subject', email, phone,
  location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
})) form.append(k, v)
for (const [k, v] of Object.entries(await contactProofs({ email, phone }))) form.append(k, v)
form.append('consent', 'true')
const candidate = await json(await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form }))

const search = await json(await fetch(`${BASE}/api/hr/search`, {
  method: 'POST',
  headers: as(mine.token),
  body: JSON.stringify({
    jobDescription: 'Underwriter reviewing online card-not-present transactions for a payments '
      + 'company in Tel Aviv. Must have underwriting experience and fraud review. SQL preferred.',
  }),
}))

section('Setup')
check('a candidate exists to be judged', Boolean(candidate.id))
check('and a search that judged them', Number.isInteger(search.jobId), `job ${search.jobId}`)

section('It refuses what it was not asked clearly')
const noScope = await explain(mine.token, { candidateId: candidate.id })
check('a request with no scope is refused', noScope.status === 400, `HTTP ${noScope.status}`)

const halfSearch = await explain(mine.token, { scope: 'search', jobId: search.jobId })
check('and one naming a job but no candidate', halfSearch.status === 400, `HTTP ${halfSearch.status}`)

section('It refuses another recruiter’s work')
const foreignJob = await explain(theirs.token, { scope: 'search', jobId: search.jobId, candidateId: candidate.id })
check('another company cannot explain this search',
  foreignJob.status === 404,
  `HTTP ${foreignJob.status} — a guessed job id finds nothing`)

const invented = await explain(mine.token, { scope: 'search', jobId: 99999999, candidateId: candidate.id })
check('nor can anyone explain a job that does not exist', invented.status === 404)

const foreignTriage = await explain(theirs.token, { scope: 'triage', triageId: 99999999, applicantId: 1 })
check('a Triage belonging to nobody is refused too', foreignTriage.status === 404)

section('Signed out, it does nothing at all')
const anonymous = await fetch(`${BASE}/api/hr/analysis/explain`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scope: 'search', jobId: search.jobId, candidateId: candidate.id }),
})
check('an unauthenticated request is turned away',
  anonymous.status === 401 || anonymous.status === 403,
  `HTTP ${anonymous.status}`)

section('Asked about a score no model produced')
const own = await explain(mine.token, { scope: 'search', jobId: search.jobId, candidateId: candidate.id })
const body = await own.json()
check('the owner is allowed to ask', own.status === 200, `HTTP ${own.status}`)
check('and is told plainly that there is nothing to explain',
  body.explain === null && body.reason === 'not-analysed',
  `${JSON.stringify(body)} — this server has no API key, so the score came from keyword matching`)

section('Cleanup')
const { deleteCandidateCompletely } = await import('../server/src/profiles.js')
for (const name of deleteCandidateCompletely(candidate.id)) {
  const at = new URL(`../server/uploads/${name}`, import.meta.url).pathname.slice(1)
  if (fs.existsSync(at)) fs.unlinkSync(at)
}

/* Only what this run made: the job rows it created, then its two companies. */
for (const company of [mine.company, theirs.company]) {
  const recruiters = db.prepare('SELECT id FROM recruiters WHERE company_id = ?').all(company.id).map((r) => r.id)
  if (recruiters.length) {
    const list = recruiters.join(',')
    const jobs = db.prepare(`SELECT id FROM jobs WHERE recruiter_id IN (${list})`).all().map((j) => j.id)
    if (jobs.length) {
      const jobList = jobs.join(',')
      db.prepare(`DELETE FROM candidate_job_analyses WHERE job_id IN (${jobList})`).run()
      db.prepare(`DELETE FROM displayed_match_state WHERE session_id IN (SELECT id FROM retrieval_sessions WHERE job_id IN (${jobList}))`).run()
      db.prepare(`DELETE FROM retrieval_sessions WHERE job_id IN (${jobList})`).run()
      db.prepare(`DELETE FROM job_match_profiles WHERE job_id IN (${jobList})`).run()
      db.prepare(`DELETE FROM jobs WHERE id IN (${jobList})`).run()
    }
    db.prepare(`DELETE FROM recruiter_password_resets WHERE recruiter_id IN (${list})`).run()
    db.prepare(`DELETE FROM seat_usage_periods WHERE recruiter_id IN (${list})`).run()
    db.prepare('DELETE FROM recruiters WHERE company_id = ?').run(company.id)
  }
  db.prepare('DELETE FROM billing_ledger WHERE company_id = ?').run(company.id)
  db.prepare('DELETE FROM companies WHERE id = ?').run(company.id)
}

check('test data removed',
  !db.prepare('SELECT id FROM companies WHERE name LIKE ?').get(`${MARK}%`)
  && !db.prepare('SELECT id FROM candidates WHERE id = ?').get(candidate.id))
db.close()

finish()
