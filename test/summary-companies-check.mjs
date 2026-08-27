/**
 * No employer names in a Professional Summary.
 *
 * The summary is shown to recruiters BEFORE a reveal — it is how somebody
 * decides whether to spend one — while the surname, the photograph, the contact
 * details and even the CV's filename are withheld as identifying. "Senior
 * engineer at Wix for four years" defeats all of that in one clause. So the
 * employer is abstracted and the rest of the sentence kept.
 *
 * Most of this runs against the pure functions rather than through HTTP,
 * because the interesting cases are about text: which names are found, what
 * they are replaced with, and — as important — what is left alone. The two
 * end-to-end sections at the bottom prove the pipeline actually calls them.
 *
 * Note what these do NOT require: an API key. The layer that catches the small
 * consultancy nobody has heard of is the CV cross-reference, which is
 * deterministic, and it has to work in a deployment with no model configured or
 * the rule holds only where somebody paid for it to.
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

import Database from 'better-sqlite3'

import { BASE, contactProofs, createReporter, json, makePdf } from './helpers.mjs'
import {
  abstractEmployers, describeEmployer, employersNamedInBoth, sanitiseText,
} from '../server/src/summary.js'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const MARKER = `@cking-summary-${RUN}.example.com`
const PHONE_RUN = String(Date.now()).slice(-6)
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const J = { 'content-type': 'application/json' }

/** No trace of the name, in any casing. */
const names = (text, name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
  .test(String(text))

// ---------------------------------------------------- what replaces what ---

section('An employer becomes what kind of place it is')

for (const [name, industry, expected] of [
  ['Apple', 'Technology', 'a technology company'],
  ['Goldman Sachs', null, 'a global financial institution'],
  ['Deloitte', null, 'a professional services firm'],
  ['Monday.com', 'B2B SaaS', 'a B2B software company'],
  ['Ziv Haddad Accounting', 'Accounting', 'a professional services firm'],
  ['Some Local Shop', 'Retail', 'an e-commerce company'],
  ['Nobody Has Heard Of Us', null, 'a company'],
]) {
  check(`${name} → ${expected}`, describeEmployer(name, industry) === expected,
    describeEmployer(name, industry))
}

check('the last resort is a last resort, not the default',
  describeEmployer('Acme', 'Fintech') === 'a fintech company',
  'flattening every employer to "a company" throws away what a recruiter reads for')

section('The name goes and the sentence stays')

/* The examples the rule was written from. */
for (const [text, employers, industry, gone, kept] of [
  [
    'I spent three years working as a software engineer at Apple before moving into product management.',
    ['Apple'], 'Technology', 'Apple', ['software engineer', 'product management'],
  ],
  [
    'Senior product manager with eight years of experience, including four years leading B2B products at Microsoft.',
    ['Microsoft'], null, 'Microsoft', ['eight years', 'B2B products', 'Senior product manager'],
  ],
  [
    'I spent four years at Deloitte advising financial-services companies.',
    ['Deloitte'], null, 'Deloitte', ['four years', 'financial-services'],
  ],
  [
    'Investment Banking Analyst at Goldman Sachs covering technology.',
    ['Goldman Sachs'], null, 'Goldman', ['Investment Banking Analyst', 'covering technology'],
  ],
]) {
  const out = abstractEmployers(text, { employers, industry }).text
  check(`"${gone}" is gone`, !names(out, gone), out)
  for (const phrase of kept) {
    check(`  and "${phrase}" survives`, out.includes(phrase))
  }
}

section('Several employers, all of them')

const many = abstractEmployers(
  'I worked at Apple, then at Deloitte, and most recently at Ziv Haddad Systems.',
  { employers: ['Apple', 'Deloitte', 'Ziv Haddad Systems'], industry: 'Technology' },
)
for (const gone of ['Apple', 'Deloitte', 'Ziv Haddad']) {
  check(`${gone} is gone`, !names(many.text, gone), many.text)
}
check('and three replacements were made', many.replaced.length >= 3)

section('A summary with no employer in it is left alone')

const untouched = 'Backend engineer with six years in fintech and payments. I work with SQL and Go.'
check('nothing is rewritten',
  abstractEmployers(untouched, { employers: [], industry: 'Fintech' }).text === untouched,
  'a summary is not rewritten for being read')

section('Words that describe the work are not employers')

/*
 * The other half of the rule, and the easier one to get wrong. "fintech" and
 * "consulting" are what a recruiter is reading for; taking them out to be safe
 * would leave a summary that says nothing.
 */
const generic = abstractEmployers(
  'I consult on banking and fintech for SaaS and e-commerce companies in healthcare.',
  { employers: [], industry: 'Consulting' },
).text
for (const word of ['banking', 'fintech', 'SaaS', 'e-commerce', 'healthcare', 'consult']) {
  check(`"${word}" survives`, generic.includes(word))
}

section('The CV is the evidence, not a list of famous names')

/*
 * §15 stated literally: if the CV says they worked somewhere and that name is
 * in their summary, abstract it. This is the layer that covers the small firm,
 * and it needs no model and no list.
 */
const cv = 'PRODUCT MANAGER, Ziv Haddad Systems Ltd 2019-2024. Built tooling in Python.'
const found = employersNamedInBoth(
  'I led product at Ziv Haddad Systems for five years, working with Python.',
  cv,
  { exclude: ['Dana', 'Tel Aviv', 'Python'] },
)
check('an employer nobody has heard of is found', found.includes('Ziv Haddad Systems'),
  JSON.stringify(found))

check('a skill they listed is not mistaken for one',
  !employersNamedInBoth('I build things with Python.', cv, { exclude: ['Python'] })
    .includes('Python'))

check('and neither is where they studied',
  employersNamedInBoth('I studied at the Technion.', 'Technion, BSc Computer Science.', {})
    .length === 0,
  'an employer is who paid them, not where they learned')

// ------------------------------------------------------------ end to end ---

section('Every path through the product ends up sanitised')

const CV_LINES = [
  'Dana Summary', 'Product Manager',
  'PRODUCT MANAGER, Monday.com 2019-01 - present',
  '  Led B2B SaaS products end to end. Six years of experience in product.',
  'SOFTWARE ENGINEER, Ziv Haddad Systems Ltd 2016-01 - 2018-12',
  '  Built internal tooling in Python and SQL for a small consultancy.',
  'SKILLS: Product, Roadmap, SQL, Analytics',
]

async function apply({ tag, notes }) {
  const email = `${tag}.${RUN}${MARKER}`
  const phone = `052-${PHONE_RUN.slice(0, 3)}-${tag === 'wrote' ? '5001' : '5002'}`

  const form = new FormData()
  form.append('cv', new Blob([await makePdf(CV_LINES)], { type: 'application/pdf' }), 'cv.pdf')
  const fields = {
    firstName: 'Dana', lastName: 'Summary', email, phone,
    location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
    openToRelocation: 'yes', openToAllOpportunities: 'true', consent: 'true',
  }
  if (notes !== undefined) fields.notes = notes
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  for (const [k, v] of Object.entries(await contactProofs({ email, phone }))) form.append(k, v)

  const res = await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form })
  return { body: await res.json().catch(() => ({})), email }
}

