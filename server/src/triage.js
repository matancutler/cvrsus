/**
 * Cursus Triage — the domain.
 *
 * Search asks "who else is out there"; Triage asks "which of the three hundred
 * people who already applied should I read first". The second question is the
 * one recruiters actually spend their week on, and until now the product had no
 * answer to it.
 *
 * This module owns the objects. The work — parsing, ranking, analysing — lives
 * in triageQueue.js, because it happens on a background worker and outlives the
 * request that started it. Keeping the two apart is what lets a route stay a
 * route: create the row, hand it to the queue, answer.
 *
 * Two rules are load-bearing and are enforced here rather than trusted:
 *
 *   1. An applicant is not a candidate. Nobody in triage_applicants opted into
 *      the marketplace, so nothing in this file writes to `candidates`, and no
 *      Triage result carries a candidate id. A recruiter uploading a CV is not
 *      that person consenting to be found.
 *
 *   2. Every read is scoped by company. Not by recruiter — the addendum makes a
 *      Triage the organization's — but never unscoped. `mustOwn` is the only
 *      way rows leave this module, so a guessed id reaches nothing.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import db, { UPLOAD_DIR } from './db.js'
import { TRIAGE_MAX_FILES } from './pricing.js'

/**
 * The funnel, as Section 3.3 specifies it.
 *
 * Fifty deeply analysed before anything is shown, twenty-five of those shown,
 * and twenty-five more queued every time the recruiter reaches the end of a
 * tranche. The gap between 50 and 25 is the buffer: it is what makes the second
 * page instant instead of a spinner, and it is the difference between a product
 * that feels progressive and one that feels slow.
 *
 * Configurable because Section 14 says so, but the shape is a product
 * requirement rather than a suggestion, so the defaults are the spec's.
 */
export const TRIAGE = {
  initialDeep: num('TRIAGE_INITIAL_DEEP', 50),
  tranche: num('TRIAGE_TRANCHE', 25),
  pageSize: num('TRIAGE_PAGE_SIZE', 25),
  maxFiles: TRIAGE_MAX_FILES,
  /* Section 9 — hard safety limits, distinct from the commercial cap. These
     protect the machine; TRIAGE_MAX_FILES is how big one batch may be. */
  maxFileBytes: num('TRIAGE_MAX_FILE_BYTES', 10 * 1024 * 1024),
  maxTotalBytes: num('TRIAGE_MAX_TOTAL_BYTES', 2 * 1024 * 1024 * 1024),
  maxTextChars: num('TRIAGE_MAX_TEXT_CHARS', 60000),
  /* How many CVs one worker reads or analyses at a time. Bounded because three
     hundred files arriving together is not permission to open three hundred
     sockets. */
  parseConcurrency: num('TRIAGE_PARSE_CONCURRENCY', 4),
  analysisConcurrency: num('TRIAGE_ANALYSIS_CONCURRENCY', 4),
  maxAttempts: num('TRIAGE_MAX_ATTEMPTS', 3),

  /**
   * How long the rest of a batch waits for the first analysis to warm the
   * prompt cache.
   *
   * Every CV in a Triage is judged against the same instructions and the same
   * job description, and a cached prefix costs a tenth of what sending it again
   * costs — but it only exists once a request carrying it has begun. Letting
   * one call get ahead is the difference between fifty cache writes and one.
   * Nothing depends on the wait being long enough; losing the race costs
   * exactly what this cost before caching.
   */
  warmupMs: num('TRIAGE_WARMUP_MS', 8000),

  /**
   * How often the queue looks for work nobody started.
   *
   * Rolling sessions need this: a delivery can be written by one process and
   * owed by another, and a recruiter who adds CVs on Tuesday should come back
   * on Friday to a finished ranking rather than to a queue waiting for their
   * scroll. Read through num() like every other tuneable here, so an empty or
   * nonsense value falls back rather than becoming a hot loop.
   */
  wakeMs: num('TRIAGE_WAKE_MS', 5000),

  /**
   * Whether CVs may be added to a session that is already running.
   *
   * The whole of rolling Triage is built and tested behind this. It is ON
   * everywhere except production, and OFF there until the cost of analysing a
   * CV has been measured and the effort setting chosen — because a second
   * delivery is a second charge, and putting a button in front of paying
   * recruiters before we know what each press costs us is the wrong order to
   * do those two things in.
   *
   * It defaults ON. It was off in production while the cost of a CV was
   * still unmeasured, which had the button hidden on the one surface that
   * wanted it — so the deploy shipped everything around the feature and
   * withheld the feature. Set TRIAGE_ADD_CVS=0 to switch it off again; that
   * is one environment variable and a restart, no deploy.
   */
  addCvs: flag('TRIAGE_ADD_CVS', true),

  /**
   * How long a closed session's CVs are kept, and how long any CV is kept.
   *
   * Q6, and both are settings because they are a decision rather than a
   * technical fact — changing the promise should not need a deploy. Whichever
   * comes first wins: a session left open for two years still lets go of the
   * CVs somebody sent it in its first month.
   *
   * Zero on either switches that half of the rule off.
   */
  retainAfterCloseDays: num('TRIAGE_RETAIN_AFTER_CLOSE_DAYS', 90),
  retainMaxDays: num('TRIAGE_RETAIN_MAX_DAYS', 365),

  /**
   * Whether the retention sweep is allowed to delete anything.
   *
   * Off. It runs on the daily timer, works out exactly what it would remove,
   * writes that down, and stops. Deleting other people's CVs on a schedule is
   * the single least reversible thing this product can do, and it should run
   * in the open for a full cycle before it is trusted to act — which is what
   * this setting is for, and why turning it on is deliberate.
   */
  retentionDeletes: flag('TRIAGE_RETENTION_DELETES', false),

  /**
   * How many sessions one organization may have open at once.
   *
   * Enforced nowhere at present, and that is deliberate rather than an
   * oversight: with no way for a recruiter to close a session, a cap on open
   * ones is a lock with no key. A company that reached it could not launch
   * another Triage and would have no action available to fix that. Kept as a
   * setting because the counting function is still correct and the cap is
   * worth having the day closing exists.
   */
  maxOpenSessions: num('TRIAGE_MAX_OPEN_SESSIONS', 25),
}

/** The three states a recruiter can put a session in. */
export const LIFECYCLES = ['open', 'paused', 'closed']

/**
 * What state this session is in, including for rows that predate the column.
 *
 * NULL means "older than the lifecycle column", and the honest answer for
 * those is readable from the row itself: a session that finished is closed, a
 * session still working is open. That is Q10 — every Triage in production was
 * launched, charged and finished under the one-time model, and they are
 * closed sessions whether or not anybody has run a migration.
 *
 * Doing it this way rather than with DEFAULT 'open' is the difference between
 * a deploy that changes nothing and a deploy that turns every finished 2026
 * report into a live shortlist that can take uploads and charges.
 */
export function lifecycleOf(row) {
  if (row?.lifecycle) return row.lifecycle
  if (row?.status === 'completed' || row?.status === 'failed') return 'closed'
  return 'open'
}

