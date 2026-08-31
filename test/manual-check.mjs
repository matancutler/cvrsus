/**
 * The operator manual describes commands. This fails when it stops being true.
 *
 * docs/operator-manual.html is written by hand, because the useful half of it —
 * what a command is for and when you would reach for it — cannot be generated
 * from a source file. That leaves it free to rot: somebody adds a script, or
 * renames a subcommand, or changes a port, and the manual goes on confidently
 * describing the old shape. A reference nobody trusts is worse than none,
 * because it is consulted at exactly the moments when being wrong is expensive.
 *
 * So this compares the manual against the things it quotes. It does not check
 * the prose — that is a judgement — it checks that every command which exists
 * is mentioned, that no command it mentions has disappeared, and that the
 * numbers it states match the source they came from.
 *
 * When this fails, edit the manual and republish it. The URL stays the same.
 */
import fs from 'node:fs'

import { createReporter } from './helpers.mjs'

const { section, check, finish } = createReporter('Operator manual')

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8')
const manual = read('../docs/operator-manual.html')
const pkg = JSON.parse(read('../package.json'))

/* Tags are stripped so a command split across <span>s still matches as one
   string — the manual colours flags and arguments separately. */
const text = manual.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const flat = text.replace(/\s+/g, ' ')

/* ------------------------------------------------------------- npm scripts --- */

section('Every npm script is documented')

/*
 * The test:* scripts are listed as bare names in a grid rather than as full
 * commands, so they are matched on the name alone. Everything else has to
 * appear as something a reader could actually type.
 */
const scripts = Object.keys(pkg.scripts ?? {})
const suites = scripts.filter((name) => name.startsWith('test:'))
const tools = scripts.filter((name) => !name.startsWith('test:') && name !== 'test')

check('there are scripts to document', scripts.length > 20, `${scripts.length}`)

const missingTools = tools.filter((name) => !flat.includes(`npm run ${name}`))
check('every non-test script appears as "npm run <name>"',
  missingTools.length === 0,
  missingTools.length ? `missing: ${missingTools.join(', ')}` : `${tools.length} documented`)

const missingSuites = suites.filter((name) => !flat.includes(name))
check('every test suite is named in the suite grid',
  missingSuites.length === 0,
  missingSuites.length ? `missing: ${missingSuites.join(', ')}` : `${suites.length} listed`)

/*
 * And nothing invented. A manual naming a script that does not exist sends
 * somebody to a command that errors, which is the failure that makes people
 * stop trusting the document.
 */
const claimed = [...flat.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)].map((m) => m[1])
const phantom = [...new Set(claimed)]
  /* `npm run test:<name>` is the shape of a command, not one. The angle
     brackets go with the tags, leaving a trailing colon to recognise it by. */
  .filter((name) => !name.endsWith(':'))
  .filter((name) => !scripts.includes(name))
check('and no script is named that does not exist',
  phantom.length === 0,
  phantom.length ? `invented: ${phantom.join(', ')}` : 'none')

/* ---------------------------------------------------------------- the CLIs --- */

section('Every operator command is documented')

/*
 * Each CLI states its own usage in its docstring, which is where the list of
 * subcommands really lives. Reading them from there means adding a subcommand
 * without documenting it fails here rather than being noticed by nobody.
 */
const CLIS = [
  ['candidates', '../server/scripts/candidates.mjs'],
  ['companies', '../server/scripts/companies.mjs'],
  ['recruiters', '../server/scripts/recruiters.mjs'],
  ['contact', '../server/scripts/contact.mjs'],
]

