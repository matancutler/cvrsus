/**
 * Does a cheaper setup judge candidates the same way?
 *
 *   node server/scripts/ai-eval.mjs --list
 *   node server/scripts/ai-eval.mjs --configs baseline,opus-medium --dry
 *   node server/scripts/ai-eval.mjs --configs baseline,opus-medium --yes
 *
 * THIS SCRIPT SPENDS MONEY. Roughly $25-30 for a full run of four
 * configurations over five job descriptions and fifteen CVs. It refuses to
 * start without --yes, and --dry prints the plan and the estimated cost without
 * calling anything.
 *
 * Why it exists: dropping the effort level or the model is the largest saving
 * available and the only change that can quietly make the product worse. The
 * ranking is what recruiters pay for, and "it looked fine when I tried it" is
 * not a measurement. So the decision is made from agreement against a stored
 * baseline, on real job descriptions, with the disagreements printed for a
 * person to read.
 *
 * The disagreements are printed WITHOUT saying which configuration produced
 * which verdict. Agreeing with Opus is not the same as being right, and a list
 * labelled "Opus said X, Sonnet said Y" is read as a list of Sonnet's mistakes.
 * The key is written to a separate file, to be opened after the reading.
 *
 * Material lives in eval/ (git-ignored, not committed — real job ads and real
 * CVs are not test fixtures):
 *
 *   eval/jobs/<name>.txt        one job description each
 *   eval/cvs/<name>.txt         one CV each
 *
 * Results land in eval/out/.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { analyseJobDescription, analyseMatch, isConfigured } from '../src/ai.js'
import { costOf } from '../src/costs.js'
import { requirementsFrom } from '../src/matching/analysis.js'
import { scoreAgainst } from '../src/matching/score.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIR = path.join(ROOT, 'eval')
const OUT = path.join(DIR, 'out')

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : argv[at + 1]
}

/**
 * The configurations worth comparing.
 *
 * `baseline` is what production runs today, and every other line is measured
 * against it — not because it is right, but because it is what recruiters have
 * been getting, so a change from it is a change they would notice.
 */
const CONFIGS = {
  baseline: { model: 'claude-opus-5', effort: 'high' },
  'opus-medium': { model: 'claude-opus-5', effort: 'medium' },
  'sonnet-high': { model: 'claude-sonnet-5', effort: 'high' },
  'sonnet-medium': { model: 'claude-sonnet-5', effort: 'medium' },
}

function read(dir) {
  const at = path.join(DIR, dir)
  if (!fs.existsSync(at)) return []
  return fs.readdirSync(at)
    .filter((name) => name.endsWith('.txt'))
    .map((name) => ({ name: name.replace(/\.txt$/, ''), text: fs.readFileSync(path.join(at, name), 'utf8') }))
}

const jobs = read('jobs')
const cvs = read('cvs')

if (has('list') || jobs.length === 0 || cvs.length === 0) {
  console.log(`\nEval material in ${DIR}`)
  console.log(`  jobs: ${jobs.length}${jobs.length ? ` (${jobs.map((j) => j.name).join(', ')})` : ''}`)
  console.log(`  cvs:  ${cvs.length}${cvs.length ? ` (${cvs.map((c) => c.name).join(', ')})` : ''}`)
  if (jobs.length === 0 || cvs.length === 0) {
    console.log('\nPut real job ads in eval/jobs/*.txt and real CVs in eval/cvs/*.txt.')
    console.log('Public job ads are fine. Fixtures check the plumbing, not the judgement —')
    console.log('every configuration agrees on a tidy invented CV, which is what makes')
    console.log('invented CVs useless for this particular question.')
  }
  console.log('')
  process.exit(0)
}

const chosen = String(flag('configs', 'baseline,opus-medium,sonnet-medium'))
  .split(',').map((name) => name.trim()).filter(Boolean)

for (const name of chosen) {
  if (!CONFIGS[name]) {
    console.error(`Unknown configuration "${name}". Known: ${Object.keys(CONFIGS).join(', ')}`)
    process.exit(1)
  }
}

const pairs = jobs.length * cvs.length
const calls = pairs * chosen.length + jobs.length

