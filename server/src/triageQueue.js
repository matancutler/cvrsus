/**
 * The Triage pipeline, off the request thread.
 *
 * Three hundred CVs cannot be processed inside an HTTP request, and Section 2.4
 * is explicit that processing must not depend on the browser tab staying open.
 * So a launch writes rows and returns; everything after that happens here.
 *
 * The queue is a table, not an in-memory list. That is the whole design:
 *
 *   - a worker crash loses at most the batch in flight, and the rest is still
 *     sitting in triage_batches waiting to be picked up;
 *   - restarting the server resumes rather than restarts, because progress is
 *     recorded per applicant as it happens rather than at the end;
 *   - and re-crossing a tranche boundary cannot duplicate work, because the
 *     UNIQUE index on idem_key refuses the second insert rather than trusting
 *     the caller to have checked first.
 *
 * There is no Redis here and no separate worker process, deliberately. This app
 * is one Node process with a local SQLite file; adding a broker would add an
 * operational dependency to gain durability the database already provides.
 *
 *   Stage A  parse       every file -> text, and who the CV is about
 *            preliminary the JD once, then a cheap pass over the WHOLE pile
 *   Stage B  initial     deep analysis of preliminary ranks 1-50
 *            rolling     deep analysis of the next 25, on demand
 */
import fs from 'node:fs'
import path from 'node:path'

import db, { UPLOAD_DIR } from './db.js'
import { extractText } from './extract.js'
import { analyseJobDescription, analyseMatch, deterministicContact, isConfigured as aiConfigured, MODEL } from './ai.js'
import { keywordsFrom, parseJobDescription, scoreCandidate } from './match.js'
import { VERSIONS } from './matching/config.js'
import { TRIAGE, rawTriage, recount } from './triage.js'
import { refundTriageCvs } from './wallet.js'

const now = () => new Date().toISOString()

/* One pump at a time per process. Batches run in order; the parallelism that
   matters is inside a batch, where it is bounded explicitly. */
let pumping = false
let stopped = false

// ---------------------------------------------------------------- queueing ---

/**
 * Adds a unit of work, exactly once.
 *
 * The key is the identity of the work, not of the request: the same range of
 * the same Triage is the same batch however many times it is asked for. Section
 * 3.3's "refreshing, opening multiple tabs or revisiting the boundary must
 * never cause the same candidate batch to be charged or processed twice" is
 * this INSERT and its unique index, and nothing else.
 */