function num(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/* '0', 'false' and 'off' all mean off, because an operator typing one of them
   into Render means the same thing by all three and should not have to guess
   which one this file happens to parse. */
function flag(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase())
}

const now = () => new Date().toISOString()

// --------------------------------------------------------------- objects ---

/**
 * A draft. Costs nothing and consumes nothing.
 *
 * The addendum is explicit that opening New Triage must not spend a credit, so
 * this row exists purely to have somewhere to attach uploads while the
 * recruiter is still deciding. It becomes a commercial object at launch and not
 * before — see `launch`.
 */
export function createDraft({ companyId, recruiterId, title = null }) {
  const stamp = now()
  /*
   * The lifecycle is written explicitly, and that matters more than it looks.
   *
   * NULL means "older than the lifecycle column", and lifecycleOf answers
   * those from the row's own state — a finished session is closed. That is
   * the right reading for a Triage from 2026 and the wrong one for a session
   * created today, which finishes its first pile and is then very much open:
   * left to the fallback, a session would close itself the moment the queue
   * caught up, and refuse the next delivery. So every session written from
   * here on says what it is.
   */
  const info = db.prepare(`
    INSERT INTO triages (
      company_id, recruiter_id, title, file_cap, lifecycle, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'open', ?, ?)
  `).run(companyId, recruiterId, trimOrNull(title), TRIAGE.maxFiles, stamp, stamp)

  return getTriage({ companyId, id: Number(info.lastInsertRowid) })
}

/**
 * A Triage that does not exist yet.
 *
 * Pressing + used to INSERT a draft immediately, so anybody who opened the
 * screen and thought better of it left an "Untitled Triage" behind — a list
 * filling with rows nobody made. The builder now renders from this, and the row
 * is written by the first thing typed into it.
 *
 * Built by the same triageView as a saved one, from the defaults the INSERT
 * would have used, so a blank screen and a saved screen cannot come to describe
 * different things.
 */
export function blankTriage() {
  return triageView({
    id: null,
    title: null,
    author: null,
    recruiter_id: null,
    status: 'draft',
    raw_jd: null,
    match_profile: null,
    file_cap: TRIAGE.maxFiles,
    total_files: 0,
    parsed_files: 0,
    failed_files: 0,
    analysed_files: 0,
    analysis_frontier: 0,
    launched_at: null,
    completed_at: null,
    charged_cvs: 0,
    refunded_cvs: 0,
    prelim_done_at: null,
    created_at: null,
    updated_at: null,
    error: null,
    ledger_id: null,
  })
}

/** Every Triage this organization owns, newest first. */
/**
 * The Triages a recruiter has actually started — the history.
 *
 * Drafts used to be listed too, so opening New Triage and leaving without
 * pressing Start put an "Untitled Triage" in the rail: a record of a job nobody
 * committed to, indistinguishable at a glance from real ones. The history is now
 * what was launched and paid for. An unfinished draft is not lost — pressing
 * New reopens it (see latestDraft) — it just is not history.
 */
export function listTriages(companyId, recruiterId = null) {
  /*
   * Three things the rail could not say before, and each of them changes
   * what a row means.
   *
   * What state it is in, because a closed session and a live one look
   * identical in a list of titles. How much is in it, because "Payments
   * Analyst" tells you nothing about whether it holds four CVs or four
   * hundred. And whether anything has landed since YOU last looked — per
   * recruiter, so a colleague opening it does not mark your arrivals as read.
   *
   * `lastActivityAt` is the most recent ANALYSIS, not updated_at. The worker
   * writes updated_at three times per tranche, so ordering or labelling by it
   * would make a colleague's 300-CV run look like activity every few seconds
   * while telling you nothing about when a human last got something.
   */
  return db.prepare(`
    SELECT t.*,
           TRIM(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, '')) AS author,
           (SELECT MAX(analysed_at) FROM triage_applicants a WHERE a.triage_id = t.id)
             AS last_activity_at,
           (SELECT COUNT(*) FROM triage_applicants a
             WHERE a.triage_id = t.id AND a.deep_status = 'scored'
               AND a.parse_status <> 'duplicate'
               AND a.analysed_at > COALESCE(
                 (SELECT v.last_seen_at FROM triage_views v
                   WHERE v.triage_id = t.id AND v.recruiter_id = ?), a.analysed_at))
             AS unread
    FROM triages t
    LEFT JOIN recruiters r ON r.id = t.recruiter_id
    WHERE t.company_id = ? AND t.ledger_id IS NOT NULL
    ORDER BY t.created_at DESC
  `).all(recruiterId ?? -1, companyId).map(triageView)
}

/*
 * A draft with nothing in it: no title, no job description, no files. Written
 * as SQL so the same definition is used to find one and to clear them away.
 */
const EMPTY_DRAFT = `
  t.ledger_id IS NULL AND t.status = 'draft'
  AND TRIM(COALESCE(t.title, '')) = '' AND TRIM(COALESCE(t.raw_jd, '')) = ''
  AND NOT EXISTS (SELECT 1 FROM triage_applicants a WHERE a.triage_id = t.id)
`

/**
 * This recruiter's unfinished draft, if they have one — what New reopens.
 *
 * Hiding drafts from the history would otherwise strand them: a recruiter who
 * wrote a job description, uploaded two hundred CVs and clicked away to check
 * something would come back to a blank builder with no route to their work, and
 * the CVs would sit on the server with nothing pointing at them. Reopening the
 * latest draft means nothing uncommitted is lost and nothing piles up — each
 * recruiter has at most one draft in play.
 *
 * Per recruiter, not per company: a colleague's half-built Triage is not yours
 * to resume.
 *
 * Empty drafts other than the one being reopened are deleted on the way: they
 * carry nothing, and they are exactly the rows that used to become "Untitled
 * Triage".
 */
export function latestDraft({ companyId, recruiterId }) {
  const row = db.prepare(`
    SELECT t.id FROM triages t
    WHERE t.company_id = ? AND t.recruiter_id = ?
      AND t.ledger_id IS NULL AND t.status = 'draft'
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT 1
  `).get(companyId, recruiterId)

  db.prepare(`
    DELETE FROM triages
    WHERE id IN (
      SELECT t.id FROM triages t
      WHERE t.company_id = ? AND t.recruiter_id = ? AND t.id != ? AND ${EMPTY_DRAFT}
    )
  `).run(companyId, recruiterId, row?.id ?? -1)

  return row ? getTriage({ companyId, id: row.id }) : null
}

export function getTriage({ companyId, id }) {
  const row = db.prepare(`
    SELECT t.*,
           TRIM(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, '')) AS author
    FROM triages t
    LEFT JOIN recruiters r ON r.id = t.recruiter_id
    WHERE t.id = ? AND t.company_id = ?
  `).get(id, companyId)

  return row ? triageView(row) : null
}

/** The raw row, for the worker. Unscoped on purpose — the queue owns the id. */
export function rawTriage(id) {
  return db.prepare(`SELECT * FROM triages WHERE id = ?`).get(id) ?? null
}