console.log(`\n${jobs.length} jobs × ${cvs.length} CVs × ${chosen.length} configurations`)
console.log(`  ${calls} model calls, of which ${jobs.length} read the job descriptions.`)
console.log(`  Rough cost: $${(pairs * 0.15 * chosen.length).toFixed(2)} at today's prices,`)
console.log('  less whatever prompt caching saves within each job.\n')

if (has('dry')) {
  console.log('--dry: nothing was called.\n')
  process.exit(0)
}

if (!isConfigured()) {
  console.error('No ANTHROPIC_API_KEY (or AI_PAUSED is set). Nothing to run.\n')
  process.exit(1)
}

if (!has('yes')) {
  console.error('This spends real money. Re-run with --yes when you mean it.\n')
  process.exit(1)
}

fs.mkdirSync(OUT, { recursive: true })

/* Every judgement made, keyed so the comparison below can line them up. */
const verdicts = new Map()
const usage = new Map(chosen.map((name) => [name, { cost: 0, calls: 0, ms: 0 }]))

for (const job of jobs) {
  console.log(`\n${job.name}`)
  const profile = await analyseJobDescription({ jobDescription: job.text })
  if (!profile) {
    console.log('  could not read this job description — skipped')
    continue
  }

  const requirements = requirementsFrom(profile)
  const criteria = {
    title: profile.title ?? '',
    jobDescription: job.text,
    requirements,
    location: profile.logistics?.location ?? null,
    workArrangement: profile.logistics?.workArrangement ?? null,
  }

  for (const config of chosen) {
    process.stdout.write(`  ${config}: `)

    for (const cv of cvs) {
      const started = Date.now()
      const result = await analyseMatch({
        jobDescription: job.text,
        criteria,
        candidate: { id: cv.name, cv_text: cv.text, display_name: cv.name },
        profile: null,
        ...CONFIGS[config],
      })

      const totals = usage.get(config)
      totals.ms += Date.now() - started

      if (!result) {
        process.stdout.write('·')
        continue
      }

      totals.calls += 1
      totals.cost += costOf({
        model: CONFIGS[config].model,
        inputTokens: result.usage?.inputTokens ?? 0,
        cacheWriteTokens: result.usage?.cacheWriteTokens ?? 0,
        cacheReadTokens: result.usage?.cacheReadTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      })

      const judged = scoreAgainst(requirements, result.criteria)
      verdicts.set(`${job.name}|${cv.name}|${config}`, {
        fit: judged.fit,
        byId: new Map(result.criteria.map((row) => [row.requirement_id, row])),
        requirements,
      })
      process.stdout.write('.')
    }
    process.stdout.write('\n')
  }
}

// ------------------------------------------------------------ comparison ---

const baseline = chosen[0]
const disagreements = []
const summary = []

for (const config of chosen.slice(1)) {
  let exact = 0
  let adjacent = 0
  let total = 0
  let mustExact = 0
  let mustTotal = 0
  const fitPairs = []

  for (const job of jobs) {
    for (const cv of cvs) {
      const base = verdicts.get(`${job.name}|${cv.name}|${baseline}`)
      const other = verdicts.get(`${job.name}|${cv.name}|${config}`)
      if (!base || !other) continue

      if (Number.isFinite(base.fit) && Number.isFinite(other.fit)) {
        fitPairs.push([base.fit, other.fit])
      }

      for (const requirement of base.requirements) {
        const a = base.byId.get(requirement.id)?.status
        const b = other.byId.get(requirement.id)?.status
        if (!a || !b) continue

        total += 1
        const same = a === b
        const near = same || (['meets', 'partial'].includes(a) && ['meets', 'partial'].includes(b))
        if (same) exact += 1
        if (near) adjacent += 1

        if (requirement.tier === 'must_have') {
          mustTotal += 1
          if (same) mustExact += 1
          else {
            /* The cases a person has to read. Which configuration said which is
               deliberately not recorded here — see the note at the top. */
            const sides = [
              { verdict: a, quote: base.byId.get(requirement.id)?.quote ?? '', reason: base.byId.get(requirement.id)?.reason ?? '' },
              { verdict: b, quote: other.byId.get(requirement.id)?.quote ?? '', reason: other.byId.get(requirement.id)?.reason ?? '' },
            ]
            /* Ordered by the verdict text so the stronger reading is not always
               printed first, which would be a tell. */
            sides.sort((x, y) => x.verdict.localeCompare(y.verdict))
            disagreements.push({
              job: job.name, cv: cv.name, requirement: requirement.text,
              pair: `${baseline} vs ${config}`, sides,
            })
          }
        }
      }
    }
  }

  summary.push({
    config,
    exact: total ? Math.round((exact / total) * 100) : 0,
    adjacent: total ? Math.round((adjacent / total) * 100) : 0,
    mustHave: mustTotal ? Math.round((mustExact / mustTotal) * 100) : 0,
    spearman: spearman(fitPairs),
    cost: usage.get(config).cost,
    perCv: usage.get(config).calls ? usage.get(config).cost / usage.get(config).calls : 0,
    seconds: Math.round(usage.get(config).ms / 1000),
  })
}

