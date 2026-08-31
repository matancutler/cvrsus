/**
 * The City field offers cities; it does not insist on them.
 *
 * The field was once a closed dropdown with an "Other" escape and was made
 * free text to stop asking people who live elsewhere to file themselves under
 * Other. Suggestions bring back the convenience without bringing back that
 * bargain, so what this file is really guarding is the shape of the
 * compromise: that clicking shows everything, that typing narrows without
 * caring about case or punctuation, and — the part that would rot quietly —
 * that a city the CV reader can pull out of a document is a city the picker
 * will offer back.
 */
import { CITIES, cityKey, matchCities } from '../client/src/data/cities.js'
import { KNOWN_CITIES } from '../server/src/ai.js'
import { readFileSync } from 'node:fs'

import { createReporter } from './helpers.mjs'

const { section, check, finish } = createReporter('City field')

/* ------------------------------------------------------------- the list --- */

section('The list itself')

check('there are cities', CITIES.length > 100, `${CITIES.length}`)
check('no city appears twice',
  new Set(CITIES.map(cityKey)).size === CITIES.length,
  'two spellings of one place would show the same option twice')
check('and the file is the order',
  CITIES.every((city, i) => i === 0 || CITIES[i - 1].toLowerCase() <= city.toLowerCase()),
  'sorted here so nothing has to sort at render time')

/* ---------------------------------------------------------- the matching --- */

section('Clicking shows everything, typing narrows')

check('an empty query is the whole list',
  matchCities('').length === CITIES.length,
  'clicking the field asks to see the cities, not to see none of them')

const narrowing = ['R', 'Ra', 'Ram', 'Ramat G'].map((q) => matchCities(q).length)
check('and each character narrows it',
  narrowing.every((n, i) => i === 0 || n <= narrowing[i - 1]),
  narrowing.join(' -> '))

check('case is ignored',
  matchCities('haifa')[0] === 'Haifa' && matchCities('HAIFA')[0] === 'Haifa',
  'nobody types their own city with a capital every time')

check('so is punctuation and spacing',
  matchCities('beersheva')[0] === "Be'er Sheva",
  "an apostrophe nobody can guess the placement of must not be the thing standing between them and their own city")

check('and a name folds to its canonical spelling',
  matchCities('tel aviv')[0] === 'Tel Aviv-Yafo',
  'one entry per place, found by whichever half of the name they type')

check('what starts with the query comes first',
  matchCities('Ram')[0].toLowerCase().startsWith('ram'),
  `${matchCities('Ram').slice(0, 3).join(', ')} — "Mitzpe Ramon" contains it and belongs lower`)

check('and nothing matches nonsense', matchCities('zzzz').length === 0,
  'which the field shows as "we will use what you typed", not as an error')

/* ------------------------------------------------- the two lists agree --- */

section('A city read from a CV is a city the picker offers')

/*
 * The one invariant that would rot silently.
 *
 * The CV reader fills this field in from the document, and its own list is
 * deliberately shorter — a closed set of names it is confident about, matched
 * against the first twelve lines. If it can put a name in the field that the
 * picker cannot then find, the candidate opens the list, sees their city
 * missing, and reasonably concludes the field is broken.
 *
 * Tested through matchCities rather than by set membership, because that is
 * what the candidate actually does: the reader answers "Tel Aviv" while the
 * picker lists "Tel Aviv-Yafo", and typing the first finds the second.
 */
const unfindable = KNOWN_CITIES.filter((city) => matchCities(city).length === 0)
check('every city the CV reader knows can be found in the picker',
  unfindable.length === 0,
  unfindable.length ? `missing: ${unfindable.join(', ')}` : `${KNOWN_CITIES.length} checked`)

/* ------------------------------------------------------ opening and shutting --- */

section('The list collapses as well as opens')

const cityField = readFileSync(
  new URL('../client/src/components/CityField.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8')

check('the field carries an arrow', /className="city-toggle"/.test(cityField),
  'a bare text box gives no sign that there is a list behind it')
check('and the arrow says which way it is pointing',
  /aria-expanded=\{open\}/.test(cityField),
  'so it is a state a screen reader can read, not only a shape')
check('pressing it while open collapses the list',
  /if \(open\) \{\s*setOpen\(false\)/.test(cityField),
  'the way back out, which clicking a text input cannot be')
check('and it does not steal focus from the field',
  /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/.test(cityField),
  'collapsing should leave the cursor where it was')

check('fifteen cities are shown before it scrolls',
  /15 \* var\(--city-row\)/.test(css) && /overflow-y: auto/.test(css),
  'the whole list is a page, not a menu')
check('and the rows are a fixed height, so that is exactly fifteen',
  /height: var\(--city-row\)/.test(css),
  'otherwise it is however many the font happens to allow')
check('with the viewport as a second ceiling',
  /min\(calc\(15 \* var\(--city-row\)/.test(css),
  'this field sits low on a signup card; fifteen rows would run off a short screen')

/* --------------------------------------------------- and both fields use it --- */

section('Both City inputs are the same field')

for (const [what, file] of [
  ['the signup flow', 'client/src/components/SignUpFlow.jsx'],
  ['the profile form', 'client/src/components/CandidateForm.jsx'],
]) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  check(`${what} uses CityField`,
    /import CityField from '\.\/CityField\.jsx'/.test(source) && /<CityField/.test(source),
    'a plain input in either place is a City field that behaves differently from the other one')
}

/* ------------------------------------------------ the form around the field --- */

/*
 * The City field sits in a form that asks everything at once.
 *
 * There was a three-step version with a progress rail, a Back button and a
 * Next — it is gone, and these checks are what is left of the ones that
 * described it. What survives is the part that was never about steps: a form
 * whose submit is one button at the foot, and a City field inside it whose
 * suggestion list must not be what submits it.
 */
section('One window, one button')

const flow = readFileSync(
  new URL('../client/src/components/SignUpFlow.jsx', import.meta.url), 'utf8')

check('the form is not split into steps',
  !flow.includes('signup-steps') && !/setStep\('email'\)/.test(flow),
  'the CV, the email and the phone are independent and all three are needed — '
  + 'splitting them meant a mistyped address was found out about one screen later')
check('and it ends in one Confirm across the foot',
  />\s*\{busy \? 'Creating your profile…' : 'Confirm'\}\s*</.test(flow)
  && /className="btn btn-primary btn-block"/.test(flow))
check('which stays disabled until everything it needs is there',
  /disabled=\{busy \|\| !ready\}/.test(flow)
  && /const ready = Boolean\(cv\) && !reading && identityReady/.test(flow),
  'the missing thing is on screen; refusing a press it could have prevented wastes it')

check('and picking a city does not submit that form',
  /if \(open && active >= 0 && options\[active\]\) \{\s*event\.preventDefault\(\)/
    .test(cityField),
  'Enter on a highlighted suggestion means the suggestion, not the form')

finish()