const stored = (id) => db.prepare(`SELECT notes FROM candidates WHERE id = ?`).get(id)?.notes

/* Path 3: they wrote nothing and pressed nothing. */
const quiet = await apply({ tag: 'quiet' })
await new Promise((resolve) => { setTimeout(resolve, 2500) })
const auto = stored(quiet.body.id)
check('a candidate who writes nothing still has a summary', Boolean(auto), String(auto))
check('and it names no employer from their CV',
  !names(auto, 'Monday') && !names(auto, 'Ziv Haddad'), String(auto))

/* Path 1: they wrote their own, naming two employers — one famous, one not. */
const wrote = await apply({
  tag: 'wrote',
  notes: 'I spent three years as a product manager at Monday.com and before that I was '
    + 'an engineer at Ziv Haddad Systems. I work on B2B SaaS and fintech.',
})
await new Promise((resolve) => { setTimeout(resolve, 2500) })
const cleaned = stored(wrote.body.id)
check('a summary they wrote loses the famous employer', !names(cleaned, 'Monday.com'), String(cleaned))
check('and the one nobody has heard of', !names(cleaned, 'Ziv Haddad'), String(cleaned))
for (const phrase of ['product manager', 'B2B SaaS', 'fintech', 'three years']) {
  check(`  and keeps "${phrase}"`, String(cleaned).includes(phrase))
}

section('An edit that puts a company back takes it out again')

const code = await json(await fetch(`${BASE}/api/candidate/request-code`, {
  method: 'POST', headers: J, body: JSON.stringify({ identifier: wrote.email }),
}))
const { token } = await json(await fetch(`${BASE}/api/candidate/verify-code`, {
  method: 'POST', headers: J,
  body: JSON.stringify({ identifier: wrote.email, code: code.devCode }),
}))

const edit = new FormData()
for (const [k, v] of Object.entries({
  firstName: 'Dana', lastName: 'Summary', email: wrote.email,
  phone: `052-${PHONE_RUN.slice(0, 3)}-5001`,
  location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
  notes: 'Actually I led product at Monday.com for six years.',
})) edit.append(k, v)
await fetch(`${BASE}/api/candidate/me`, {
  method: 'PATCH', headers: { authorization: `Bearer ${token}` }, body: edit,
})
await new Promise((resolve) => { setTimeout(resolve, 1500) })