export function enqueue({ triageId, kind, fromRank = null, toRank = null }) {
  const idem = `${triageId}:${kind}:${fromRank ?? '-'}:${toRank ?? '-'}`

  const info = db.prepare(`
    INSERT OR IGNORE INTO triage_batches (triage_id, kind, from_rank, to_rank, idem_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(triageId, kind, fromRank, toRank, idem, now())

  // changes === 0 means it already existed, which is a success: the work is
  // either queued, running or done, and in every case it is not owed twice.
  return { queued: info.changes > 0, idem }
}

/**
 * Re-queues anything that was in flight when the process died.
 *
 * Called on boot. A batch left 'running' has no worker behind it — nothing else
 * in the system can set that status — so it is safe to reclaim, and leaving it
 * would strand a Triage forever in "processing" with nobody working on it.
 */
export function resumeQueue() {
  const stranded = db.prepare(`
    UPDATE triage_batches SET status = 'queued', started_at = NULL
    WHERE status = 'running'
  `).run()

  /*
   * The applicants inside those batches have to be released too.
   *
   * runDeep claims its rows by setting deep_status = 'running', and only picks
   * up rows that are pending, queued or failed. So a batch that died mid-flight
   * left its applicants marked 'running' with nothing running: re-queueing the
   * batch alone made it find zero rows to do, mark itself done, and advance the
   * frontier past twenty people who were never analysed — a silent hole in the
   * middle of the ranking, with the Triage reporting itself healthy.
   *
   * Nothing but a live worker sets this status, so any row still holding it at
   * boot is abandoned by definition and safe to reset. The two resets belong in
   * one function because they are one fact: the process that owned this work is
   * gone.
   */
  const orphaned = db.prepare(`
    UPDATE triage_applicants SET deep_status = 'pending' WHERE deep_status = 'running'
  `).run()

  if (stranded.changes > 0 || orphaned.changes > 0) {
    console.log(
      `  triage: reclaimed ${stranded.changes} batch(es) and `
      + `${orphaned.changes} applicant(s) from a previous run`,
    )
  }

  const waiting = db.prepare(`SELECT COUNT(*) AS n FROM triage_batches WHERE status = 'queued'`).get().n
  if (waiting > 0) pump()
  return { reclaimed: stranded.changes, waiting }
}

export function stopQueue() {
  stopped = true
}

/**
 * Drains the queue.
 *
 * Fire-and-forget: callers start it and do not wait, because the point is that
 * the request returns. Errors are contained per batch — one Triage failing must
 * not stop every other organization's work, which is what an uncaught throw out
 * of this loop would do.
 */
export function pump() {
  if (pumping || stopped) return
  pumping = true

  ;(async () => {
    try {
      for (;;) {
        const batch = claim()
        if (!batch) break
        await runBatch(batch)
      }
    } catch (error) {
      console.error(`  triage: pump stopped unexpectedly: ${error.message}`)
    } finally {
      pumping = false
      /* Something may have been queued while the loop was on its last
         iteration — a rolling tranche the batch itself enqueued, typically.
         Checking once here is cheaper than polling and closes that window. */
      const waiting = db.prepare(
        `SELECT COUNT(*) AS n FROM triage_batches WHERE status = 'queued'`,
      ).get().n
      if (waiting > 0 && !stopped) setImmediate(pump)
    }
  })()
}

/** Takes the next queued batch and marks it running, in one statement. */
function claim() {
  return db.transaction(() => {
    const batch = db.prepare(`
      SELECT * FROM triage_batches WHERE status = 'queued' ORDER BY id LIMIT 1
    `).get()

    if (!batch) return null

    db.prepare(`
      UPDATE triage_batches SET status = 'running', started_at = ?, attempts = attempts + 1
      WHERE id = ?
    `).run(now(), batch.id)

    return { ...batch, attempts: batch.attempts + 1 }
  })()
}

async function runBatch(batch) {
  const started = Date.now()

  try {
    const triage = rawTriage(batch.triage_id)
    // The Triage was deleted while its work was queued. Not an error.
    if (!triage) {
      finish(batch.id, 'done')
      return
    }

    if (batch.kind === 'parse') await runParse(triage, batch)
    else if (batch.kind === 'preliminary') await runPreliminary(triage, batch)
    else await runDeep(triage, batch)

    finish(batch.id, 'done')
  } catch (error) {
    /*
     * Retry with backoff, then give up cleanly.
     *
     * Section 8 asks for capped attempts and a permanent failure that is
     * exposed rather than hidden. A batch that has run out of attempts marks
     * itself failed and says why; the Triage above it only fails if the batch
     * that failed was the one it could not proceed without.
     */
    const permanent = batch.attempts >= TRIAGE.maxAttempts

    db.prepare(`
      UPDATE triage_batches SET status = ?, error = ?, finished_at = ? WHERE id = ?
    `).run(permanent ? 'failed' : 'queued', String(error.message).slice(0, 500),
      permanent ? now() : null, batch.id)

    if (permanent) {
      console.error(`  triage ${batch.triage_id}: ${batch.kind} batch failed permanently — ${error.message}`)
      if (batch.kind === 'parse' || batch.kind === 'preliminary') {
        db.prepare(`UPDATE triages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
          .run(`Processing could not complete: ${error.message}`.slice(0, 300), now(), batch.triage_id)

        /*
         * A Triage that failed before anything could be read owes the recruiter
         * everything it took. Charging for a batch that produced no ranking is
         * not a billing edge case — it is taking money for nothing, and the
         * failure is ours.
         *
         * The whole charge goes back, because a parse or preliminary failure
         * means no applicant was analysed at all. A refund of the total is
         * idempotent for the same reason the unreadable sweep is.
         */
        const failed = rawTriage(batch.triage_id)
        if (failed?.company_id && failed.charged_cvs > 0) {
          const back = refundTriageCvs({
            companyId: failed.company_id, triageId: batch.triage_id,
            totalCvs: failed.charged_cvs,
            note: 'CVs returned — this Triage could not be processed',
          })
          if (back.refunded > 0) {
            console.log(`  triage ${batch.triage_id}: returned ${back.refunded} CV(s) after a failure`)
          }
        }
      }
    } else {
      await sleep(backoffMs(batch.attempts))
    }
  } finally {
    cost({
      triageId: batch.triage_id, batchId: batch.id, stage: batch.kind,
      durationMs: Date.now() - started, retries: Math.max(0, batch.attempts - 1),
    })
  }
}

