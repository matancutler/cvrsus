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
import './env.mjs'

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { analyseJobDescription, analyseMatch, isConfigured } from '../src/ai.js'
import { costOf } from '../src/costs.js'
import { requirementsFrom } from '../src/matching/analysis.js'
import { scoreAgainst } from '../src/matching/score.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/*
 * eval-material, not eval, and the difference mattered more than it looks.
 *
 * The harness read <root>/eval while every real CV on this machine sat in
 * <root>/eval-material/cvs — so it reported "no material" with five CVs on
 * disk, and the answer to "why has the eval never run" was a folder name.
 * Both are gitignored; this is the one people actually put things in.
 */
const DIR = path.join(ROOT, 'eval-material')
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
    console.log('\nPut real job ads in eval-material/jobs/*.txt and real CVs in eval-material/cvs/*.txt.')
    console.log('Public job ads are fine. Fixtures check the plumbing, not the judgement —')
    console.log('every configuration agrees on a tidy invented CV, which is what makes')
    console.log('invented CVs useless for this particular question.')
  }
  console.log('')
  process.exit(0)
}

/* ------------------------------------------------- extraction agreement --- */

/*
 * A different question from the rest of this file, so a different mode.
 *
 * Everything below measures JUDGEMENT: does a cheaper model rank candidates
 * the way the expensive one does. This measures READING: does a cheaper model
 * pull the same facts off a CV. They are not the same question and the answer
 * is probably not the same either — reading a document for what it says is the
 * task small models are best at, and judging a person against a role is the
 * one they are worst at.
 *
 * It matters because extraction runs on Opus today, once per CV, at roughly
 * 2.4 cents. It is a read-and-report task already running at effort: low. If
 * Haiku agrees with Opus on titles, skills and dates, that is the single
 * cheapest saving available in this product, and it is invisible to a
 * recruiter because nothing about the ranking changes.
 *
 * PROPOSAL ONLY. This measures and prints. It changes no default, and the
 * production extraction model is still MODEL in ai.js.
 *
 * Agreement is measured per field rather than as one number, because the
 * fields fail differently. A wrong title is visible on every card. A missing
 * skill is invisible and costs retrieval. A wrong date shifts seniority and
 * therefore the ranking. One percentage across the three would hide which of
 * those is happening.
 */