console.log(`\n\nAgreement with ${baseline} (${usage.get(baseline).calls} judgements, `
  + `$${usage.get(baseline).cost.toFixed(2)}, $${(usage.get(baseline).cost / Math.max(1, usage.get(baseline).calls)).toFixed(3)}/CV)\n`)

console.log('CONFIG            ALL   ADJACENT  MUST-HAVE  RANKS   $/CV     TOTAL')
for (const row of summary) {
  console.log(
    `${row.config.padEnd(17)} ${String(`${row.exact}%`).padStart(4)}  `
    + `${String(`${row.adjacent}%`).padStart(7)}  ${String(`${row.mustHave}%`).padStart(8)}  `
    + `${row.spearman.toFixed(2).padStart(5)}  $${row.perCv.toFixed(3)}  $${row.cost.toFixed(2)}`,
  )
}

console.log('\nThe rule: adopt the cheapest configuration at or above 90% on MUST-HAVE')
console.log('and 0.90 on RANKS — then read the disagreements below before deciding.')
console.log('A high score is a reason to look, not a decision.\n')

const blind = disagreements.map((row, index) => (
  `${index + 1}. ${row.job} / ${row.cv}\n`
  + `   requirement: ${row.requirement}\n`
  + row.sides.map((side, at) => (
    `   reading ${'AB'[at]}: ${side.verdict}\n`
    + (side.quote ? `      quote: "${side.quote}"\n` : '')
    + (side.reason ? `      because: ${side.reason}\n` : '')
  )).join('')
)).join('\n')

const key = disagreements.map((row, index) => `${index + 1}. ${row.pair} — A/B order was sorted by verdict text`).join('\n')

fs.writeFileSync(path.join(OUT, 'disagreements.txt'),
  `Must-have disagreements, ${new Date().toISOString()}\n\n`
  + 'Read these before looking at the key. Decide which reading you would want a\n'
  + 'recruiter to see; then open key.txt to find out which setup produced it.\n\n'
  + blind, 'utf8')

fs.writeFileSync(path.join(OUT, 'key.txt'), key, 'utf8')
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ baseline, summary }, null, 2), 'utf8')

console.log(`${disagreements.length} must-have disagreements written to eval/out/disagreements.txt`)
console.log('Read them first. The key is in eval/out/key.txt.\n')

/** Rank correlation. Ties are averaged, which matters: fits repeat a lot. */
function spearman(pairs) {
  if (pairs.length < 2) return 1
  const rank = (values) => {
    const order = values.map((value, index) => [value, index]).sort((a, b) => a[0] - b[0])
    const ranks = new Array(values.length)
    let at = 0
    while (at < order.length) {
      let end = at
      while (end + 1 < order.length && order[end + 1][0] === order[at][0]) end += 1
      const mean = (at + end) / 2 + 1
      for (let i = at; i <= end; i += 1) ranks[order[i][1]] = mean
      at = end + 1
    }
    return ranks
  }

  const a = rank(pairs.map((p) => p[0]))
  const b = rank(pairs.map((p) => p[1]))
  const n = a.length
  const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length
  const ma = mean(a)
  const mb = mean(b)

  let top = 0
  let la = 0
  let lb = 0
  for (let i = 0; i < n; i += 1) {
    top += (a[i] - ma) * (b[i] - mb)
    la += (a[i] - ma) ** 2
    lb += (b[i] - mb) ** 2
  }

  return la === 0 || lb === 0 ? 1 : top / Math.sqrt(la * lb)
}