function finish(batchId, status) {
  db.prepare(`UPDATE triage_batches SET status = ?, finished_at = ? WHERE id = ?`)
    .run(status, now(), batchId)
}

const backoffMs = (attempt) => Math.min(30000, 500 * 2 ** (attempt - 1))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ------------------------------------------------------- Stage A: parsing ---

/**
 * Reads every unparsed file in the Triage.
 *
 * One bad file must not fail the batch, so every failure is caught and recorded
 * against its own row. That is the difference between "12 of your 300 CVs could
 * not be read" and "your Triage failed", and only one of those is something a
 * recruiter can do anything about.
 */
async function runParse(triage, batch) {
  const pending = db.prepare(`
    SELECT id, file_name, stored_name FROM triage_applicants
    WHERE triage_id = ? AND parse_status = 'pending' ORDER BY id
  `).all(triage.id)

  let read = 0
  await inParallel(pending, TRIAGE.parseConcurrency, async (row) => {
    try {
      const filePath = path.join(UPLOAD_DIR, row.stored_name)
      if (!fs.existsSync(filePath)) throw new Error('The uploaded file is no longer on disk.')

      const text = await extractText(filePath, row.file_name)

      /*
       * A scanned PDF has no text layer and yields nothing. Marked unreadable
       * rather than parsed-with-empty-text: Section 10 says to mark it rather
       * than hallucinate content, and an empty CV that reached the analyser
       * would come back with a confident score based on no evidence at all.
       */
      if (!text || text.trim().length < 40) {
        markUnreadable(row.id, 'No readable text — this looks like a scan or an image-only PDF.')
        return
      }

      const contact = deterministicContact(text)
      const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || null

      db.prepare(`
        UPDATE triage_applicants
        SET extracted_text = ?, display_name = ?, email = ?, phone = ?, location = ?,
            parsed_fields = ?, parse_status = 'parsed', parse_error = NULL
        WHERE id = ?
      `).run(
        text.slice(0, TRIAGE.maxTextChars), name, contact.email, contact.phone,
        contact.city, JSON.stringify(contact), row.id,
      )
      read += 1
    } catch (error) {
      markUnreadable(row.id, String(error.message).slice(0, 300), 'failed')
    }
  })

  recount(triage.id)
  cost({ triageId: triage.id, batchId: batch.id, stage: 'parse:files', applicants: read })

  /*
   * Hand back the capacity for files that turned out not to be CVs.
   *
   * A file is charged when it is accepted into the processing set, because that
   * is the only moment the count is knowable — extraction runs here, minutes
   * after the recruiter confirmed. A scanned photograph of a CV passes every
   * check at upload and only fails once we try to read words out of it.
   *
   * So the difference is returned. "One valid CV consumes capacity once" is
   * only true if a file that was never readable stops being charged for, and
   * the alternative — making the recruiter wait for 300 extractions before
   * showing them a price — would trade a refund for several minutes of staring
   * at a spinner.
   */
  const unreadable = db.prepare(`
    SELECT COUNT(*) AS n FROM triage_applicants
    WHERE triage_id = ? AND parse_status IN ('unreadable', 'failed')
  `).get(triage.id).n

  if (unreadable > 0 && triage.company_id) {
    /* The TOTAL that should have gone back for this Triage, not a delta — this
       sweep can run again after a retry or a crash and will report the same
       number, and refundTriageCvs pays only the difference. */
    const back = refundTriageCvs({
      companyId: triage.company_id, triageId: triage.id, totalCvs: unreadable,
      note: `CV${unreadable === 1 ? '' : 's'} returned — the file could not be read`,
    })
    if (back.refunded > 0) {
      console.log(`  triage ${triage.id}: returned ${back.refunded} CV(s) of capacity`)
    }
  }

  // Ranking cannot start until every file has been read: a preliminary order
  // built over half the pile would put the second half behind all of it.
  enqueue({ triageId: triage.id, kind: 'preliminary' })
}