if (has('extraction')) {
  const EXTRACTION_MODELS = String(flag('models', 'claude-opus-5,claude-sonnet-5,claude-haiku-4-5'))
    .split(',').map((m) => m.trim()).filter(Boolean)

  const [BASELINE, ...CHALLENGERS] = EXTRACTION_MODELS

  console.log(`\nExtraction agreement: ${cvs.length} CVs x ${EXTRACTION_MODELS.length} models`)
  console.log(`  baseline: ${BASELINE}`)
  console.log(`  against : ${CHALLENGERS.join(', ') || '(nothing)'}`)
  console.log('')

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

  const { extractProfileFields } = await import('../src/ai.js')
  const { priceOf } = await import('../src/costs.js')

  const norm = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const setOf = (list) => new Set((list ?? []).map(norm).filter(Boolean))

  /* Jaccard, not "how many of the baseline's did it find". A model that
     returns forty skills would score perfectly on recall alone while burying
     the profile in noise, and noise in a skills list is what retrieval reads. */
  const overlap = (a, b) => {
    const A = setOf(a)
    const B = setOf(b)
    if (A.size === 0 && B.size === 0) return 1
    const shared = [...A].filter((x) => B.has(x)).length
    return shared / (A.size + B.size - shared)
  }

  /* Dates as a sorted list of year pairs: the same history read in a
     different order is the same history. */
  const dates = (history) => (history ?? [])
    .map((role) => `${role?.start_year ?? '?'}-${role?.end_year ?? '?'}`)
    .sort().join('|')

  const results = new Map(EXTRACTION_MODELS.map((m) => [m, { profiles: new Map(), cost: 0, ms: 0 }]))

  for (const cv of cvs) {
    for (const model of EXTRACTION_MODELS) {
      const started = Date.now()
      let profile = null
      try {
        profile = await extractProfileFields(cv.text, { model })
      } catch (error) {
        console.warn(`  ${model} failed on ${cv.name}: ${error.message}`)
      }
      const slot = results.get(model)
      slot.ms += Date.now() - started
      const usage = profile?.usage ?? {}
      const price = priceOf(model)
      slot.cost += ((usage.inputTokens ?? usage.input_tokens ?? 0) * price.input
        + (usage.outputTokens ?? usage.output_tokens ?? 0) * price.output) / 1_000_000
      slot.profiles.set(cv.name, profile)
    }
    console.log(`  read ${cv.name}`)
  }

  console.log('')
  console.log('AGREEMENT WITH ' + BASELINE.toUpperCase())
  console.log('')
  console.log('model                 title   skills   dates   seniority   cost/CV   s/CV')
  console.log('-'.repeat(78))

  const pct = (n) => `${Math.round(n * 100)}%`.padStart(5)

  for (const model of EXTRACTION_MODELS) {
    const slot = results.get(model)
    const base = results.get(BASELINE)
    let title = 0
    let skills = 0
    let when = 0
    let seniority = 0
    let counted = 0

    for (const cv of cvs) {
      const a = base.profiles.get(cv.name)
      const b = slot.profiles.get(cv.name)
      if (!a || !b) continue
      counted += 1
      if (norm(a.current_title) === norm(b.current_title)) title += 1
      skills += overlap(a.skills, b.skills)
      if (dates(a.employment_history) === dates(b.employment_history)) when += 1
      if (norm(a.seniority) === norm(b.seniority)) seniority += 1
    }

    if (counted === 0) { console.log(`${model.padEnd(22)}(no comparable readings)`); continue }
    console.log(
      model.padEnd(22)
      + pct(title / counted) + '   ' + pct(skills / counted) + '    '
      + pct(when / counted) + '      ' + pct(seniority / counted) + '     '
      + `$${(slot.cost / cvs.length).toFixed(4)}`.padStart(7) + '  '
      + (slot.ms / cvs.length / 1000).toFixed(1).padStart(5),
    )
  }

  console.log('')
  console.log('Title and dates are exact-match; skills is Jaccard overlap, so a model')
  console.log('that pads the list is penalised as much as one that misses entries.')
  console.log('')
  console.log('PROPOSAL ONLY - no default was changed. Extraction still runs on the')
  console.log('model named in ai.js. What would make a switch defensible: agreement at')
  console.log('or above roughly 95% on title and dates, since both move the ranking,')
  console.log('and no systematic direction to the skills the cheaper model drops.')
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

  /*
   * The model's answer, in the shape the rest of the product reads.
   *
   * analyseJobDescription returns the raw JSON: must_haves, work_arrangement,
   * location at the top level. requirementsFrom reads mustHaves, and
   * jobProfile.js does that conversion on the production path — which this
   * script does not go through.
   *
   * So `matchProfile.mustHaves` was undefined and take() took nothing, while
   * `preferred` and `contextual` happen to be spelled the same in both shapes
   * and came through fine. The eval ran on a requirement list with EVERY
   * MUST-HAVE MISSING: not demoted, absent. Every fit it computed was a
   * judgement about the optional half of the job, and the MUST-HAVE column
   * compared zero requirements and printed 0%, which read as total
   * disagreement rather than as nothing measured.
   *
   * Converted here rather than made tolerant in requirementsFrom: a scorer
   * that silently accepts two shapes is how one of them stops being tested.
   */
  const matchProfile = {
    title: profile.title ?? null,
    interpretation: profile.interpretation ?? null,
    mustHaves: profile.must_haves ?? [],
    preferred: profile.preferred ?? [],
    contextual: profile.contextual ?? [],
    hardConstraints: profile.hard_constraints ?? [],
    logistics: {
      location: profile.location ?? null,
      workArrangement: profile.work_arrangement ?? null,
      languages: profile.languages_required ?? [],
    },
  }

  const requirements = requirementsFrom(matchProfile)

  if (requirements.filter((r) => r.tier === 'must_have').length === 0) {
    console.log('  no must-have requirements were read from this job description')
  }

  const criteria = {
    title: matchProfile.title ?? '',
    jobDescription: job.text,
    requirements,
    location: matchProfile.logistics.location,
    workArrangement: matchProfile.logistics.workArrangement,
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
              /*
               * The same case, NOT blinded, for the machine-readable dump.
               *
               * `sides` above is deliberately sorted by verdict text so a
               * person reading disagreements.txt cannot tell which setup
               * produced which reading — that blinding is the point of the
               * file. But it also made the file unusable for any later
               * analysis that needs to say "the current setting said X and
               * medium said Y", and re-running the eval to recover an
               * attribution it already had is paying twice for one answer.
               */
              attributed: {
                requirementId: requirement.id,
                tier: requirement.tier,
                [baseline]: {
                  verdict: a,
                  quote: base.byId.get(requirement.id)?.quote ?? '',
                  reason: base.byId.get(requirement.id)?.reason ?? '',
                },
                [config]: {
                  verdict: b,
                  quote: other.byId.get(requirement.id)?.quote ?? '',
                  reason: other.byId.get(requirement.id)?.reason ?? '',
                },
              },
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
    /* null, not 0, when nothing was compared. Printing 0% for "no must-have
       requirements existed" is the difference between a configuration that
       disagrees about everything and one nobody asked — and the adoption
       rule below reads this column. */
    mustHave: mustTotal ? Math.round((mustExact / mustTotal) * 100) : null,
    mustTotal,
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
    + `${String(`${row.adjacent}%`).padStart(7)}  `
    + `${String(row.mustHave === null ? 'none' : `${row.mustHave}%`).padStart(8)}  `
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

/*
 * The same disagreements, attributed and machine-readable.
 *
 * disagreements.txt is for a person to read blind; this is for anything that
 * has to work with the data afterwards. Written alongside rather than instead,
 * because opening this one first defeats the blinding — which is why it is a
 * .json nobody reads by accident.
 */
fs.writeFileSync(
  path.join(OUT, 'disagreements.json'),
  JSON.stringify(disagreements.map((row, index) => ({
    n: index + 1,
    job: row.job,
    cv: row.cv,
    requirement: row.requirement,
    pair: row.pair,
    ...row.attributed,
  })), null, 2),
  'utf8',
)
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ baseline, summary }, null, 2), 'utf8')

console.log(`${disagreements.length} must-have disagreements written to ${path.relative(ROOT, OUT)}/disagreements.txt`)
console.log('Read them first. The key is in ${path.relative(ROOT, OUT)}/key.txt.\n')

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
