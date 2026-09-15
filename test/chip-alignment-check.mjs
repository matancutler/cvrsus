/**
 * Chips on a result row sit on one line.
 *
 * `.chip` is an inline-flex box 22px tall that centres its own content, and
 * every chip on a row relies on being that same box to line up with the others.
 * A folder chip has to truncate as well — folders are named after the search,
 * and a search is named after the job description — and the obvious way to get
 * an ellipsis is to make the chip `display: inline-block`. That works, and it
 * quietly drops the chip off the line its neighbours share, because an
 * inline-block with a line-height aligns by a different rule than an
 * inline-flex box.
 *
 * The fix is to clip the TEXT instead, so the chip stays a chip. These checks
 * exist because that is not obvious from reading either rule on its own.
 */
import fs from 'node:fs'

import { createReporter } from './helpers.mjs'

const { check, section, finish } = createReporter()

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const css = read('../client/src/styles.css')

/** The body of one rule, by selector. */
const ruleBody = (selector) => {
  const at = css.indexOf(`\n${selector} {`)
  if (at < 0) return null
  return css.slice(at, css.indexOf('}', at))
}

section('Every chip is the same kind of box')
const chip = ruleBody('.chip')
check('.chip is an inline-flex box', /display:\s*inline-flex/.test(chip ?? ''))
check('with a fixed height', /height:\s*22px/.test(chip ?? ''))
check('centring its own content', /align-items:\s*center/.test(chip ?? ''))

const folder = ruleBody('.chip-folder')
check('the folder chip exists', Boolean(folder))
check('and does not redefine display',
  !/display:/.test(folder ?? ''),
  'an inline-block chip aligns by a different rule and falls off the row')
check('nor line-height',
  !/line-height:/.test(folder ?? ''),
  'the height and centring come from .chip; a second opinion here misaligns it')
check('it only narrows the chip', /max-width:/.test(folder ?? ''))

section('The truncation happens on the text')
const clip = ruleBody('.chip-clip')
check('there is a clipping element', Boolean(clip))
check('which hides the overflow', /overflow:\s*hidden/.test(clip ?? ''))
check('and ends it with an ellipsis', /text-overflow:\s*ellipsis/.test(clip ?? ''))
check('and may shrink below its content',
  /min-width:\s*0/.test(clip ?? ''),
  'a flex item refuses to shrink past its content without this, so nothing clips')

section('And every folder chip actually uses it')
for (const [label, path] of [
  ['the Triage row', '../client/src/components/TriageTab.jsx'],
  ['the search result row', '../client/src/pages/HrPanel.jsx'],
]) {
  const source = read(path)
  const at = source.indexOf('chip chip-folder')
  check(`${label} renders a folder chip`, at > 0)
  check(`${label} wraps the name`,
    source.slice(at, at + 400).includes('chip-clip'),
    'a bare text node in a flex container is an anonymous item and cannot be clipped')
}

finish()