function markUnreadable(id, message, status = 'unreadable') {
  db.prepare(`
    UPDATE triage_applicants SET parse_status = ?, parse_error = ?, deep_status = 'pending'
    WHERE id = ?
  `).run(status, message, id)
}

// --------------------------------------------- Stage A: preliminary order ---

/**
 * Reads the JD once, then orders the whole pile against it cheaply.
 *
 * Two things are happening and only one of them is expensive. The JD is parsed
 * by the model — once, for the entire Triage, which is what makes it affordable
 * — and every applicant is then scored against the result by the deterministic
 * scorer, which costs nothing per CV.
 *
 * That asymmetry is the feature. Section 3.1 asks for a deliberately
 * inexpensive pass optimised for recall and useful ordering rather than for
 * being right; spending model tokens on all 300 here would cost as much as the
 * deep analysis and make the whole progressive design pointless.
 *
 * Nobody is removed. A low preliminary score means "read later", never "reject"
 * — Section 1 forbids discarding, and the only thing this order decides is who
 * is analysed first.
 */
async function runPreliminary(triage, batch) {
  const profile = await ensureMatchProfile(triage, batch)

  const applicants = db.prepare(`
    SELECT id, display_name, extracted_text, location FROM triage_applicants
    WHERE triage_id = ? AND parse_status = 'parsed'
  `).all(triage.id)

  const criteria = {
    title: profile.title ?? '',
    jobDescription: triage.raw_jd,
    requiredSkills: (profile.mustHaves ?? []).map((item) => item.requirement ?? item).filter(Boolean),
    preferredSkills: (profile.preferred ?? []).map((item) => item.requirement ?? item).filter(Boolean),
    keywords: profile.keywords ?? keywordsFrom(triage.raw_jd),
  }

  const ranked = applicants
    .map((row) => ({
      id: row.id,
      score: scoreCandidate(
        { cv_text: row.extracted_text, current_title: null, desired_role: null, notes: null, skills: [] },
        criteria,
      ).score,
    }))
    /* Ties broken by id, which is upload order. Deterministic on purpose: a
       preliminary order that shuffled between runs would make the rolling
       tranches non-reproducible and any cost comparison meaningless. */
    .sort((a, b) => b.score - a.score || a.id - b.id)

  const write = db.prepare(
    `UPDATE triage_applicants SET prelim_score = ?, prelim_rank = ? WHERE id = ?`,
  )
  db.transaction(() => {
    ranked.forEach((entry, index) => write.run(entry.score, index + 1, entry.id))
    db.prepare(`UPDATE triages SET prelim_done_at = ?, updated_at = ? WHERE id = ?`)
      .run(now(), now(), triage.id)
  })()

  cost({
    triageId: triage.id, batchId: batch.id, stage: 'preliminary:rank',
    applicants: ranked.length,
  })

  if (ranked.length === 0) {
    db.prepare(`
      UPDATE triages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
    `).run(
      'None of the uploaded files could be read as text.', now(), triage.id,
    )
    return
  }

  // Section 3.2 — the first fifty, immediately, without waiting to be asked.
  enqueue({
    triageId: triage.id, kind: 'initial',
    fromRank: 1, toRank: Math.min(TRIAGE.initialDeep, ranked.length),
  })
}

/**
 * The JD as structured criteria, parsed once per Triage and cached on the row.
 *
 * Falls back to the deterministic reader when no model is configured or the
 * call fails. A JD that a model cannot parse is still a JD worth ranking
 * against — the same decision Search makes, and for the same reason.
 */
