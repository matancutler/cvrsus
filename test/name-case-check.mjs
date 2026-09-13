/**
 * A name comes off a CV in the case its owner writes it, not its letterhead's.
 *
 * The rule is narrow on purpose and the narrowness is the part worth testing:
 * a word that is ALL CAPS or all lowercase carries no decision, and a word with
 * a capital already inside it carries one. Getting that backwards mangles real
 * surnames — van der Berg, O'Brien, McDonald — into something no recruiter can
 * address an email to, on a field the candidate may never re-read because it
 * already looks filled in.
 *
 * No server and no database: this is one pure function, and the cost of proving
 * it is a few milliseconds.
 */
import { createReporter } from './helpers.mjs'
import { nameCase } from '../server/src/ai.js'

const { section, check, finish } = createReporter('Name case')

const is = (input, want, why = '') =>
  check(`${JSON.stringify(input)} → ${JSON.stringify(want)}`, nameCase(input) === want,
    why || `got ${JSON.stringify(nameCase(input))}`)

section('The shouting letterhead, which is the common case')
is('MATAN CUTLER', 'Matan Cutler')
is('SMITH', 'Smith')
is('DANA LEVI-COHEN', 'Dana Levi-Cohen', 'both halves of a hyphenated name')
is("O'BRIEN", "O'Brien")
is('O\u2019CONNOR', 'O\u2019Connor', 'a typographic apostrophe counts too')

section('The other shift-key mistake')
is('matan cutler', 'Matan Cutler')
is('anne-marie', 'Anne-Marie')

section('A capital already inside a word is a decision, and is left alone')
is('Matan Cutler', 'Matan Cutler')
is('McDonald', 'McDonald', 'lowercasing this first would give Mcdonald')
is('MacLeod', 'MacLeod')
is('MATAN Cutler', 'Matan Cutler', 'per word: one half is shouting, the other is not')

section('Particles keep their case')
is('van der Berg', 'van der Berg', 'this is what a Dutch surname looks like')
is('VAN DER BERG', 'van der Berg')
is('de Souza', 'de Souza')
is('DE SOUZA', 'de Souza')
is('van der', 'van der', 'the middle-name field of "Jan van der Berg"')

section('A script with no capitals has nothing to fix')
is('\u05de\u05ea\u05df \u05e7\u05d8\u05dc\u05e8', '\u05de\u05ea\u05df \u05e7\u05d8\u05dc\u05e8', 'Hebrew is returned untouched')
is('\u7530\u4e2d\u592a\u90ce', '\u7530\u4e2d\u592a\u90ce')

section('Nothing in, nothing out')
is('', null)
is(null, null)
is(undefined, null)
is('   ', null)
is('  SARAH  ', 'Sarah', 'and the padding goes with it')

finish()
