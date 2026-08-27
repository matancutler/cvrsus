/**
 * The landing-page stats banner.
 *
 * Both branches matter: it must appear once the numbers are real, and it must
 * stay away while they are small. Testing only the visible case would let a
 * marketplace advertise that it is empty.
 */
import fs from 'node:fs'

import { BASE, createReporter, json } from './helpers.mjs'

const { check, section, finish } = createReporter()

section('The endpoint reports real counts')
const stats = await json(await fetch(`${BASE}/api/stats`))
check('candidates is a number', Number.isInteger(stats.candidates), `${stats.candidates}`)
check('companies is a number', Number.isInteger(stats.companies), `${stats.companies}`)
check('a threshold is published', Number.isFinite(stats.minimum), `minimum ${stats.minimum}`)
check('and a ready flag derived from it', typeof stats.ready === 'boolean', `ready ${stats.ready}`)

check('ready agrees with the counts',
  stats.ready === (stats.candidates >= stats.minimum && stats.companies >= 1),
  `${stats.candidates} candidates, ${stats.companies} companies, min ${stats.minimum}`)

section('It needs no session')
const anonymous = await fetch(`${BASE}/api/stats`)
check('an anonymous visitor can read it', anonymous.status === 200, `HTTP ${anonymous.status}`)
check('and it leaks no personal data',
  !JSON.stringify(await anonymous.json()).match(/name|email|phone/i),
  'counts only')

section('The component decides on `ready`, not on its own threshold')
const source = fs.readFileSync(new URL('../client/src/components/StatsBanner.jsx', import.meta.url), 'utf8')
/*
 * These check behaviour, not exact source text. An earlier version matched
 * whole lines and broke the moment the same logic gained a log line — a test
 * that fails on a refactor it should not care about is noise, and noise gets
 * ignored.
 */
check('it gates on the server flag', /!stats\?\.ready/.test(source))
check('and renders nothing when not ready', /return null/.test(source))
check('it does not hard-code a minimum', !/MIN_TO_SHOW|>= *25/.test(source),
  'the threshold moves without a rebuild')
check('a failed fetch cannot surface an error', /\.catch\(/.test(source)
  && !/setError|alert-error/.test(source),
  'a down endpoint must not put an error where reassurance goes')

section('Both numbers are labelled, and the labels agree with the number')
check('candidates are described as people who joined and uploaded a CV',
  source.includes('people have joined') && source.includes('uploaded a CV'))
check('companies are described as hiring here', source.includes('companies are hiring'))
check('singular forms exist for a count of one',
  source.includes('person has joined') && source.includes('company is hiring'),
  '"1 people have joined" would undo the credibility the banner is for')
check('numbers are formatted with separators', source.includes('toLocaleString'))

section('It is on the landing page, in the space it was asked to fill')
const page = fs.readFileSync(new URL('../client/src/pages/UploadPage.jsx', import.meta.url), 'utf8')
check('the banner is rendered', page.includes('<StatsBanner />'))
check('after the supporting copy', page.indexOf('<StatsBanner />') > page.indexOf('landing-kicker'))
check('inside the left column', page.indexOf('<StatsBanner />') < page.indexOf('application-card'))

const css = fs.readdirSync(new URL('../client/dist/assets/', import.meta.url))
  .filter((f) => f.endsWith('.css'))
  .map((f) => fs.readFileSync(new URL(`../client/dist/assets/${f}`, import.meta.url), 'utf8'))
  .join('\n')
check('two columns of figures', css.includes('.stats-banner'))
check('separated by a rule, not boxed', css.includes('.stat-figure'))
check('digits are tabular so captions do not shift', css.includes('tabular-nums'))
check('and it stacks on a narrow screen', css.includes('.stats-banner{grid-template-columns:1fr'))

finish()