async function ensureMatchProfile(triage, batch) {
  const cached = triage.match_profile ? safeJson(triage.match_profile) : null
  if (cached) return cached

  const started = Date.now()
  const parsed = await analyseJobDescription({ jobDescription: triage.raw_jd })

  const profile = parsed
    ? {
      title: parsed.title ?? null,
      interpretation: parsed.interpretation ?? null,
      hardConstraints: parsed.hard_constraints ?? [],
      mustHaves: parsed.must_haves ?? [],
      preferred: parsed.preferred ?? [],
      contextual: parsed.contextual ?? [],
      industries: parsed.industries ?? [],
      functions: parsed.functions ?? [],
      specializations: parsed.specializations ?? [],
      logistics: {
        location: parsed.location ?? null,
        workArrangement: parsed.work_arrangement ?? null,
        languages: parsed.languages_required ?? [],
      },
      keywords: keywordsFrom(triage.raw_jd),
      source: 'claude',
    }
    : deterministicProfile(triage.raw_jd)

  db.prepare(`
    UPDATE triages SET match_profile = ?, profile_source = ?, title = COALESCE(title, ?), updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(profile), profile.source,
    /* Section 2.2 — suggest the title from the JD once it has been read, while
       leaving a title the recruiter typed alone. COALESCE does exactly that. */
    profile.title, now(), triage.id,
  )

  cost({
    triageId: triage.id, batchId: batch.id, stage: 'preliminary:jd',
    model: parsed ? MODEL : 'deterministic', durationMs: Date.now() - started, applicants: 1,
  })

  return profile
}

function deterministicProfile(rawJd) {
  const parsed = parseJobDescription(rawJd)
  return {
    title: parsed.title || null,
    interpretation: null,
    hardConstraints: [],
    mustHaves: parsed.requiredSkills.map((requirement) => ({ requirement })),
    preferred: parsed.preferredSkills.map((requirement) => ({ requirement })),
    contextual: [],
    industries: [],
    functions: [],
    specializations: [],
    logistics: { location: null, workArrangement: null, languages: [] },
    keywords: keywordsFrom(rawJd),
    source: 'deterministic',
  }
}

// ------------------------------------------------- Stage B: deep analysis ---

/**
 * The expensive pass, over one range of preliminary ranks.
 *
 * Same analyser, same criteria classes and same absolute-fit meaning as Cursus
 * Search, because Section 4 requires the score to be recognisable as the same
 * system. Normalisation is NOT done here — it happens at read time across every
 * applicant scored so far, which is what stops a weak second tranche minting a
 * fresh 100 and is the reason that logic lives in one shared module.
 */
async function runDeep(triage, batch) {
  const rows = db.prepare(`
    SELECT * FROM triage_applicants
    WHERE triage_id = ? AND parse_status = 'parsed'
      AND prelim_rank BETWEEN ? AND ?
      AND deep_status IN ('pending', 'queued', 'failed')
    ORDER BY prelim_rank
  `).all(triage.id, batch.from_rank, batch.to_rank)

  // Everything in this range is already scored — a re-crossed boundary, or a
  // resumed batch that finished its work before the process died.
  if (rows.length === 0) {
    advanceFrontier(triage.id, batch.to_rank)
    settleStatus(triage.id)
    return
  }

  const ids = rows.map((row) => row.id)
  db.prepare(`
    UPDATE triage_applicants SET deep_status = 'running'
    WHERE id IN (${ids.map(() => '?').join(',')})
  `).run(...ids)

  const profile = safeJson(triage.match_profile) ?? deterministicProfile(triage.raw_jd)
  const criteria = {
    title: profile.title ?? '',
    jobDescription: triage.raw_jd,
    requiredSkills: (profile.mustHaves ?? []).map((item) => item.requirement ?? item).filter(Boolean),
    preferredSkills: (profile.preferred ?? []).map((item) => item.requirement ?? item).filter(Boolean),
    keywords: profile.keywords ?? [],
  }

  const started = Date.now()
  let inputTokens = 0
  let outputTokens = 0
  let scored = 0

  await inParallel(rows, TRIAGE.analysisConcurrency, async (row) => {
    try {
      const record = await analyseApplicant({ triage, row, criteria })
      inputTokens += record.usage?.inputTokens ?? 0
      outputTokens += record.usage?.outputTokens ?? 0

      db.prepare(`
        UPDATE triage_applicants
        SET deep_status = 'scored', absolute_fit = ?, criteria = ?, explanation = ?,
            analysis_model = ?, scoring_version = ?, analysis_source = ?, analysed_at = ?,
            deep_error = NULL
        WHERE id = ?
      `).run(
        record.absoluteFit, JSON.stringify(record.criteria), record.explanation,
        record.model, VERSIONS.scoring, record.source, now(), row.id,
      )
      scored += 1
    } catch (error) {
      /*
       * Failed on this one applicant only. Left as 'failed' rather than
       * retried inside the batch: the deterministic fallback below already
       * catches the ordinary case of the model declining, so reaching here
       * means something structural, and hammering it 25 times would turn one
       * bad row into a stalled Triage.
       */
      db.prepare(`UPDATE triage_applicants SET deep_status = 'failed', deep_error = ? WHERE id = ?`)
        .run(String(error.message).slice(0, 300), row.id)
    }
  })

  recount(triage.id)
  advanceFrontier(triage.id, batch.to_rank)

  cost({
    triageId: triage.id, batchId: batch.id, stage: `deep:${batch.kind}`,
    model: aiConfigured() ? MODEL : 'deterministic',
    applicants: scored, durationMs: Date.now() - started,
    inputTokens: inputTokens || null, outputTokens: outputTokens || null,
  })

  settleStatus(triage.id)
}

/**
 * One applicant against the JD.
 *
 * The deterministic score is computed regardless and kept as the fallback, so a
 * model refusal or a timeout costs that applicant their explanation but never
 * their place in the ranking. Losing someone from the list entirely because a
 * request failed is the one outcome a triage product cannot have.
 */
async function analyseApplicant({ triage, row, criteria }) {
  const fallback = scoreCandidate(
    { cv_text: row.extracted_text, skills: [] },
    criteria,
  )

  const ai = aiConfigured()
    ? await analyseMatch({
      jobDescription: triage.raw_jd,
      criteria,
      /* Shaped like a marketplace candidate for the analyser's benefit only.
         Nothing here is written back to `candidates`, and this object never
         leaves the function. */
      candidate: {
        id: row.id,
        display_name: row.display_name,
        location: row.location,
        cv_text: row.extracted_text,
      },
      profile: null,
    })
    : null

  if (!ai) {
    return {
      absoluteFit: fallback.score,
      criteria: {
        items: criteriaItems(fallback),
        breakdown: fallback.breakdown ?? null,
      },
      explanation: null,
      source: 'deterministic',
      model: 'deterministic',
      usage: null,
    }
  }

  return {
    absoluteFit: ai.score,
    criteria: {
      fit: ai.fit,
      confidence: ai.confidence,
      strengths: ai.strengths,
      gaps: ai.gaps,
      transferable: ai.transferable,
      evidence: ai.evidence,
      probes: ai.probes,
      items: criteriaItems(fallback),
    },
    explanation: ai.reasoning,
    source: 'claude',
    model: ai.model_version ?? MODEL,
    usage: ai.usage ?? null,
  }
}

/** The requirement-by-requirement view, in the shape Search already renders. */
function criteriaItems(result) {
  return [
    ...(result.matchedRequired ?? []).map((r) => ({ requirement: r, class: 'must-have', assessment: 'meets' })),
    ...(result.missingRequired ?? []).map((r) => ({ requirement: r, class: 'must-have', assessment: 'no evidence' })),
    ...(result.matchedPreferred ?? []).map((r) => ({ requirement: r, class: 'preferred', assessment: 'meets' })),
    ...(result.missingPreferred ?? []).map((r) => ({ requirement: r, class: 'preferred', assessment: 'no evidence' })),
  ]
}

/** The frontier only ever moves forward, however batches interleave. */
function advanceFrontier(triageId, toRank) {
  db.prepare(`
    UPDATE triages SET analysis_frontier = MAX(analysis_frontier, ?), updated_at = ? WHERE id = ?
  `).run(toRank ?? 0, now(), triageId)
}

/**
 * Moves the Triage between processing, ready and completed.
 *
 * 'ready' the moment anything is scored, because the recruiter can start
 * reading then; 'completed' only when nobody is left unanalysed. The
 * distinction is what lets the workspace say "50 of 327 fully analysed" rather
 * than implying the whole pile has final scores.
 */
function settleStatus(triageId) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM triage_applicants WHERE triage_id = ? AND deep_status = 'scored') AS scored,
      (SELECT COUNT(*) FROM triage_applicants
        WHERE triage_id = ? AND parse_status = 'parsed' AND deep_status <> 'scored') AS outstanding
  `).get(triageId, triageId)

  const status = row.scored === 0 ? 'processing' : (row.outstanding === 0 ? 'completed' : 'ready')

  db.prepare(`
    UPDATE triages SET status = ?, completed_at = CASE WHEN ? = 'completed' THEN COALESCE(completed_at, ?) ELSE completed_at END, updated_at = ?
    WHERE id = ? AND status NOT IN ('draft', 'failed')
  `).run(status, status, now(), now(), triageId)
}