const edited = stored(wrote.body.id)
check('the company they typed back in is taken out again', !names(edited, 'Monday.com'),
  String(edited))
check('and what they meant is still there', String(edited).includes('six years'))

section('And it is the sanitised one recruiters get')

/*
 * The read path, not just the write path. The recruiter view used to fall back
 * to the CV-drafted summary inside the extraction when the candidate had
 * written none — a second source that nothing had ever screened.
 */
const panel = fs.readFileSync(new URL('../server/src/index.js', import.meta.url), 'utf8')
const view = (panel.split('function recruiterCandidateView')[1] ?? '').split('\nfunction ')[0]
check('the recruiter view reads one field', /summary: written,/.test(view))
check('and no longer falls back to the unscreened draft',
  !/written \?\? fromCv/.test(view),
  'two sources, one of them never sanitised')

// ---------------------------------------------------------------- cleanup ---


section('Names the first attempt at this let through')

/*
 * Every one of these was a real leak or a real act of vandalism found by
 * auditing the first version of this module. They are here rather than in a
 * comment because each is a shape of input, not a one-off.
 */
for (const [label, text, employers, industry, gone] of [
  ['a punctuated name', 'PM at Monday.com building SaaS.', ['Monday.com'], 'B2B SaaS', 'Monday'],
  ['the same name respelled', 'PM at Monday com building SaaS.', ['Monday.com'], 'B2B SaaS', 'Monday'],
  ['an ampersand', 'I worked at Ben & Jerry for two years.', ["Ben & Jerry's"], 'Retail', 'Ben'],
  ['a hyphen', 'Engineer at Check-Point on firewalls.', ['Check Point'], 'Cyber', 'Check'],
  ['a name in Hebrew', 'עבדתי ב אלביט מערכות שש שנים.', ['אלביט מערכות'], 'Defence', 'אלביט'],
]) {
  const out = abstractEmployers(text, { employers, industry }).text
  check(`${label} is still abstracted`, !names(out, gone), out)
}

section('And words that only look like names are left alone')

/*
 * The other direction, and the one that damages a candidate rather than
 * exposing them: the well-known-name pass used to run against every summary
 * with no regard for context, so an ordinary sentence came back rewritten and
 * the damage was saved over what the person had typed.
 */
for (const [label, text] of [
  ['a checkpoint', 'The system saves a checkpoint every minute.'],
  ['a meta analysis', 'I ran a meta analysis of the results.'],
  ['an intel briefing', 'I prepared an intel briefing for the board.'],
  ['an oracle', 'The test uses an oracle to check outputs.'],
  ['apple pie', 'I like apple pie and long walks.'],
  ['an A grade', 'Received an A grade in advanced mathematics.'],
  ['the a priori assumption', 'I question the a priori assumption behind it.'],
  ['longer words containing a name', 'Sapphire metadata and intelligence work.'],
]) {
  check(`${label} survives untouched`,
    abstractEmployers(text, { employers: [] }).text === text,
    abstractEmployers(text, { employers: [] }).text)
}

check('but the same word IS abstracted where it is the employer',
  !names(abstractEmployers('I was an engineer at Meta for four years.', { employers: [] }).text, 'Meta'),
  'context decides, not the word')

section('A guess from a list never beats the candidate own CV')

check('a greengrocer is not a technology company',
  describeEmployer('Apple Orchard Ltd', 'Retail') === 'an e-commerce company',
  'the list is prefix-matched, so "Apple Orchard" used to be described as Apple is')
check('while the real one still is',
  describeEmployer('Apple', 'Technology') === 'a technology company')

section('The result still fits the field it is saved in')

const long = `I led product at ${'Ziv Haddad Accounting Partners '.repeat(3)}`
  + 'and elsewhere. '.repeat(20)
const capped = abstractEmployers(long, {
  employers: ['Ziv Haddad Accounting Partners'], industry: 'Accounting',
}).text
check('abstraction can lengthen a summary', typeof capped === 'string')
check('and sanitiseText caps what it returns',
  (await sanitiseText(long, { employers: ['Ziv Haddad Accounting Partners'], industry: 'Accounting' }))
    .length <= 500,
  'a summary pushed past the limit would be refused by the candidate own form')

section('Cleanup')

const { deleteCandidateCompletely } = await import('../server/src/profiles.js')
const { UPLOAD_DIR } = await import('../server/src/db.js')
const path = await import('node:path')

const mine = db.prepare(`SELECT id FROM candidates WHERE email LIKE ?`).all(`%${MARKER}`)
let unlinked = 0
for (const row of mine) {
  for (const name of deleteCandidateCompletely(row.id)) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); unlinked += 1 } catch { /* gone */ }
  }
}
check('test data removed', true, `${mine.length} candidate(s), ${unlinked} file(s)`)
db.close()

finish()