/**
 * Resolves a Triage or explains why it cannot be resolved.
 *
 * One function rather than a check at every call site: a route that forgets the
 * company scope is an authorization hole that no test would notice, so there is
 * exactly one way to turn an id from the wire into a row.
 */
export function mustOwn({ companyId, id }) {
  const triage = getTriage({ companyId, id: Number(id) })
  if (!triage) return { error: 'not_found' }
  return { triage }
}

function trimOrNull(value) {
  const text = String(value ?? '').trim()
  return text === '' ? null : text
}

/**
 * The public shape of a Triage.
 *
 * `analysed` and `total` are both said, because Section 5 requires the progress
 * to be stated honestly — "50 of 327 candidates fully analysed" rather than a
 * bar that implies all 327 have final scores.
 */
function triageView(row) {
  const total = row.total_files
  const usable = Math.max(0, row.parsed_files)

  return {
    id: row.id,
    title: row.title,
    author: row.author?.trim() || null,
    recruiterId: row.recruiter_id,
    status: row.status,
    jd: row.raw_jd ?? '',
    hasJd: Boolean(String(row.raw_jd ?? '').trim()),
    interpretation: readJson(row.match_profile)?.interpretation ?? null,
    fileCap: row.file_cap,
    counts: {
      total,
      usable,
      failed: row.failed_files,
      analysed: row.analysed_files,
      /* Read perfectly, then set aside because the same person sent a newer
         CV. Reported rather than folded into failed: nothing went wrong with
         them, and a recruiter told "3 files failed" about three CVs that read
         fine would go looking for a problem that is not there. */
      superseded: row.superseded_files ?? 0,
      /* What the recruiter can read right now. Distinct from `analysed`: the
         buffer beyond the shown page is analysed but deliberately not shown. */
      frontier: row.analysis_frontier,
    },
    /* What the recruiter has decided, beside what the pipeline has done. */
    lifecycle: lifecycleOf(row),
    closedAt: row.closed_at ?? null,
    /* When these CVs will be deleted, if the rule has started running for
       this session. Said out loud rather than left to the policy page: it is
       a promise made about other people's data and the recruiter is the one
       who has to keep it. */
    purgeAfter: row.purge_after ?? null,
    /* The last time a human got something, not the last time the worker
       touched the row. See the note on listTriages. */
    lastActivityAt: row.last_activity_at ?? null,
    /* New since THIS recruiter last looked. Zero unless the list was asked
       on somebody's behalf. */
    unread: row.unread ?? 0,
    launchedAt: row.launched_at,
    completedAt: row.completed_at,
    /* What this workspace actually cost, net of anything handed back for files
       that could not be read. Zero until launch, because a draft is free. */
    chargedCvs: Math.max(0, (row.charged_cvs ?? 0) - (row.refunded_cvs ?? 0)),
    /* When the cheap pass finished ordering the pile. Named for the state
       rather than for the mechanism: "prelim" anywhere in a serialised field is
       what a test greps for to prove the preliminary SCORE never escapes, and a
       harmless timestamp sharing the word would blunt that guard. */
    prioritisedAt: row.prelim_done_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
    /* Whether a credit has been spent. The dashboard uses it to tell a draft
       from a job in flight, which are the two things that look alike. */
    launched: Boolean(row.ledger_id),
  }
}