// ------------------------------------------------------------- the ladder ---

/**
 * Queues the next tranche, if there is one and it is not already queued.
 *
 * Called when the recruiter reaches the end of a page of results. Safe to call
 * on every scroll, every refresh and from every open tab: the frontier decides
 * the range and `enqueue` refuses a duplicate, so the answer to "is more work
 * owed" is computed from stored state rather than from how many times somebody
 * asked.
 */
export function requestNextTranche(triageId) {
  const triage = rawTriage(triageId)
  if (!triage) return { queued: false, reason: 'not_found' }
  if (triage.status === 'draft') return { queued: false, reason: 'not_launched' }

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ? AND parse_status = 'parsed'
  `).get(triageId).n

  const from = triage.analysis_frontier + 1
  if (from > total) return { queued: false, reason: 'exhausted', frontier: triage.analysis_frontier }

  const to = Math.min(triage.analysis_frontier + TRIAGE.tranche, total)
  const result = enqueue({ triageId, kind: 'rolling', fromRank: from, toRank: to })
  pump()

  return { queued: result.queued, from, to, reason: result.queued ? 'queued' : 'already_queued' }
}

/** Starts the pipeline for a Triage that has just been paid for. */
export function startProcessing(triageId) {
  db.prepare(`UPDATE triages SET status = 'processing', updated_at = ? WHERE id = ?`)
    .run(now(), triageId)
  enqueue({ triageId, kind: 'parse' })
  pump()
}

/** Whether any work is outstanding, for the workspace's polling to stop on. */
export function queueDepth(triageId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM triage_batches
    WHERE triage_id = ? AND status IN ('queued', 'running')
  `).get(triageId).n
}

