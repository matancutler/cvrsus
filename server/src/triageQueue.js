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

/* emailKey folds Gmail's dots and +tags, so "n.bar+jobs@gmail.com" and
   "nbar@gmail.com" are one mailbox and one person — the same folding the
   marketplace uses for candidate accounts. Anything else compares as written. */
import db, { UPLOAD_DIR, emailKey } from './db.js'
import { extractText } from './extract.js'
import {
  analyseJobDescription, analyseMatch, deterministicContact,
  isConfigured as aiConfigured, MATCH_MODEL, MODEL,
} from './ai.js'
import { recordCost, sumUsage } from './costs.js'
import { keywordsFrom, parseJobDescription, scoreCandidate } from './match.js'
import { requirementsFrom, withinDailyCeiling } from './matching/analysis.js'
import { deriveHighlights, needsReview, scoreAgainst } from './matching/score.js'
import { VERSIONS } from './matching/config.js'
import { TRIAGE, rawTriage, recount } from './triage.js'
import {
  refundTriageDrop, refundTriageSession, refundUnattributedTriage,
} from './wallet.js'

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
export function enqueue({
  triageId, kind, fromRank = null, toRank = null, dropId = null, keySuffix = null,
}) {
  /*
   * The delivery is part of the identity of the work.
   *
   * Without it the key for a parse pass was `<triage>:parse:-:-` — the same
   * string for every delivery a session would ever take — so the second drop's
   * parse batch hit the unique index, was silently ignored, and its CVs sat at
   * 'pending' for ever while the session reported itself complete. That is the
   * single hardest thing standing between this pipeline and a rolling one, and
   * it is this line.
   */
  /*
   * `keySuffix` is how a deliberate re-run gets past the very index that makes
   * an accidental one free. Re-analysing a range that failed is the same work
   * by every other measure, so without a suffix the INSERT is ignored and the
   * retry silently does nothing. Only the retry path passes one, and it passes
   * a round number, so two retries of the same range are two batches and a
   * double-clicked retry is one.
   */
  const idem = `${triageId}:${dropId ?? '-'}:${kind}:${fromRank ?? '-'}:${toRank ?? '-'}`
    + (keySuffix === null ? '' : `:${keySuffix}`)

  const info = db.prepare(`
    INSERT OR IGNORE INTO triage_batches (triage_id, drop_id, kind, from_rank, to_rank, idem_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(triageId, dropId, kind, fromRank, toRank, idem, now())

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

    /*
     * A failed session is not worked on.
     *
     * Nothing used to check this, and it mattered once a session could hold
     * more than one delivery: a second delivery's parse batch failing before
     * the first had been ranked marked the whole session failed and refunded
     * every CV in it — and then the first delivery's preliminary batch, which
     * was already queued, ran anyway, ranked three hundred CVs and had them
     * all analysed with the money already handed back.
     *
     * Marked failed rather than done, so the batch says what happened rather
     * than claiming work it never did.
     */
    if (triage.status === 'failed') {
      db.prepare(`
        UPDATE triage_batches SET status = 'failed', error = ?, finished_at = ? WHERE id = ?
      `).run('The Triage had already failed.', now(), batch.id)
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

      /*
       * A failure in the FIRST delivery fails the session and hands back what
       * it took. A failure in a later one refunds that delivery and leaves
       * the session alone.
       *
       * A session whose opening pile could not be read produced nothing and
       * owes the recruiter everything. A session holding two hundred analysed
       * CVs whose Friday drop of six could not be read has not failed —
       * failing it there would throw away work that was done correctly and
       * paid for.
       *
       * "First delivery" is asked of the DELIVERY, not of how much has been
       * ranked. It used to be "has anything been ranked yet", which is a
       * proxy and was wrong in the ordinary case: a second delivery arriving
       * while the first is still being read sees nothing ranked, so its own
       * failure would fail the whole session and refund all three hundred
       * CVs. A session that predates deliveries carries its pile at drop_id
       * NULL and is asked separately.
       */
      const firstDrop = db.prepare(
        `SELECT id FROM triage_drops WHERE triage_id = ? ORDER BY seq LIMIT 1`,
      ).get(batch.triage_id)?.id ?? null

      const openingPile = batch.drop_id === null || batch.drop_id === firstDrop
      const reading = batch.kind === 'parse' || batch.kind === 'preliminary'

      if (reading && !openingPile) {
        /*
         * The session carries on — but this delivery's CVs must not vanish,
         * and it must not stay charged.
         *
         * They are sitting at parse_status 'pending', and nothing reports a
         * pending row: the failures list shows unreadable and failed ones, and
         * the counters treat pending as work still to come. Marking them
         * failed puts them where a recruiter can see them.
         */
        db.prepare(`
          UPDATE triage_applicants SET parse_status = 'failed', parse_error = ?
          WHERE triage_id = ? AND drop_id = ? AND parse_status = 'pending'
        `).run(String(error.message).slice(0, 300), batch.triage_id, batch.drop_id)

        /*
         * And the money for it goes back. Under the old model a later
         * delivery was free, so this branch cost the recruiter nothing; now
         * it is charged the moment it is accepted, and a delivery that could
         * not be read is a delivery we took money for and did nothing with.
         */
        const delivery = db.prepare(
          `SELECT charged_cvs AS charged FROM triage_drops WHERE id = ?`,
        ).get(batch.drop_id)
        const owner = rawTriage(batch.triage_id)

        if (owner?.company_id && (delivery?.charged ?? 0) > 0) {
          const back = refundTriageDrop({
            companyId: owner.company_id, dropId: batch.drop_id,
            totalCvs: delivery.charged,
            note: 'CVs returned — this delivery could not be processed',
          })
          if (back.refunded > 0) {
            console.log(`  triage ${batch.triage_id}: returned ${back.refunded} CV(s) for a delivery that failed`)
          }
        }

        recount(batch.triage_id)
        settleStatus(batch.triage_id)
      } else if (reading) {
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
          const back = refundTriageSession({
            companyId: failed.company_id, triageId: batch.triage_id,
            note: 'CVs returned — this Triage could not be processed',
          })
          if (back.refunded > 0) {
            console.log(`  triage ${batch.triage_id}: returned ${back.refunded} CV(s) after a failure`)
          }
        }
      } else {
        /*
         * A deep batch that gave up. Two things have to happen or the CVs in
         * it are lost with nothing in the product able to name them.
         *
         * runDeep releases its rows back to 'pending' when it throws, so they
         * end up parsed, ranked, and in a state the retry route does not
         * select — it looks for 'failed'. The recruiter presses Retry, is told
         * nothing was re-queued, and the CVs they paid for are never analysed.
         * So they are marked failed: that is what happened, it is what the
         * failures list reports, and it is what Retry looks for.
         *
         * And the ladder has to get past them. The frontier never advanced,
         * so every later scroll recomputes this same range, builds the same
         * idempotency key, and is silently ignored — the recruiter can never
         * reach rank 76 because 51–75 is permanently "already queued". Moving
         * the frontier to the end of this band unblocks everything above it
         * and costs nothing: the band's own rows are recoverable by Retry,
         * which asks for ranks explicitly.
         */
        const stranded = db.prepare(`
          UPDATE triage_applicants SET deep_status = 'failed', deep_error = ?
          WHERE triage_id = ? AND prelim_rank BETWEEN ? AND ?
            AND parse_status = 'parsed' AND deep_status IN ('pending', 'running')
        `).run(
          String(error.message).slice(0, 300), batch.triage_id,
          batch.from_rank ?? 0, batch.to_rank ?? 0,
        )

        if (stranded.changes > 0) {
          console.error(`  triage ${batch.triage_id}: ${stranded.changes} CV(s) left unanalysed — retry can pick them up`)
        }

        advanceFrontier(batch.triage_id, batch.to_rank ?? 0)
        recount(batch.triage_id)
        settleStatus(batch.triage_id)
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
  /*
   * This delivery's files, not the session's.
   *
   * It used to read every pending row in the Triage, which was right when a
   * session had one delivery and is wrong now: a drop that arrives while an
   * earlier drop is still parsing would be swallowed by the earlier batch, and
   * then its own batch would find nothing to do and declare itself done.
   */
  const pending = batch.drop_id === null || batch.drop_id === undefined
    ? db.prepare(`
      SELECT id, file_name, stored_name FROM triage_applicants
      WHERE triage_id = ? AND parse_status = 'pending' AND drop_id IS NULL ORDER BY id
    `).all(triage.id)
    : db.prepare(`
      SELECT id, file_name, stored_name FROM triage_applicants
      WHERE triage_id = ? AND parse_status = 'pending' AND drop_id = ? ORDER BY id
    `).all(triage.id, batch.drop_id)

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
  /*
   * Against THIS delivery's charge, and nothing else.
   *
   * Each delivery is paid for on its own, so each one's unreadable files are
   * owed back against its own line. A session-wide total would be wrong in
   * both directions: two unreadable files in Friday's drop of six, counted
   * against the whole session, would clamp to a charge the recruiter made in
   * March and hand back capacity they had spent on CVs they can still read.
   *
   * A session launched before deliveries existed has its CVs at drop_id NULL
   * and its charge on the triages row; refundTriageSession's legacy path is
   * what serves it, which is why that case is asked separately.
   */
  const unreadable = batch.drop_id
    ? db.prepare(`
      SELECT COUNT(*) AS n FROM triage_applicants
      WHERE triage_id = ? AND parse_status IN ('unreadable', 'failed') AND drop_id = ?
    `).get(triage.id, batch.drop_id).n
    : db.prepare(`
      SELECT COUNT(*) AS n FROM triage_applicants
      WHERE triage_id = ? AND parse_status IN ('unreadable', 'failed') AND drop_id IS NULL
    `).get(triage.id).n

  if (unreadable > 0 && triage.company_id) {
    /* The TOTAL that should have gone back for this DELIVERY, not a delta —
       this sweep can run again after a retry or a crash and will report the
       same number, and the refund pays only the difference. */
    const back = batch.drop_id
      ? refundTriageDrop({
        companyId: triage.company_id, dropId: batch.drop_id, totalCvs: unreadable,
        note: `CV${unreadable === 1 ? '' : 's'} returned — the file could not be read`,
      })
      /* The target total, not the whole charge. refundTriageSession takes no
         total — it means "everything back" — so calling it here handed a
         legacy session its entire charge for one scanned photograph, and
         analysed the other thirty-five CVs for nothing. */
      : refundUnattributedTriage({
        companyId: triage.company_id, triageId: triage.id, totalCvs: unreadable,
        note: `CV${unreadable === 1 ? '' : 's'} returned — the file could not be read`,
      })

    if (back.refunded > 0) {
      console.log(`  triage ${triage.id}: returned ${back.refunded} CV(s) of capacity`)
    }
  }

  /* Before ranking, not after: a CV superseded by a newer one from the same
     person should never take a rank, because a rank is a promise that it will
     be analysed and charged attention for. */
  resolveDuplicatePeople(triage.id)

  // Ranking cannot start until every file has been read: a preliminary order
  // built over half the pile would put the second half behind all of it.
  enqueue({ triageId: triage.id, kind: 'preliminary', dropId: batch.drop_id ?? null })
}

/**
 * One person, one CV — the newest one they sent.
 *
 * A recruiter forwards a mailbox into a session. The same candidate applies
 * again three weeks later with a CV that now mentions the certification the
 * job asks for. Two files, different bytes, so the content hash lets both
 * through; two rows, two charges, two entries in the ranking, and the
 * recruiter meets the same name twice with two different scores and no way to
 * tell which is current.
 *
 * So the email decides. It is the only identifier a CV reliably carries — a
 * name is not unique and a phone number is written six ways — and it is the
 * one the candidate chose to be reached on. Same email, same person; the
 * newest CV is the current version and the older ones step aside.
 *
 * No email means a new person, always. An unreadable contact block is not
 * evidence of anything, and folding every CV that failed to yield an address
 * into one "person" would be the worst possible failure here.
 *
 * What stepping aside means, precisely: parse_status becomes 'duplicate',
 * which is a state the pipeline already understands. Ranking skips it,
 * analysis skips it, completion does not wait for it, and the results page
 * does not show it. What does NOT happen is a refund — that CV was read, and
 * being superseded later is not the same as never having been readable.
 *
 * Idempotent, and run after every delivery is parsed: the newest row in each
 * group is current whether this is the first time it has been asked or the
 * fifth.
 */
function resolveDuplicatePeople(triageId) {
  const rows = db.prepare(`
    SELECT id, email, parse_status, created_at FROM triage_applicants
    WHERE triage_id = ? AND parse_status IN ('parsed', 'duplicate')
    ORDER BY created_at, id
  `).all(triageId)

  const groups = new Map()
  for (const row of rows) {
    const key = emailKey(row.email)
    if (!key || !key.includes('@')) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }

  let superseded = 0

  for (const group of groups.values()) {
    /*
     * Ordered oldest first above, so the last one is the newest CV this
     * person has sent — across deliveries, which is the case this exists for.
     *
     * Within ONE delivery it is upload order, and that is the honest limit of
     * it: two CVs from the same person in a single drag-and-drop carry no
     * evidence of which is more recent, and the file that happens to be
     * serialised last wins. Reading a date out of the CV text to break the
     * tie would be guessing dressed as a fact.
     */
    const current = group[group.length - 1]

    /*
     * The restore runs BEFORE the length guard, not after it.
     *
     * It sat below `if (group.length < 2) continue`, which is the one case
     * that can ever need it: the only way the current row goes stale is the
     * group shrinking, and a group that shrinks to one row is exactly the
     * group this skips. So the safety net was unreachable, and a CV left
     * alone under that email would have stayed 'duplicate' for ever —
     * excluded from the results, never re-ranked, never analysed, and not in
     * the failures list either.
     */
    if (current.parse_status === 'duplicate') {
      db.prepare(`
        UPDATE triage_applicants SET parse_status = 'parsed', duplicate_of = NULL WHERE id = ?
      `).run(current.id)
    }

    if (group.length < 2) continue

    for (const row of group) {
      if (row.id === current.id) continue
      if (row.parse_status === 'duplicate') continue
      db.prepare(`
        UPDATE triage_applicants SET parse_status = 'duplicate', duplicate_of = ?
        WHERE id = ?
      `).run(current.id, row.id)
      superseded += 1
    }
  }

  /* Recounted whichever way it went: a restore changes the counters too, and
     it is cheap enough not to be worth deciding about. */
  recount(triageId)

  if (superseded > 0) {
    console.log(`  triage ${triageId}: ${superseded} CV(s) superseded by a newer one from the same person`)
  }

  return superseded
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

  /*
   * Only the CVs that have never been ranked.
   *
   * The ranking used to be recomputed over the whole pile and written as a
   * dense 1..N. With one delivery that is fine. With two it is a trap: deep
   * analysis selects by rank range and the frontier is a cursor into that rank
   * space, so renumbering underneath an advanced frontier would slide CVs past
   * the cursor and they would never be analysed — and nothing would report it,
   * because a batch that finds no rows advances the frontier and settles.
   *
   * So ranks are append-only. A CV keeps the rank it was given for the life of
   * the session, and a new delivery is ranked among itself and placed after
   * everything already there. What the recruiter sees is ordered by score, not
   * by this, so a strong late arrival still lands at the top of the list.
   */
  const applicants = db.prepare(`
    SELECT id, display_name, extracted_text, location FROM triage_applicants
    WHERE triage_id = ? AND parse_status = 'parsed' AND prelim_rank IS NULL
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

  /* Where this delivery starts in the rank space. Zero for the first one, and
     the end of the previous delivery for every one after it. */
  /*
   * The high-water mark, not the highest surviving rank.
   *
   * Ranks are handed out above everything that has ever been handed out, and
   * the frontier is part of "ever": it only moves forward, so a rank issued
   * below it is a rank nothing will ever select. Deleting CVs is what makes
   * these two numbers differ — remove the top ten of a hundred and MAX drops
   * to 90 while the frontier stays at 100, so the next delivery would be
   * numbered 91..95, land under the cursor, and never be analysed. Paid for,
   * parsed, ranked, invisible, with nothing in the product able to name them.
   */
  const offset = db.prepare(`
    SELECT MAX(
      COALESCE((SELECT MAX(prelim_rank) FROM triage_applicants WHERE triage_id = ?), 0),
      COALESCE((SELECT analysis_frontier FROM triages WHERE id = ?), 0)
    ) AS at
  `).get(triage.id, triage.id).at

  const write = db.prepare(
    `UPDATE triage_applicants SET prelim_score = ?, prelim_rank = ? WHERE id = ?`,
  )
  db.transaction(() => {
    ranked.forEach((entry, index) => write.run(entry.score, offset + index + 1, entry.id))
    db.prepare(`UPDATE triages SET prelim_done_at = ?, updated_at = ? WHERE id = ?`)
      .run(now(), now(), triage.id)
  })()

  cost({
    triageId: triage.id, batchId: batch.id, stage: 'preliminary:rank',
    applicants: ranked.length,
  })

  /*
   * What happens next is decided from the session's rank space, not from what
   * this particular run happened to rank.
   *
   * The difference matters when this batch runs a second time — a process that
   * died mid-batch leaves it 'running', and resumeQueue puts it back in the
   * queue. On the re-run every row already has a rank, so `ranked` is empty;
   * deciding from that would return here without ever queueing the analysis,
   * and the session would sit at "processing" with nothing behind it.
   *
   * The highest rank, not the count of ranked rows. Those were the same
   * number while ranks were dense; deleting a CV makes the count drop while
   * the numbering does not, and every batch sized from the count would then
   * under-cover the top of the next delivery.
   */
  const rankedTotal = db.prepare(
    `SELECT COALESCE(MAX(prelim_rank), 0) AS n FROM triage_applicants WHERE triage_id = ?`,
  ).get(triage.id).n

  if (rankedTotal === 0) {
    /* Nothing in this session could be read at all. This is the only case that
       fails the whole thing — a later delivery of six scans must not fail a
       session holding two hundred analysed CVs. */
    db.prepare(`
      UPDATE triages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?
    `).run(
      'None of the uploaded files could be read as text.', now(), triage.id,
    )
    return
  }

  /* Read again rather than trusting the row this batch started with: parsing
     takes as long as it takes, and the previous delivery's analysis is very
     likely still moving the cursor while it runs. */
  const frontier = db.prepare(`SELECT analysis_frontier AS at FROM triages WHERE id = ?`)
    .get(triage.id)?.at ?? 0

  if (frontier >= rankedTotal) {
    /* Everything ranked has been analysed already. Nothing is owed. */
    settleStatus(triage.id)
    return
  }

  /*
   * New CVs are analysed straight away.
   *
   * An earlier version made a late delivery wait behind whatever the recruiter
   * had not yet read, on the reasoning that it should not jump the queue. That
   * is the wrong promise for a live shortlist: CVs added on Tuesday should be
   * in the ranking on Tuesday, in their right place by score. So the range runs
   * from the cursor to the end of what exists, in tranches, and the pump keeps
   * going until there is nothing left.
   *
   * Starting at the frontier rather than at this delivery's first rank is
   * deliberate: re-covering ranks that were already scored costs nothing —
   * runDeep selects only rows that are pending, queued or failed — while
   * starting above it would step over any band the cursor had overshot.
   */
  enqueue({
    triageId: triage.id,
    kind: offset === 0 ? 'initial' : 'rolling',
    fromRank: frontier + 1,
    toRank: Math.min(rankedTotal, frontier + TRIAGE.initialDeep),
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

  /*
   * Nothing to do in this range. There are two reasons for that and they are
   * not the same, which is why the frontier is not simply moved to the end of
   * the batch.
   *
   * Either everything here is already scored — a re-crossed boundary, or a
   * resumed batch that finished before the process died — or the ranks in this
   * range do not exist yet, because the pile is still being read. Advancing
   * past ranks that do not exist strands them: the frontier only moves forward,
   * so rows ranked into that band afterwards are never selected again.
   *
   * So the frontier moves to the highest rank that actually exists at or below
   * this batch's end, and no further.
   */
  if (rows.length === 0) {
    const highest = db.prepare(`
      SELECT COALESCE(MAX(prelim_rank), 0) AS at FROM triage_applicants
      WHERE triage_id = ? AND prelim_rank IS NOT NULL AND prelim_rank <= ?
    `).get(triage.id, batch.to_rank).at

    advanceFrontier(triage.id, highest)
    settleStatus(triage.id)
    return
  }

  const ids = rows.map((row) => row.id)
  const claim = db.prepare(`
    UPDATE triage_applicants SET deep_status = 'running'
    WHERE id IN (${ids.map(() => '?').join(',')})
  `)
  /* Released if anything below throws before the work starts. Without it a
     failed batch left its rows at 'running', and 'running' is not one of the
     states the retry selects — so the retry found nothing to do, treated the
     range as finished, moved the cursor past it and settled. The CVs were
     parsed, ranked, claimed and never analysed. */
  const release = db.prepare(`
    UPDATE triage_applicants SET deep_status = 'pending'
    WHERE id IN (${ids.map(() => '?').join(',')}) AND deep_status = 'running'
  `)

  const profile = safeJson(triage.match_profile) ?? deterministicProfile(triage.raw_jd)

  /* One list for the whole batch, so every applicant is judged against the
     same requirements under the same ids. */
  const requirements = requirementsFrom(profile)

  const criteria = {
    requirements,
    title: profile.title ?? '',
    jobDescription: triage.raw_jd,
    requiredSkills: (profile.mustHaves ?? []).map((item) => item.requirement ?? item).filter(Boolean),
    preferredSkills: (profile.preferred ?? []).map((item) => item.requirement ?? item).filter(Boolean),
    keywords: profile.keywords ?? [],
  }

  const started = Date.now()
  const usages = []
  let scored = 0

  /* The circuit breaker, checked once for the batch. Over the ceiling every
     applicant still gets a deterministic score and a place in the ranking — the
     Triage completes, it is simply not model-read. */
  const useAi = aiConfigured() && withinDailyCeiling({
    context: 'triage', companyId: triage.company_id, wanted: rows.length,
  })

  /* Claimed here, after everything that could throw while setting up. The rows
     are only marked as being worked on once there is actually a worker. */
  claim.run(...ids)

  const handle = async (row) => {
    try {
      const record = await analyseApplicant({ triage, row, criteria, requirements, useAi })
      usages.push(record.usage)

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

      /*
       * The count moves as each applicant lands, not when the batch does.
       *
       * It used to be recounted once, after every applicant in the batch had
       * finished. Each row is saved the moment it is scored, so the list below
       * filled in live while the header went on reading "0 of 26 fully
       * analysed" — for as long as the slowest of twenty-five model calls took.
       * One aggregate over a single Triage's rows is cheap; a counter that
       * contradicts the list under it is not.
       */
      recount(triage.id)
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
  }

  /*
   * One applicant goes first, so the rest read a cached prompt.
   *
   * The instructions, the schema and the job description are identical for
   * every CV in a Triage, and a cached prefix only exists once a request
   * carrying it has started being processed. Four workers starting together
   * all miss it and all pay the write price. Nothing here is required for
   * correctness — losing the race costs what it cost before caching.
   */
  try {
    const lead = rows.length > 0 ? handle(rows[0]) : Promise.resolve()
    if (rows.length > 1) await Promise.race([lead, sleep(TRIAGE.warmupMs)])
    await inParallel(rows.slice(1), TRIAGE.analysisConcurrency, handle)
    await lead
  } catch (error) {
    /* Whatever is still claimed goes back in the queue before the batch fails,
       so the retry can see it. handle() catches its own per-applicant errors,
       so reaching here means something structural. */
    release.run(...ids)
    throw error
  }

  recount(triage.id)
  advanceFrontier(triage.id, batch.to_rank)

  const totals = sumUsage(usages)

  cost({
    triageId: triage.id, batchId: batch.id, stage: `deep:${batch.kind}`,
    model: useAi ? MATCH_MODEL : 'deterministic',
    applicants: scored, durationMs: Date.now() - started,
    /* The whole input, cached parts included, so this stays comparable with
       what it recorded before caching existed. The ledger below keeps them
       apart, because money needs them apart. */
    inputTokens: (totals.inputTokens + totals.cacheWriteTokens + totals.cacheReadTokens) || null,
    outputTokens: totals.outputTokens || null,
  })

  if (totals.calls > 0) {
    recordCost({
      context: 'triage',
      stage: `deep:${batch.kind}`,
      model: MATCH_MODEL,
      companyId: triage.company_id ?? null,
      calls: totals.calls,
      items: scored,
      inputTokens: totals.inputTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      cacheReadTokens: totals.cacheReadTokens,
      outputTokens: totals.outputTokens,
      durationMs: Date.now() - started,
    })
  }

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
async function analyseApplicant({ triage, row, criteria, requirements, useAi = true }) {
  const fallback = scoreCandidate(
    { cv_text: row.extracted_text, skills: [] },
    criteria,
  )

  const ai = useAi
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

  /*
   * The score is computed here from the verdicts, not read off the answer.
   *
   * A null fit means nothing about the job could be checked against this CV —
   * an unreadable document, or a response with no usable verdicts. That takes
   * the deterministic score rather than publishing a zero: "we could not tell"
   * and "they do not match" are different claims, and only one is supportable.
   */
  const judged = scoreAgainst(requirements, ai.criteria)

  if (judged.fit === null) {
    return {
      absoluteFit: fallback.score,
      criteria: { items: criteriaItems(fallback), breakdown: fallback.breakdown ?? null },
      explanation: null,
      source: 'deterministic',
      model: 'deterministic',
      usage: ai.usage ?? null,
    }
  }

  return {
    absoluteFit: judged.fit,
    criteria: {
      coverage: judged.coverage,
      needsReview: needsReview(judged.coverage),
      verdicts: judged.breakdown,
      confidence: ai.confidence,
      /* Computed from the verdicts, not asked of the model — see
         deriveHighlights. Interview questions are no longer written here at
         all; they are produced when a recruiter opens the applicant. */
      ...deriveHighlights(judged.breakdown),
      transferable: ai.transferable,
      locationFit: ai.location_fit ?? null,
      seniorityAlignment: ai.seniority_alignment ?? null,
      items: criteriaItems(fallback),
    },
    explanation: ai.reasoning,
    source: 'claude',
    model: ai.model_version ?? MATCH_MODEL,
    usage: ai.usage ?? null,
  }
}

/**
 * Recomputes a session's status after something outside the queue changed it.
 *
 * Deleting a CV is the case. settleStatus is otherwise only reached from
 * inside a batch, so a session that lost its last unscored applicant had
 * nothing left to run and nothing to notice — it sat at 'ready' for ever,
 * reporting outstanding work that did not exist, and a legacy row in that
 * state reads as open and holds a slot against the cap.
 */
export function resettle(triageId) {
  settleStatus(triageId)
}

/**
 * Gives a rank to anything parsed that has not got one.
 *
 * Reached when a CV is deleted and an older version of the same person is
 * promoted back: that row was a duplicate, so the ranking pass skipped it,
 * and an unranked row is one no batch can ever select. Enqueues the ordinary
 * preliminary pass, which ranks exactly those rows and appends them above
 * everything already handed out.
 */
export function rankPending(triageId) {
  const waiting = db.prepare(`
    SELECT COUNT(*) AS n FROM triage_applicants
    WHERE triage_id = ? AND parse_status = 'parsed' AND prelim_rank IS NULL
  `).get(triageId).n

  if (waiting === 0) return 0

  /* Keyed off the count so a second promotion enqueues a second pass rather
     than colliding with the first on the unique index. */
  enqueue({ triageId, kind: 'preliminary', keySuffix: `promote${waiting}` })
  pump()
  return waiting
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
    /* Anything still waiting to be read. A session with a delivery mid-parse is
       not complete, however much of the earlier pile has been analysed. */
    (SELECT COUNT(*) FROM triage_applicants
      WHERE triage_id = ? AND parse_status = 'pending') AS unread,
      (SELECT COUNT(*) FROM triage_applicants
        WHERE triage_id = ? AND parse_status = 'parsed' AND deep_status <> 'scored') AS outstanding
  `).get(triageId, triageId, triageId)

  /*
   * "Completed" means every CV in the session reached an end state, not merely
   * that everything already read has been scored. A delivery still being
   * parsed keeps the session at 'ready' — it has results worth reading, and
   * more coming — which is what a rolling session looks like most of the time.
   */
  const settled = row.outstanding === 0 && row.unread === 0
  const status = row.scored === 0 ? 'processing' : (settled ? 'completed' : 'ready')

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

  /*
   * Counted in RANKS, not in parsed rows.
   *
   * These are two different numbers while a pile is being read: a row is
   * flipped to 'parsed' as its text is extracted, but it gets its rank later,
   * when the whole pile is ranked together. Sizing the tranche by the parsed
   * count let the frontier run past ranks that did not exist yet — the batch
   * found nothing in the range, advanced the frontier anyway, and the rows
   * ranked into that band a moment later were then below a cursor that only
   * moves forward. Parsed, ranked, never analysed, and nothing in the product
   * able to name them.
   *
   * Reachable from the ordinary UI: "Show the next 25" sends advance=1, and a
   * recruiter reading the first page while the rest of the pile is still being
   * read is exactly the case.
   *
   * The HIGHEST rank, not the count of ranked rows. Those were the same
   * number while ranks were dense, and they stopped being the same the day a
   * recruiter could delete one CV out of a session: the count drops, the
   * highest rank does not, and the ladder would decide it had already reached
   * the end of a pile it was one CV short of. Every other place that reasons
   * about the frontier already asks for MAX for the same reason.
   */
  const total = db.prepare(`
    SELECT COALESCE(MAX(prelim_rank), 0) AS n FROM triage_applicants
    WHERE triage_id = ? AND prelim_rank IS NOT NULL
  `).get(triageId).n

  const from = triage.analysis_frontier + 1
  if (from > total) return { queued: false, reason: 'exhausted', frontier: triage.analysis_frontier }

  const to = Math.min(triage.analysis_frontier + TRIAGE.tranche, total)
  const result = enqueue({ triageId, kind: 'rolling', fromRank: from, toRank: to })
  pump()

  return { queued: result.queued, from, to, reason: result.queued ? 'queued' : 'already_queued' }
}

/**
 * Starts the pipeline for one delivery of CVs.
 *
 * Called at launch for the first delivery, and again for every later drop into
 * an open session. The two are the same work — read the files, rank them,
 * analyse what is owed — and the only thing that distinguishes them is the
 * delivery the batch carries.
 */
export function startProcessing(triageId, { dropId = null, wake = true } = {}) {
  /* Not over a failed session. Reviving one is a deliberate act with an error
     message to clear and a recruiter to tell, and it belongs to the lifecycle
     work rather than to a silent side effect of an upload. */
  db.prepare(`
    UPDATE triages SET status = 'processing', updated_at = ? WHERE id = ? AND status <> 'failed'
  `).run(now(), triageId)
  enqueue({ triageId, kind: 'parse', dropId })
  /* `wake: false` enqueues without running anything here. Used where the work
     belongs to another process — the server holds the pump, and two pumps on
     one SQLite file race for the same batch. The waker below picks it up. */
  if (wake) pump()
}

/**
 * Puts applicants whose analysis failed back in the queue.
 *
 * Analysis fails for reasons that pass — a timeout, a rate limit, a model
 * having a bad minute — and until now a failure was final. The CV had been
 * charged for, it sat in the list with no score, and the only way to get one
 * was a new Triage and a second charge for the same file.
 *
 * Nothing is charged here. These CVs were paid for when their delivery
 * arrived; this is finishing work that was already bought.
 *
 * The two hard parts:
 *
 * The frontier has already moved past them. It only ever goes forward, so no
 * ordinary tranche will ever cover their ranks again — the batches have to be
 * asked for by rank, explicitly, and they are.
 *
 * The identity of the work is the same. `enqueue` refuses a duplicate on
 * purpose, which is the whole reason a refreshed page costs nothing, and it
 * would refuse this too: same Triage, same kind, same range. So a round number
 * goes into the key. Two retries a day apart are two batches; a retry pressed
 * twice in a second is one.
 */
export function requeueFailedAnalyses(triageId) {
  const failed = db.prepare(`
    SELECT prelim_rank AS rank FROM triage_applicants
    WHERE triage_id = ? AND deep_status = 'failed'
      AND parse_status = 'parsed' AND prelim_rank IS NOT NULL
    ORDER BY prelim_rank
  `).all(triageId).map((row) => row.rank)

  if (failed.length === 0) return 0

  db.prepare(`
    UPDATE triage_applicants SET deep_status = 'pending', deep_error = NULL
    WHERE triage_id = ? AND deep_status = 'failed' AND parse_status = 'parsed'
  `).run(triageId)

  /* Which attempt this is. Counted from the batches already written rather
     than held anywhere, so it survives a restart and cannot drift. */
  const round = db.prepare(
    `SELECT COUNT(*) AS n FROM triage_batches WHERE triage_id = ? AND kind = 'rolling'`,
  ).get(triageId).n

  /*
   * Banded rather than one batch per applicant. A tranche is the size the rest
   * of the pipeline works in, the analysis of a band shares one warmed prompt
   * cache, and ten failures spread over four hundred ranks should not become
   * ten separate model conversations.
   *
   * Only bands that actually contain a failure are queued. runDeep skips rows
   * that are already scored, so an over-wide band would be harmless but would
   * still cost a database pass per empty range.
   */
  const size = Math.max(1, TRIAGE.tranche)
  const bands = new Map()
  for (const rank of failed) {
    const from = Math.floor((rank - 1) / size) * size + 1
    bands.set(from, Math.min(from + size - 1, Math.max(...failed)))
  }

  for (const [from, to] of [...bands.entries()].sort((a, b) => a[0] - b[0])) {
    enqueue({
      triageId, kind: 'rolling', fromRank: from, toRank: to,
      keySuffix: `retry${round}`,
    })
  }

  /* A session that had settled as complete is working again. settleStatus
     will move it back when the last band lands. */
  db.prepare(`
    UPDATE triages SET status = 'ready', updated_at = ?
    WHERE id = ? AND status = 'completed'
  `).run(now(), triageId)

  pump()
  return failed.length
}

/**
 * Whether this session is being scored by the model, or by the fallback.
 *
 * The daily ceiling is deliberately not a hard stop: over the line every
 * applicant still gets a score and a place in the ranking, from the
 * deterministic scorer instead of the model. That is the right behaviour and
 * the wrong silence — a recruiter comparing today's Triage with last week's
 * would see plainer readings and shorter reasons and have no way to know why.
 *
 * Two different facts, and the product needs both. `capped` is now: more
 * analysis today would fall back. `fallbacks` is history: this many CVs in
 * this session were scored without the model, whatever the reason.
 */
export function analysisLimit(triageId) {
  const triage = rawTriage(triageId)
  if (!triage) return { configured: false, capped: false, fallbacks: 0 }

  const configured = aiConfigured()

  const fallbacks = db.prepare(`
    SELECT COUNT(*) AS n FROM triage_applicants
    WHERE triage_id = ? AND deep_status = 'scored' AND analysis_source <> 'claude'
  `).get(triageId).n

  return {
    configured,
    capped: configured && !withinDailyCeiling({
      context: 'triage', companyId: triage.company_id, wanted: 1,
    }),
    fallbacks,
  }
}

/**
 * Looks for work nobody started.
 *
 * Until now every batch was enqueued by something that immediately pumped, so
 * "queued" and "about to run" were the same state. Rolling sessions break that:
 * a delivery can be written by one process and owed by another, a drop can
 * arrive while the pump is busy with a different session, and the client is no
 * longer the thing that drives analysis forward — a recruiter who adds CVs on
 * Tuesday and does not come back until Friday should return to a finished
 * ranking, not to a queue waiting for their scroll.
 *
 * Cheap enough to run often: one indexed count against triage_batches, and it
 * does nothing at all unless something is actually waiting.
 */
export function startQueueWaker({ everyMs = TRIAGE.wakeMs } = {}) {
  /* Floored, because a bad env value here is a hot loop against the database
     rather than a slow queue. */
  const period = Math.max(250, Number.isFinite(everyMs) ? everyMs : 5000)

  const timer = setInterval(() => {
    if (stopped) return
    try {
      const waiting = db.prepare(
        `SELECT COUNT(*) AS n FROM triage_batches WHERE status = 'queued'`,
      ).get().n
      if (waiting > 0) pump()
    } catch (error) {
      /* A timer callback that throws takes the process with it. The queue is
         allowed to have a bad minute; the server is not allowed to fall over
         because of one. */
      console.warn(`  triage waker: ${error.message}`)
    }
  }, period)

  /* Never the reason the process stays alive. */
  timer.unref?.()
  return timer
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
