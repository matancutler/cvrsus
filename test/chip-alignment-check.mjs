/**
 * Chips on a result row sit on one line.
 *
 * `.chip` is an inline-flex box 22px tall that centres its own content, and
 * every chip on a row relies on being that same box to line up with the others.
 * Anything on the row that is NOT that box has to be checked against the row
 * some other way: the folder mark is now an unlabelled circle, and a circle
 * that is allowed to flex stops being a circle.
 *
 * The other half is truncation. Something on a candidate row always holds
 * more text than there is room for, and the obvious fix — letting the box
 * itself become `display: inline-block` so it can take an ellipsis — works
 * and quietly drops the box off the line its neighbours share, because an
 * inline-block with a line-height aligns by a different rule than an
 * inline-flex box. So the clipping is always on the text, never on the box.
 * These checks exist because none of that is obvious from reading any one
 * rule on its own.
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

/*
 * The folder mark is no longer a chip.
 *
 * It was a named pill, and it competed: a folder is named after the search
 * that made it and a search is named after the job description, so a pasted
 * posting became a chip a paragraph long sitting where a small label
 * belongs. It is now an unlabelled circle with the folder name on hover -
 * "this one is filed" at a glance, which folder one hover away.
 *
 * So it is checked as a dot rather than as a chip: nothing about it may
 * stretch, and it has to stay round at every row height.
 */
const dot = ruleBody('.chip-folder-dot')
check('the folder mark exists', Boolean(dot))
check('and cannot stretch', /flex:\s*none/.test(dot ?? ''),
  'a flex item with no basis is stretched by its row and stops being a circle')
check('it is round', /border-radius:\s*50%/.test(dot ?? ''))
check('and as tall as it is wide',
  /width:\s*18px/.test(dot ?? '') && /height:\s*18px/.test(dot ?? ''),
  'a circle with one dimension set is an ellipse the moment the row changes height')
check('it advertises the hover', /cursor:\s*help/.test(dot ?? ''),
  'the folder name is only reachable by hovering, so the cursor has to say so')

section('The truncation moved to the tags')
/*
 * The clipping used to live on a wrapper inside the folder chip. The chip is
 * gone, and the strip of recruiter tags is now the thing on a row that holds
 * more text than there is room for.
 */
const tag = ruleBody('.tag-strip .tag')
check('there is a tag frame', Boolean(tag))
check('which hides the overflow', /overflow:\s*hidden/.test(tag ?? ''))
check('and ends it with an ellipsis', /text-overflow:\s*ellipsis/.test(tag ?? ''))
check('on one line', /white-space:\s*nowrap/.test(tag ?? ''),
  'a tag that wraps pushes the row taller and the strip stops being a strip')
check('every frame the same width, whatever is written in it',
  /flex:\s*0 1 3\.5rem/.test(tag ?? ''),
  'frames sized to their own text are a ragged edge that changes on every row, '
  + 'and the eye reads the edge rather than the words')
check('and a frame may shrink below its content', /min-width:/.test(tag ?? ''),
  'a flex item refuses to shrink past its content without this, so nothing clips')

const more = ruleBody('.tag-strip .tag-more')
check('the count is the one frame that is never cut',
  /flex:\s*0 0 auto/.test(more ?? '') && /text-overflow:\s*clip/.test(more ?? ''),
  'a clipped "+3" comes out as "+", which is the one thing it exists not to say')

section('And both rows use it, the same way')
for (const [label, path] of [
  ['the Triage row', '../client/src/components/TriageTab.jsx'],
  ['the search result row', '../client/src/pages/HrPanel.jsx'],
]) {
  const source = read(path)
  const at = source.indexOf('chip-folder-dot')
  check(`${label} renders the folder dot`, at > 0)
  const mark = source.slice(at, at + 400)
  check(`${label} puts the folder name on hover`, /title=\{`Saved in your /.test(mark),
    'the dot carries no text, so the title is the only place the name exists at all')
  check(`${label} names it for a screen reader too`, /aria-label=\{`Saved in your /.test(mark),
    'a title attribute is a mouse affordance and nothing else')
}

/*
 * And the old design's rules left the stylesheet with its markup. A rule
 * nothing references is one the next person restores a chip against, and
 * gets the paragraph-long pill back.
 */
check('the named folder chip is gone from the stylesheet', !ruleBody('.chip-folder'))
check('and so is its clipping wrapper', !ruleBody('.chip-clip'))

finish()