// -------------------------------------------------------------- utilities ---

/**
 * Runs a bounded number of tasks at once.
 *
 * Section 8: "do not launch hundreds of expensive model requests simultaneously
 * just because hundreds of files were uploaded". A queue drained by N workers
 * is the smallest thing that guarantees it.
 */
async function inParallel(items, limit, worker) {
  const queue = [...items]
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await worker(next)
    }
  })
  await Promise.all(workers)
}

/**
 * Writes one line of cost telemetry.
 *
 * Never surfaced to a recruiter — Section 9 says so explicitly — and never
 * allowed to break the pipeline it measures, which is why it swallows its own
 * errors. Losing a telemetry row is a nuisance; losing a Triage because a
 * telemetry row would not insert is not a trade worth making.
 */
function cost({ triageId, batchId = null, stage, model = null, applicants = 0, durationMs = null, inputTokens = null, outputTokens = null, retries = 0 }) {
  try {
    db.prepare(`
      INSERT INTO triage_cost_events (
        triage_id, batch_id, stage, model, applicants, duration_ms,
        input_tokens, output_tokens, retries, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(triageId, batchId, stage, model, applicants, durationMs, inputTokens, outputTokens, retries, now())
  } catch { /* telemetry is not worth failing a Triage over */ }
}

function safeJson(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Per-Triage cost roll-up, for operators. Not a recruiter-facing number. */
export function costSummary(triageId) {
  const rows = db.prepare(`
    SELECT stage, COUNT(*) AS events, SUM(applicants) AS applicants,
           SUM(duration_ms) AS ms, SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens, SUM(retries) AS retries
    FROM triage_cost_events WHERE triage_id = ? GROUP BY stage ORDER BY stage
  `).all(triageId)

  return rows
}