for (const [name, path] of CLIS) {
  const source = read(path)

  /*
   * From the dispatch rather than the docstring.
   *
   * The docstring is prose, and prose lies by omission: companies.mjs has a
   * `decline` command its own usage block never mentions, which is exactly the
   * drift this file exists to catch. The dispatch cannot omit anything, because
   * it is the thing that runs.
   *
   * Two shapes are in use — a chain of `command === 'x'`, and contact.mjs's
   * lookup table — so both are read.
   */
  const chained = [...source.matchAll(/command === '([a-z-]+)'/g)].map((m) => m[1])
  const table = source.match(/const commands = \{([^}]*)\}/)?.[1] ?? ''
  /* Lookahead on the trailing comma: consuming it made the separator between
     two shorthand entries unavailable to the next match, so `{ list, show, x }`
     silently reported `show` as absent. */
  const tabled = [...table.matchAll(/'([a-z][a-z-]*)'|(?:^|,)\s*([a-z][a-z-]*)\s*(?=,|$)/g)]
    .map((m) => m[1] ?? m[2])
    .filter(Boolean)
  const subcommands = [...new Set([...chained, ...tabled])]

  check(`${name}.mjs states its usage`, subcommands.length > 0,
    subcommands.join(', '))

  const undocumented = subcommands.filter(
    (sub) => !flat.includes(`${name}.mjs ${sub}`) && !flat.includes(`npm run ${name}`),
  )
  check(`  and all ${subcommands.length} of its subcommands are in the manual`,
    undocumented.length === 0,
    undocumented.length ? `missing: ${undocumented.join(', ')}` : 'all documented')
}

/* ----------------------------------------------------------- the numbers --- */

section('The numbers it quotes match the code')

const indexSource = read('../server/src/index.js')
const profiles = read('../server/src/profiles.js')
const vite = read('../client/vite.config.js')

const apiPort = indexSource.match(/const PORT = Number\(process\.env\.PORT\) \|\| (\d+)/)?.[1]
const clientPort = vite.match(/port:\s*(\d+)/)?.[1]

check('the API port is stated correctly',
  Boolean(apiPort) && flat.includes(`port ${apiPort}`),
  `server says ${apiPort}`)
check('and the client port is too',
  Boolean(clientPort) && flat.includes(clientPort),
  `vite says ${clientPort}`)
/* These two were documented the wrong way round once. */
check('and they are not the same number', apiPort !== clientPort)

const freshDays = profiles.match(/const FRESH_DAYS = (\d+)/)?.[1]
const hideDays = profiles.match(/const HIDE_DAYS = (\d+)/)?.[1]
const stages = profiles.match(/const REMINDER_STAGES = \[([\d, ]+)\]/)?.[1]

check('the freshness window matches profiles.js',
  Boolean(freshDays) && flat.includes(`${freshDays},`), `FRESH_DAYS = ${freshDays}`)
check('the hiding threshold matches',
  Boolean(hideDays) && flat.includes(`hidden at ${hideDays}`), `HIDE_DAYS = ${hideDays}`)
check('and the reminder schedule matches',
  Boolean(stages)
  && stages.split(',').map((n) => n.trim()).every((day) => flat.includes(day)),
  `REMINDER_STAGES = ${stages}`)

/* ------------------------------------------------------- the live accounts --- */

section('The accounts it says to leave alone are still named')

/*
 * These are real rows: the operator's own company, the two recruiters on it,
 * and the operator's own candidate profile. The warning is the last line of
 * defence before somebody runs a delete against one of them.
 */
for (const [what, needle] of [
  ['company 1', 'Company 1'],
  ['recruiters 1 and 72', 'recruiters 1 and 72'],
  ['candidate 6912', '6912'],
]) {
  check(`${what} is still named as untouchable`, flat.includes(needle))
}

/* ------------------------------------------------------------ the basics --- */

section('The page still works as a page')

check('it has a title', /<title>[^<]+<\/title>/.test(manual))
check('it defines a light palette on bare :root',
  /:root\s*\{[^}]*--ground:/.test(manual),
  'a colour defined only inside a media query never applies in the default theme')
check('and redefines the tokens for dark',
  manual.includes('prefers-color-scheme: dark') && manual.includes('[data-theme="dark"]'))
check('the body paints its own background',
  /body\s*\{[^}]*background:\s*var\(--ground\)/.test(manual),
  'a transparent body borrows the host theme and renders unreadably')
check('every section in the contents has somewhere to go',
  [...manual.matchAll(/href="#([a-z-]+)"/g)]
    .every((m) => manual.includes(`id="${m[1]}"`)))

finish()
