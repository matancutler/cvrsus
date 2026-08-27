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
import { normalizeUniverse } from './matching/normalize.js'

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
}

function num(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
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
  const info = db.prepare(`
    INSERT INTO triages (company_id, recruiter_id, title, file_cap, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
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
export function listTriages(companyId) {
  return db.prepare(`
    SELECT t.*,
           TRIM(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, '')) AS author
    FROM triages t
    LEFT JOIN recruiters r ON r.id = t.recruiter_id
    WHERE t.company_id = ?
    ORDER BY t.created_at DESC
  `).all(companyId).map(triageView)
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
      /* What the recruiter can read right now. Distinct from `analysed`: the
         buffer beyond the shown page is analysed but deliberately not shown. */
      frontier: row.analysis_frontier,
    },
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
export function addFile({ triageId, file }) {
  const hash = hashFile(file.path)
  const stamp = now()

  try {
    const info = db.prepare(`
      INSERT INTO triage_applicants (
        triage_id, file_name, stored_name, file_size, mime_type, content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      triageId, file.originalname, path.basename(file.path),
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

/** Recomputes the denormalised counters from the rows they summarise. */
export function recount(triageId) {
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN parse_status = 'parsed' THEN 1 ELSE 0 END) AS parsed,
      SUM(CASE WHEN parse_status IN ('unreadable', 'failed') THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN deep_status = 'scored' THEN 1 ELSE 0 END) AS analysed
    FROM triage_applicants WHERE triage_id = ?
  `).get(triageId)

  db.prepare(`
    UPDATE triages
    SET total_files = ?, parsed_files = ?, failed_files = ?, analysed_files = ?, updated_at = ?
    WHERE id = ?
  `).run(
    counts.total ?? 0, counts.parsed ?? 0, counts.failed ?? 0, counts.analysed ?? 0,
    now(), triageId,
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
export function results({ triageId, offset = 0, limit = TRIAGE.pageSize }) {
  const scored = db.prepare(`
    SELECT * FROM triage_applicants
    WHERE triage_id = ? AND deep_status = 'scored'
  `).all(triageId)

  const scores = normalizeUniverse(
    scored.map((row) => ({ candidateId: row.id, absoluteFit: row.absolute_fit })),
  )

  const ordered = scored
    .map((row) => ({ row, score: scores.get(row.id) ?? 0 }))
    .sort((a, b) => b.score - a.score
      || String(a.row.display_name ?? '').localeCompare(String(b.row.display_name ?? '')))

  const page = ordered.slice(offset, offset + limit)

  return {
    results: page.map(({ row, score }, index) => applicantView(row, score, offset + index + 1)),
    total: ordered.length,
    offset,
    /* Whether reaching the end of this page should ask for more work. The
       client does not decide that — it would have to know the tranche size, and
       then two places would define the funnel. */
    hasMore: offset + page.length < ordered.length,
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
      probes: criteria.probes ?? [],
      criteria: criteria.items ?? [],
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

  const states = { uploaded: 0, prioritized: 0, processing: 0, scored: 0, failed: 0 }

  for (const row of rows) {
    if (row.parse_status === 'pending') states.uploaded += row.n
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
    WHERE triage_id = ? AND (parse_status IN ('unreadable', 'failed') OR deep_status = 'failed')
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
    db.prepare(`DELETE FROM triages WHERE id = ?`).run(id)
  })()

  return files
}

/** Uploads referenced by Triage rows, so the orphan sweep does not delete them. */
export function triageUploadNames() {
  return db.prepare(`SELECT stored_name FROM triage_applicants`).all().map((row) => row.stored_name)
}