function readJson(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

// -------------------------------------------------------------- the pile ---

/**
 * Records one uploaded CV against a draft.
 *
 * The hash is computed here rather than in the worker because a duplicate must
 * be recognised before it is stored, not after it has been parsed and analysed.
 * Section 2.3 asks not to pay twice for identical work, and the only moment
 * that is free is this one.
 *
 * The unique index on (triage_id, content_hash) is what actually enforces it —
 * two identical files arriving in the same instant race on the index and one of
 * them loses, which a read-then-write check here could not guarantee.
 */
export function addFile({ triageId, file, dropId = null }) {
  const hash = hashFile(file.path)
  const stamp = now()

  try {
    const info = db.prepare(`
      INSERT INTO triage_applicants (
        triage_id, drop_id, file_name, stored_name, file_size, mime_type, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      triageId, dropId, file.originalname, path.basename(file.path),
      file.size ?? null, file.mimetype ?? null, hash, stamp,
    )

    recount(triageId)
    return { added: true, id: Number(info.lastInsertRowid), duplicate: false }
  } catch (error) {
    if (!String(error.message).includes('UNIQUE')) throw error

    /*
     * The same bytes are already in this Triage. The file on disk is removed
     * rather than kept: it is a second copy of something already stored, and
     * keeping it would mean the deletion path had two files to find.
     */
    fs.promises.unlink(file.path).catch(() => {})

    const original = db.prepare(
      `SELECT id, file_name FROM triage_applicants WHERE triage_id = ? AND content_hash = ?`,
    ).get(triageId, hash)

    return {
      added: false, duplicate: true,
      duplicateOf: original?.id ?? null,
      originalName: original?.file_name ?? null,
    }
  }
}

/**
 * Opens a delivery — the thing a pile of CVs is added to.
 *
 * Every CV belongs to one. The first is opened when the session is created, so
 * a launch is simply "drop 1 is ready"; later ones are opened when a recruiter
 * adds more. The number is what makes the queue able to run twice: parse and
 * preliminary are keyed by drop, so the second delivery is a different unit of
 * work rather than a duplicate of the first that the database silently ignores.
 */
export function openDrop({ triageId, recruiterId = null }) {
  const next = db.prepare(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM triage_drops WHERE triage_id = ?`,
  ).get(triageId).seq

  const info = db.prepare(`
    INSERT INTO triage_drops (triage_id, seq, recruiter_id, created_at) VALUES (?, ?, ?, ?)
  `).run(triageId, next, recruiterId ?? null, now())

  return { id: Number(info.lastInsertRowid), seq: next, triageId }
}

/**
 * Gives a session that predates deliveries one for the CVs it already holds.
 *
 * Those rows carry drop_id NULL. Left that way a session could hold two kinds
 * of row at once, and everything that works per delivery — parsing above all —
 * would see one kind and not the other: a draft uploaded before this code and
 * launched after it would have had its original CVs charged and then never
 * read, while the session reported itself complete.
 *
 * So the old pile is adopted into a delivery of its own, numbered 1, before any
 * new delivery is opened. The history then reads honestly — "36 CVs at the
 * start, 12 more on Friday" — rather than folding the old pile into whatever
 * arrived next.
 */
export function ensureLaunchDrop(triageId) {
  const orphans = db.prepare(
    `SELECT COUNT(*) AS n FROM triage_applicants WHERE triage_id = ? AND drop_id IS NULL`,
  ).get(triageId).n

  if (orphans === 0) return null

  const drop = openDrop({ triageId })
  db.prepare(`UPDATE triage_applicants SET drop_id = ? WHERE triage_id = ? AND drop_id IS NULL`)
    .run(drop.id, triageId)
  closeDrop(drop.id)
  adoptSessionCharge({ triageId, dropId: drop.id })

  return drop
}

/**
 * Moves a session's existing charge onto the delivery that now holds the CVs
 * it paid for.
 *
 * This is the one that would have cost real money. A Triage launched before
 * charging moved onto deliveries carries its charge on the triages row: a
 * ledger id, a charged count, and no drop to hang them on. The first time a
 * recruiter adds CVs to it, the old pile is adopted into a delivery — and that
 * delivery would arrive with ledger_id NULL, which is the word for "not paid
 * for". The next charge sweep would have billed the organization a second time
 * for CVs it had already bought.
 *
 * So the charge follows the CVs. The drop is marked paid with the session's own
 * ledger row and counts, and nothing new is written to the ledger: no money
 * moved, this is the same charge being recorded where it now belongs.
 *
 * Only ever onto a drop that has none of its own, and only from a session whose
 * charge is not already attributed to a delivery — a session with two paid
 * drops has nothing left over, and copying a total onto a third would invent a
 * charge that never happened.
 */
function adoptSessionCharge({ triageId, dropId }) {
  const triage = db.prepare(
    `SELECT ledger_id, charged_cvs, refunded_cvs FROM triages WHERE id = ?`,
  ).get(triageId)

  if (!triage?.ledger_id || (triage.charged_cvs ?? 0) <= 0) return false

  const attributed = db.prepare(
    `SELECT COUNT(*) AS n FROM triage_drops WHERE triage_id = ? AND ledger_id IS NOT NULL`,
  ).get(triageId).n
  if (attributed > 0) return false

  const claimed = db.prepare(`
    UPDATE triage_drops
    SET ledger_id = ?, charged_cvs = ?, refunded_cvs = ?, charged_at = COALESCE(charged_at, ?)
    WHERE id = ? AND ledger_id IS NULL
  `).run(
    triage.ledger_id, triage.charged_cvs, triage.refunded_cvs ?? 0,
    now(), dropId,
  )

  return claimed.changes > 0
}

/**
 * The delivery a new file joins: the newest one, or a fresh one if the session
 * has none.
 */
export function currentDrop({ triageId, recruiterId = null }) {
  /* Anything already here belongs to a delivery of its own first. */
  ensureLaunchDrop(triageId)

  const open = db.prepare(
    `SELECT id, seq FROM triage_drops WHERE triage_id = ? ORDER BY seq DESC LIMIT 1`,
  ).get(triageId)

  return open ? { ...open, triageId } : openDrop({ triageId, recruiterId })
}

/** Records how many rows a delivery ended up holding. Display only. */
export function closeDrop(dropId) {
  db.prepare(`
    UPDATE triage_drops SET files = (
      SELECT COUNT(*) FROM triage_applicants WHERE drop_id = ?
    ) WHERE id = ?
  `).run(dropId, dropId)
}

/** The newest delivery, or null when a session has none. */
export function latestDrop(triageId) {
  return db.prepare(
    `SELECT id, seq FROM triage_drops WHERE triage_id = ? ORDER BY seq DESC LIMIT 1`,
  ).get(triageId) ?? null
}

/**
 * Adds CVs to a session that is already running, as one delivery.
 *
 * This is the whole of rolling Triage on the server: open a delivery, write the
 * rows, start the pipeline for it. Everything else — parsing only these files,
 * ranking them after the ones already there, analysing them — follows from the
 * drop the batches carry.
 *
 * It takes files that are already on disk, in the shape multer produces, so the
 * route that calls it stays a thin wrapper around this.
 */
export function addCvsToSession({ triageId, recruiterId = null, files = [] }) {
  /* A session that predates deliveries gets one for its existing CVs before
     this one is opened, so the new files are never mixed in with them. */
  ensureLaunchDrop(triageId)
  const drop = openDrop({ triageId, recruiterId })
  const results = []

  for (const file of files) {
    const outcome = addFile({ triageId, file, dropId: drop.id })
    results.push(outcome.duplicate
      ? { name: file.originalname, status: 'duplicate', reason: 'The same file is already in this session.' }
      : { name: file.originalname, status: 'added', id: outcome.id })
  }

  closeDrop(drop.id)
  return { drop, results, added: results.filter((row) => row.status === 'added').length }
}

/**
 * Moves a session between open, paused and closed.
 *
 * Q7: any seat may pause and close. Deleting is the one that is restricted,
 * and it is restricted elsewhere — these three are all reversible, and a
 * colleague who closes a session somebody else is still reading has caused an
 * inconvenience rather than a loss.
 *
 * Q16 decides what closing does to work in flight: analysis already paid for
 * finishes. Nothing here touches the queue. Batches already enqueued run to
 * completion, and what stops is new work — no more deliveries, and no more
 * tranches when the recruiter scrolls. A session that stopped mid-analysis
 * and threw away CVs the recruiter had bought would be a worse outcome than
 * one that finishes and then sits still.
 *
 * Closing starts the retention clock and reopening clears it, because a
 * reopened session is in use again and deleting its CVs on a date set by a
 * decision that has since been reversed would be indefensible.
 */
export function setLifecycle({ triageId, to }) {
  if (!LIFECYCLES.includes(to)) return { ok: false, reason: 'unknown_state' }

  const row = db.prepare(
    `SELECT id, status, lifecycle, closed_at FROM triages WHERE id = ?`,
  ).get(triageId)
  if (!row) return { ok: false, reason: 'not_found' }

  const from = lifecycleOf(row)

  /* A draft has nothing to pause or close — there is no work and no charge,
     and the way to abandon one is to delete it. */
  if (row.status === 'draft' && to !== 'open') {
    return { ok: false, reason: 'not_started', from }
  }

  /*
   * A failed session cannot be opened.
   *
   * Everything downstream refuses it anyway — adding CVs answers "start a new
   * one", startProcessing skips it, settleStatus will not move it — so
   * "opening" one produced a session that reads as a live shortlist, holds a
   * slot against the cap, and can do nothing at all. Reviving a failed
   * session is a real thing to want and it is not this: it needs the error
   * cleared and the work requeued, which is its own job.
   */
  if (row.status === 'failed' && to === 'open') {
    return { ok: false, reason: 'failed', from }
  }

  if (from === to) return { ok: true, changed: false, from, to }

  const stamp = now()

  if (to === 'closed') {
    const days = TRIAGE.retainAfterCloseDays
    const purge = days > 0
      ? new Date(Date.now() + days * 86400000).toISOString()
      : null

    db.prepare(`
      UPDATE triages SET lifecycle = 'closed', closed_at = ?, purge_after = ?, updated_at = ?
      WHERE id = ?
    `).run(stamp, purge, stamp, triageId)

    return { ok: true, changed: true, from, to, purgeAfter: purge }
  }

  /*
   * Only REOPENING clears the date. Pausing does not.
   *
   * They were cleared together, on reasoning that is true of one and not the
   * other: a reopened session is in use again, so deleting its CVs on a date
   * set by a decision that has been reversed would be indefensible. A paused
   * session has not been reversed — it is still finished with, it just is not
   * being worked on — and wiping its date silently held the CVs past the day
   * the product had already shown the recruiter. Worse, pausing is outside
   * the open-session cap, so "close everything, then pause it" was a
   * supported way to hold unlimited CVs on disk for ever.
   */
  if (to === 'open') {
    db.prepare(`
      UPDATE triages SET lifecycle = 'open', closed_at = NULL, purge_after = NULL, updated_at = ?
      WHERE id = ?
    `).run(stamp, triageId)
    return { ok: true, changed: true, from, to, purgeAfter: null }
  }

  const kept = db.prepare(`SELECT purge_after AS at FROM triages WHERE id = ?`).get(triageId)?.at
  db.prepare(`UPDATE triages SET lifecycle = ?, updated_at = ? WHERE id = ?`)
    .run(to, stamp, triageId)

  return { ok: true, changed: true, from, to, purgeAfter: kept ?? null }
}

/**
 * Adding CVs to a session reopens it.
 *
 * The alternative was refusing and telling the recruiter to reopen it first,
 * which is a step that exists for the product's benefit rather than theirs —
 * somebody choosing files for a pile has already said what they want. It
 * also refused every Triage that finished before the lifecycle column
 * existed, because those read as closed, and those are the ones this button
 * is for.
 *
 * The deletion clock stops with it. A session somebody is adding to is not
 * one whose CVs should be swept ninety days from a date it was closed on.
 */
export function reopenForCvs(triageId) {
  const row = db.prepare(`SELECT lifecycle, purge_after FROM triages WHERE id = ?`).get(triageId)
  if (!row) return false
  if (row.lifecycle === 'open' && row.purge_after === null) return false

  db.prepare(`
    UPDATE triages SET lifecycle = 'open', closed_at = NULL, purge_after = NULL, updated_at = ?
    WHERE id = ?
  `).run(now(), triageId)

  return true
}

/** How many sessions this organization has open. The cap in 4.7 counts these. */
export function openSessions(companyId) {
  /*
   * Launched sessions only.
   *
   * Drafts write lifecycle 'open' like everything else, and counting them
   * made the cap block on rows the product does not show: the history lists
   * only what was launched, and setLifecycle refuses to close a draft — so
   * the error's advice, "close one you have finished with", was impossible to
   * follow for the very rows inflating the number. A company with five
   * recruiters each holding an unfinished draft silently lost five slots.
   */
  return db.prepare(`
    SELECT COUNT(*) AS n FROM triages
    WHERE company_id = ? AND ledger_id IS NOT NULL
      AND COALESCE(lifecycle,
            CASE WHEN status IN ('completed', 'failed') THEN 'closed' ELSE 'open' END) = 'open'
  `).get(companyId).n
}

/**
 * The calls a recruiter can make on an applicant.
 *
 * Deliberately three and deliberately not the folder vocabulary, which mixes
 * derived pipeline stages with decisions. Inside a Triage there is no
 * pipeline yet — nobody has been revealed or messaged — so the only honest
 * states are the ones a person chooses.
 */
export const APPLICANT_STATUSES = [
  { key: 'shortlisted', label: 'Shortlisted', hint: 'Taking them forward' },
  { key: 'maybe', label: 'Maybe', hint: 'Worth a second look' },
  { key: 'rejected', label: 'Not proceeding', hint: 'Hidden from the list by default' },
]

const APPLICANT_STATUS_KEYS = new Set(APPLICANT_STATUSES.map((row) => row.key))

/** Sets or clears one applicant's status. '' clears it. */
export function setApplicantStatus({ triageId, applicantId, status }) {
  const value = String(status ?? '').trim()
  if (value !== '' && !APPLICANT_STATUS_KEYS.has(value)) return { ok: false, reason: 'unknown' }

  const changed = db.prepare(`
    UPDATE triage_applicants SET recruiter_status = ? WHERE id = ? AND triage_id = ?
  `).run(value === '' ? null : value, applicantId, triageId)

  if (changed.changes === 0) return { ok: false, reason: 'not_found' }
  return { ok: true, status: value === '' ? null : value }
}

/**
 * What has arrived since this recruiter last looked at this session.
 *
 * Per recruiter, not per session: a colleague opening it must not mark your
 * arrivals as read. Counted from analysed_at rather than from the upload,
 * because a CV that is in the pile but has no score yet is not something to
 * come back for.
 */
export function newSince({ triageId, recruiterId }) {
  const seen = db.prepare(
    `SELECT last_seen_at AS at FROM triage_views WHERE triage_id = ? AND recruiter_id = ?`,
  ).get(triageId, recruiterId)?.at ?? null

  /* Never looked: everything is new, but saying "327 new" to somebody opening
     a session for the first time is noise. Their first look sets the mark. */
  if (!seen) return { since: null, count: 0, first: true }

  const count = db.prepare(`
    SELECT COUNT(*) AS n FROM triage_applicants
    WHERE triage_id = ? AND deep_status = 'scored' AND parse_status <> 'duplicate'
      AND analysed_at > ?
  `).get(triageId, seen).n

  return { since: seen, count, first: false }
}

/** Stamps this recruiter's place in this session. */
export function markSeen({ triageId, recruiterId }) {
  db.prepare(`
    INSERT INTO triage_views (triage_id, recruiter_id, last_seen_at) VALUES (?, ?, ?)
    ON CONFLICT(triage_id, recruiter_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `).run(triageId, recruiterId, now())
}

/** Every delivery into a session, oldest first — the drop history. */
export function listDrops(triageId) {
  return db.prepare(`
    SELECT d.id, d.seq, d.recruiter_id AS recruiterId, d.created_at AS at,
           TRIM(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, '')) AS author,
           (SELECT COUNT(*) FROM triage_applicants a WHERE a.drop_id = d.id) AS files
    FROM triage_drops d
    LEFT JOIN recruiters r ON r.id = d.recruiter_id
    WHERE d.triage_id = ? ORDER BY d.seq
  `).all(triageId)
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

/** Removes a file from a draft, and its bytes with it. */
export function removeFile({ triageId, applicantId }) {
  const row = db.prepare(
    `SELECT stored_name FROM triage_applicants WHERE id = ? AND triage_id = ?`,
  ).get(applicantId, triageId)

  if (!row) return false

  db.prepare(`DELETE FROM triage_applicants WHERE id = ?`).run(applicantId)
  fs.promises.unlink(path.join(UPLOAD_DIR, row.stored_name)).catch(() => {})
  recount(triageId)
  return true
}

/**
 * Every file in a draft, in one go.
 *
 * The alternative was one request per file from the page, and a draft holds up
 * to 500 — so "remove all" would be minutes of requests that could stop halfway
 * on a dropped connection and leave a pile nobody chose. One statement either
 * clears the draft or does not.
 *
 * Rows first, then the files, for the same reason removeFile does it: a failed
 * unlink leaves an orphan the startup sweep will collect, where the reverse
 * order would leave a row pointing at nothing.
 */
export function removeAllFiles({ triageId }) {
  const rows = db.prepare(
    `SELECT stored_name FROM triage_applicants WHERE triage_id = ?`,
  ).all(triageId)

  db.prepare(`DELETE FROM triage_applicants WHERE triage_id = ?`).run(triageId)
  for (const row of rows) {
    if (row.stored_name) fs.promises.unlink(path.join(UPLOAD_DIR, row.stored_name)).catch(() => {})
  }
  recount(triageId)
  return rows.length
}

/**
 * Removes one CV from a session, whatever state that session is in.
 *
 * The draft-only `removeFile` above is a different thing: it takes a file out
 * of a pile nobody has paid for yet. This one is the erasure route, and it
 * works on a launched session because that is where the CVs actually are.
 *
 * What goes: the row, its bytes, the extracted text and the analysis (both
 * live on the row), and its entries in any folder — those cascade, because
 * folder_triage_items declares the foreign key and foreign keys are on.
 *
 * What stays: the charge. That CV was read and analysed, which is the work
 * that was paid for, and deleting the record afterwards does not give the
 * work back. It also matters that erasure is not a way to reclaim capacity —
 * attaching a refund to a privacy right invites the wrong behaviour.
 *
 * The rank is left as a hole rather than renumbered. Renumbering would move
 * ranks that other batches are mid-way through using, to fix an arithmetic
 * problem that is better fixed by asking for the highest rank rather than the
 * count of them — see requestNextTranche.
 */
export function removeApplicant({ triageId, applicantId }) {
  const row = db.prepare(`
    SELECT id, stored_name, email, parse_status FROM triage_applicants
    WHERE id = ? AND triage_id = ?
  `).get(applicantId, triageId)

  if (!row) return null

  let promoted = null

  db.prepare(`DELETE FROM triage_applicants WHERE id = ?`).run(row.id)
  if (row.stored_name) {
    fs.promises.unlink(path.join(UPLOAD_DIR, row.stored_name)).catch(() => {})
  }

  /*
   * If this was the current CV for somebody who had sent more than one, the
   * newest of the rest becomes current.
   *
   * Without it, deleting the newest version of a person's CV hides them
   * entirely: the older ones are all marked 'duplicate', which is excluded
   * from the results, from ranking and from analysis — so a recruiter who
   * removed one CV would silently lose the candidate. The resolver in the
   * queue would fix it on the next delivery; there may never be one.
   */
  if (row.parse_status === 'parsed' && row.email) {
    const heir = db.prepare(`
      SELECT id FROM triage_applicants
      WHERE triage_id = ? AND email = ? AND parse_status = 'duplicate'
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(triageId, row.email)

    if (heir) {
      db.prepare(`
        UPDATE triage_applicants SET parse_status = 'parsed', duplicate_of = NULL WHERE id = ?
      `).run(heir.id)
      promoted = heir.id
    }
  }

  /* Anything that pointed at the deleted row as its newer version now points
     at nothing. Cleared rather than repointed: the row it named is gone. */
  db.prepare(`UPDATE triage_applicants SET duplicate_of = NULL WHERE duplicate_of = ?`)
    .run(row.id)

  recount(triageId)

  /*
   * The caller has two things left to do and this cannot do either.
   *
   * `settleStatus` lives in the queue, which imports this file — so calling
   * it here would be a cycle. And a promoted heir has no rank: it was a
   * duplicate, so the ranking pass skipped it, and nothing will ever select
   * an unranked row. Both are reported for the route to act on rather than
   * left for the next delivery, which may never come.
   *
   * Getting this wrong is quiet in both directions. Without the settle, a
   * session that just lost its last unscored CV sits at 'ready' for ever
   * reporting work that does not exist — and a legacy row in that state
   * reads as open and holds a slot against the cap. Without the ranking, the
   * heir stays invisible, which is the exact failure promoting it was meant
   * to prevent.
   */
  return { id: row.id, promoted, needsRanking: promoted !== null }
}

/** Recomputes the denormalised counters from the rows they summarise. */
export function recount(triageId) {
  /*
   * `analysed` carries the same exclusion `parsed` does, and that is not a
   * detail. It did not, and the two were read together: a session of ten,
   * all scored, taking a newer CV from somebody already in it ended up with
   * nine parsed plus one new, still ten analysed, then eleven — and the
   * workspace header rendered "11 of 10 applicants fully analysed" while the
   * results page, which filters, showed ten. Three numbers on one screen from
   * three definitions of "exists".
   */
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN parse_status = 'parsed' THEN 1 ELSE 0 END) AS parsed,
      SUM(CASE WHEN parse_status IN ('unreadable', 'failed') THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN parse_status = 'duplicate' THEN 1 ELSE 0 END) AS superseded,
      SUM(CASE WHEN deep_status = 'scored' AND parse_status <> 'duplicate' THEN 1 ELSE 0 END)
        AS analysed
    FROM triage_applicants WHERE triage_id = ?
  `).get(triageId)

  db.prepare(`
    UPDATE triages
    SET total_files = ?, parsed_files = ?, failed_files = ?, analysed_files = ?,
        superseded_files = ?, updated_at = ?
    WHERE id = ?
  `).run(
    counts.total ?? 0, counts.parsed ?? 0, counts.failed ?? 0, counts.analysed ?? 0,
    counts.superseded ?? 0, now(), triageId,
  )

  return counts
}

/**
 * The upload manifest a draft shows: every file, and what is wrong with any of
 * them. Section 2.3 asks for the failures to be listed rather than summarised,
 * because "12 files failed" is not something a recruiter can act on.
 */
export function draftFiles(triageId) {
  return db.prepare(`
    SELECT id, file_name AS name, file_size AS size, parse_status AS status, parse_error AS error
    FROM triage_applicants WHERE triage_id = ? ORDER BY id
  `).all(triageId)
}

/** Total bytes held by a draft, for the Section 9 batch ceiling. */
export function draftBytes(triageId) {
  return db.prepare(
    `SELECT COALESCE(SUM(file_size), 0) AS bytes FROM triage_applicants WHERE triage_id = ?`,
  ).get(triageId).bytes
}

// ------------------------------------------------------------ the JD ---

export function setJobDescription({ triageId, jd, title }) {
  const text = String(jd ?? '').trim()

  db.prepare(`
    UPDATE triages SET raw_jd = ?, jd_hash = ?, title = COALESCE(?, title), updated_at = ?
    WHERE id = ?
  `).run(
    text,
    text ? crypto.createHash('sha256').update(text).digest('hex') : null,
    trimOrNull(title), now(), triageId,
  )
}

export function setTitle({ triageId, title }) {
  db.prepare(`UPDATE triages SET title = ?, updated_at = ? WHERE id = ?`)
    .run(trimOrNull(title), now(), triageId)
}

/**
 * Whether this draft can be launched, and what to say if not.
 *
 * Returns every reason rather than the first, because a recruiter who fixes the
 * JD only to be told the files are wrong has been made to do the work twice.
 */
/**
 * How many CVs this Triage will be charged for.
 *
 * The stored rows, and nothing else. A duplicate never became a row — the
 * unique index on (triage_id, content_hash) refused it — and a file whose
 * contents were not a PDF or DOCX was rejected at the door and its bytes
 * deleted. So "files held" already means "files we will actually process", and
 * §6's 205-selected-but-200-valid arithmetic has happened before this is read.
 *
 * What this CANNOT know is which of those will turn out to be a scanned image
 * with no text layer: extraction runs on the queue, minutes after launch. Those
 * are charged here and handed back by the queue once it finds out — see
 * refundTriageCvs.
 */
export function chargeableCvs(triage) {
  return triage.counts.total
}

/**
 * Whether this draft can be launched, and what to say if not.
 *
 * Returns every reason rather than the first: a recruiter who fixes the JD only
 * to be told the capacity is short has been made to do the work twice.
 *
 * The two capacity limits are reported SEPARATELY and never conflated. Telling
 * somebody to buy more when their organization has six hundred CVs unused and
 * their administrator capped them at a hundred sends them to a checkout that
 * cannot fix their problem — so one message points at a purchase and the other
 * points at a person.
 */
export function launchReadiness({ triage, capacity }) {
  const problems = []
  const cvs = chargeableCvs(triage)

  if (!String(triage.jd ?? '').trim()) {
    problems.push({ code: 'no_jd', message: 'Add the job description before starting.' })
  } else if (String(triage.jd).trim().length < 80) {
    /* Short enough that no useful criteria can come out of it. Spending
       capacity on a one-line JD produces a ranking nobody can trust. */
    problems.push({
      code: 'jd_too_short',
      message: 'That job description is too short to rank against. '
        + 'Paste the full advert, or attach it as a file.',
    })
  }

  if (triage.counts.total === 0) {
    problems.push({ code: 'no_files', message: 'Upload the CVs you want sorted.' })
  }

  if (triage.counts.total > triage.fileCap) {
    problems.push({
      code: 'over_files',
      message: `One Triage takes up to ${triage.fileCap} CVs at a time. `
        + `Remove ${triage.counts.total - triage.fileCap} and put the rest through a second Triage.`,
    })
  }

  if (capacity && cvs > 0) {
    if (capacity.organizationShort > 0) {
      problems.push({
        code: 'no_capacity',
        message: `This Triage needs ${cvs} CV${cvs === 1 ? '' : 's'} of capacity and your `
          + `organization has ${capacity.balance}. Buy ${capacity.organizationShort} more to start it.`,
      })
    } else if (capacity.seatShort > 0) {
      problems.push({
        code: 'over_allowance',
        message: `Your Triage allowance leaves you ${capacity.allowance} of the ${cvs} CV`
          + `${cvs === 1 ? '' : 's'} this needs. Your organization has capacity — ask your `
          + 'administrator to raise your allowance.',
      })
    }
  }

  return { ready: problems.length === 0, problems, cvs }
}

// ------------------------------------------------------------- results ---

/**
 * A page of results.
 *
 * Ordered by the NORMALISED score across everyone analysed for this Triage, not
 * by preliminary rank — Section 3.4 is explicit that the cheap pass decides who
 * gets read first and nothing else. A candidate the preliminary pass put 40th
 * can finish above one it put 3rd, and if the list did not reorder there would
 * be no point in the deep analysis having run.
 *
 * Normalisation is the same function Search uses, over the same kind of
 * universe, so a 74 here means what a 74 there means. That shared meaning is
 * the reason Section 4 forbids inventing a separate Triage percentage.
 */
export function results({
  triageId, offset = 0, limit = TRIAGE.pageSize, includeRejected = false, since = null,
}) {
  /*
   * The score shown is the candidate's own fit, and nothing else.
   *
   * It used to be normalised across every applicant analysed so far —
   * round(fit / best * ceiling) — which is defensible when the pile is the
   * whole universe, and is not once a session stays open for weeks. The
   * denominator was the best CV in the session, so a strong arrival in week
   * four quietly lowered the number beside everybody a recruiter had already
   * read and decided about. A shortlist whose numbers move overnight is a
   * shortlist nobody trusts.
   *
   * absolute_fit is written once when the CV is scored and never touched
   * again, so this number is stable for the life of the session by
   * construction rather than by promise. Positions still move — a stronger CV
   * lands above a weaker one — but nobody's number changes.
   *
   * The cost, stated because it is real: a Triage percentage no longer means
   * exactly what a Search percentage means, since Search still normalises
   * against its pool.
   */
  /*
   * Superseded CVs are not results.
   *
   * A candidate who applied twice is one person, and the older CV — which may
   * well have been analysed before the newer one arrived — would otherwise
   * show up as a second row with the same name and a different score. The row
   * and its analysis stay in the database; they are simply not what the
   * recruiter is being shown, because the newer CV is the current version of
   * that person. See resolveDuplicatePeople.
   */
  /*
   * Q8: a rejected applicant stays in the ranking and is hidden, rather than
   * removed. "We looked and said no" is a fact worth keeping — it stops a
   * colleague re-reading the same CV, and it is the only record that the
   * decision was made at all.
   */
  const hide = includeRejected ? '' : ` AND COALESCE(recruiter_status, '') <> 'rejected'`

  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM triage_applicants
    WHERE triage_id = ? AND deep_status = 'scored' AND parse_status <> 'duplicate'${hide}
  `).get(triageId).n

  /* Counted whether or not they are shown, so the button that reveals them
     can say how many there are. */
  const rejected = db.prepare(`
    SELECT COUNT(*) AS n FROM triage_applicants
    WHERE triage_id = ? AND deep_status = 'scored' AND parse_status <> 'duplicate'
      AND recruiter_status = 'rejected'
  `).get(triageId).n

  /*
   * Named columns, ordered and paged by the database.
   *
   * This read used to be SELECT * over every scored applicant — including
   * extracted_text, the whole CV, for every row — then sorted in JavaScript and
   * sliced to twenty-five. At forty CVs nobody noticed. At eight hundred it is
   * tens of megabytes on every poll, and the workspace polls every 2.5
   * seconds. Rolling sessions are the thing that makes sessions get big.
   */
  const page = db.prepare(`
    SELECT id, display_name, email, phone, location, file_name, file_size,
           reviewed_at, absolute_fit, criteria, explanation, analysis_source, drop_id,
           recruiter_status, analysed_at, created_at
    FROM triage_applicants
    WHERE triage_id = ? AND deep_status = 'scored' AND parse_status <> 'duplicate'${hide}
    ORDER BY absolute_fit DESC, display_name ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(triageId, limit, offset)

  return {
    results: page.map((row, index) => ({
      ...applicantView(row, Math.round(row.absolute_fit ?? 0), offset + index + 1),
      status: row.recruiter_status ?? null,
      /* Marked rather than filtered: a new arrival that ranks 40th belongs at
         40, not at the top of a separate list. The badge is what draws the
         eye; the position is still the truth about the candidate. */
      isNew: Boolean(since && row.analysed_at && row.analysed_at > since),
    })),
    total,
    rejected,
    offset,
    /* How many the next page will hold, so the button can say a true number
       rather than promising 25 and delivering 6. Same reasoning as hasMore
       below: the size of a page is the server's fact, and a client that
       reproduced it would be the second place defining the funnel. */
    pageSize: limit,
    /* Whether reaching the end of this page should ask for more work. The
       client does not decide that — it would have to know the tranche size, and
       then two places would define the funnel. */
    hasMore: offset + page.length < total,
  }
}

/**
 * One applicant, as a recruiter sees them.
 *
 * Note what is absent: prelim_score and prelim_rank. Section 3 forbids showing
 * the preliminary pass as a score, and the safest way to honour that is for the
 * number never to leave the server — a field that is not serialised cannot be
 * rendered by mistake in six months.
 */
function applicantView(row, score, rank) {
  const criteria = readJson(row.criteria) ?? {}

  return {
    id: row.id,
    rank,
    score,
    name: row.display_name ?? row.file_name,
    email: row.email,
    phone: row.phone,
    location: row.location,
    fileName: row.file_name,
    fileSize: row.file_size,
    reviewedAt: row.reviewed_at,
    analysis: {
      reasoning: row.explanation,
      fit: criteria.fit ?? null,
      confidence: criteria.confidence ?? null,
      strengths: criteria.strengths ?? [],
      gaps: criteria.gaps ?? [],
      transferable: criteria.transferable ?? [],
      evidence: criteria.evidence ?? [],
      criteria: criteria.items ?? [],
      /* Written when a recruiter opens the applicant, and stored beside the
         verdicts once it has been. Absent until then. */
      explain: criteria.explain ?? null,
      source: row.analysis_source,
    },
  }
}

/**
 * The applicants who have not been scored yet, as counts by state.
 *
 * Section 4 gives each state a meaning and a UI behaviour, and the workspace
 * needs all of them at once: a spinner that cannot distinguish "still queued"
 * from "this file could not be read" tells the recruiter to wait for something
 * that is never coming.
 */
export function pipelineStates(triageId) {
  const rows = db.prepare(`
    SELECT parse_status, deep_status, COUNT(*) AS n
    FROM triage_applicants WHERE triage_id = ?
    GROUP BY parse_status, deep_status
  `).all(triageId)

  const states = {
    uploaded: 0, prioritized: 0, processing: 0, scored: 0, failed: 0, superseded: 0,
  }

  for (const row of rows) {
    if (row.parse_status === 'pending') states.uploaded += row.n
    /* Its own bucket, ahead of the failure test. Lumped in with failures it
       made the workspace say "3 files could not be read" about CVs that read
       perfectly — and a session whose only non-parsed rows were superseded
       could trip the "No applicants could be analysed" screen outright. */
    else if (row.parse_status === 'duplicate') states.superseded += row.n
    else if (row.parse_status !== 'parsed') states.failed += row.n
    else if (row.deep_status === 'scored') states.scored += row.n
    else if (row.deep_status === 'failed') states.failed += row.n
    else if (row.deep_status === 'running' || row.deep_status === 'queued') states.processing += row.n
    else states.prioritized += row.n
  }

  return states
}

/** The files that could not be read, named. */
export function failedFiles(triageId) {
  return db.prepare(`
    SELECT id, file_name AS name, parse_status AS status,
           COALESCE(parse_error, deep_error) AS error
    FROM triage_applicants
    WHERE triage_id = ?
      AND (parse_status IN ('unreadable', 'failed') OR deep_status = 'failed')
      /* Not a superseded CV, whatever its analysis did. One whose analysis
         had failed before a newer CV arrived was listed here for ever with
         its model error as the reason, hidden from the results, and
         unreachable by Retry — which only looks at parsed rows. Nothing the
         recruiter could do would clear it. */
      AND parse_status <> 'duplicate'
    ORDER BY id
  `).all(triageId)
}

/** Resolves one applicant's stored file, scoped to a Triage the caller owns. */
export function applicantFile({ triageId, applicantId }) {
  return db.prepare(`
    SELECT id, file_name, stored_name, mime_type
    FROM triage_applicants WHERE id = ? AND triage_id = ?
  `).get(applicantId, triageId) ?? null
}

/**
 * One applicant's stored analysis, for explaining it after the fact.
 *
 * Scoped to a Triage the caller has already been shown to own, like every other
 * read in this file — an applicant id on its own is a number somebody could
 * guess, and this returns the assessment of a real person's CV.
 */
export function applicantAnalysis({ triageId, applicantId }) {
  const row = db.prepare(`
    SELECT id, criteria, explanation, deep_status
    FROM triage_applicants WHERE id = ? AND triage_id = ?
  `).get(applicantId, triageId)

  if (!row) return null

  let criteria = null
  try {
    criteria = row.criteria ? JSON.parse(row.criteria) : null
  } catch {
    criteria = null
  }

  return { id: row.id, criteria, explanation: row.explanation, status: row.deep_status }
}

/** Stores the written explanation beside the verdicts it explains. */
export function attachApplicantExplanation({ triageId, applicantId, explain }) {
  const existing = applicantAnalysis({ triageId, applicantId })
  if (!existing?.criteria) return false

  const criteria = { ...existing.criteria, explain }
  db.prepare(`UPDATE triage_applicants SET criteria = ? WHERE id = ? AND triage_id = ?`)
    .run(JSON.stringify(criteria), applicantId, triageId)

  return true
}

/** Marks an applicant as read, so the list can show where the recruiter got to. */
export function markReviewed({ triageId, applicantId }) {
  db.prepare(`
    UPDATE triage_applicants SET reviewed_at = COALESCE(reviewed_at, ?)
    WHERE id = ? AND triage_id = ?
  `).run(now(), applicantId, triageId)
}

// ------------------------------------------------------------- deletion ---

/**
 * Deletes a Triage, its applicants and their files.
 *
 * Returns the stored names rather than unlinking them here, so the caller can
 * remove the bytes after the transaction commits — a failed unlink must not
 * roll back a delete that already succeeded, and a rolled-back delete must not
 * leave the files gone.
 *
 * The ledger row stays. It is the record of a payment, and a payment does not
 * stop having happened because the thing it bought was tidied away.
 */
export function deleteTriage({ companyId, id }) {
  const triage = db.prepare(`SELECT id FROM triages WHERE id = ? AND company_id = ?`)
    .get(id, companyId)
  if (!triage) return null

  const files = db.prepare(`SELECT stored_name FROM triage_applicants WHERE triage_id = ?`)
    .all(id).map((row) => row.stored_name)

  db.transaction(() => {
    db.prepare(`DELETE FROM triage_applicants WHERE triage_id = ?`).run(id)
    db.prepare(`DELETE FROM triage_batches WHERE triage_id = ?`).run(id)
    db.prepare(`DELETE FROM triage_cost_events WHERE triage_id = ?`).run(id)
    db.prepare(`DELETE FROM triage_drops WHERE triage_id = ?`).run(id)
    db.prepare(`DELETE FROM triage_views WHERE triage_id = ?`).run(id)
    db.prepare(`DELETE FROM triages WHERE id = ?`).run(id)
  })()

  return files
}

/** Uploads referenced by Triage rows, so the orphan sweep does not delete them. */
export function triageUploadNames() {
  return db.prepare(`SELECT stored_name FROM triage_applicants`).all().map((row) => row.stored_name)
}
