import db from './db.js'
import { maskedDisplayName } from './schema.js'
import { activityStatus, candidatesHiddenFrom } from './profiles.js'

/**
 * Folders and folder items order by a REAL `position`. Dropping an item between
 * two neighbours stores the midpoint of their positions, so a reorder writes one
 * row instead of renumbering the whole list.
 */
const POSITION_GAP = 1024

function nextPosition(table, whereColumn, whereValue) {
  const row = db.prepare(
    `SELECT MAX(position) AS max FROM ${table} WHERE ${whereColumn} = ?`,
  ).get(whereValue)

  return (row.max ?? 0) + POSITION_GAP
}

/** Midpoint between two neighbours, or an end position when dropped at an edge. */
export function positionBetween(before, after) {
  if (before == null && after == null) return POSITION_GAP
  if (before == null) return after - POSITION_GAP
  if (after == null) return before + POSITION_GAP
  return (before + after) / 2
}

// --------------------------------------------------------------- folders ---

/**
 * The company a recruiter belongs to.
 *
 * Every folder query goes through this rather than taking a company id as an
 * argument. There are a dozen call sites across index.js, and a signature that
 * asked each of them for the scope would be a dozen chances to pass the wrong
 * one — where wrong means one company reading another's shortlists. Resolving
 * it here from the authenticated recruiter costs one indexed read and cannot be
 * got wrong from the outside.
 */
function companyOf(recruiterId) {
  return db.prepare(`SELECT company_id FROM recruiters WHERE id = ?`)
    .get(recruiterId)?.company_id ?? null
}

/**
 * Where a saved candidate stands with the recruiter who saved them.
 *
 * Two kinds of thing, deliberately in one list because the recruiter thinks of
 * them as one pipeline.
 *
 * The first four are `derived: true` — facts the database already knows. Nobody
 * types them and nobody can forget to update them: revealing someone moves them
 * off "Potential reveal" the moment it happens, and a reply moves them to
 * "Replied" without anyone noticing it arrived. A status you have to maintain by
 * hand is a status that is wrong by the end of the week.
 *
 * The last two are decisions. No amount of data tells you whether a recruiter
 * rates somebody, so those are stored, and storing one pins the row: it stays
 * put until the recruiter changes it or chooses Automatic again. That means a
 * pinned row can fall behind the facts — someone marked Shortlisted who then
 * replies still reads Shortlisted — which is the right way round, because the
 * recruiter's own judgement should not be overwritten by an event.
 */
export const FOLDER_STATUSES = [
  { key: 'potential', label: 'Potential reveal', derived: true, hint: 'Saved, not revealed yet' },
  { key: 'to_contact', label: 'Yet to be contacted', derived: true, hint: 'Revealed, no message sent' },
  { key: 'contacted', label: 'Contacted', derived: true, hint: 'You messaged them, no reply yet' },
  { key: 'replied', label: 'Replied', derived: true, hint: 'They answered you' },
  { key: 'shortlisted', label: 'Shortlisted', derived: false, hint: 'Your call — taking them forward' },
  { key: 'not_proceeding', label: 'Not proceeding', derived: false, hint: 'Your call — not this time' },
]

const STATUS_KEYS = new Set(FOLDER_STATUSES.map((s) => s.key))
const STATUS_LABELS = Object.fromEntries(FOLDER_STATUSES.map((s) => [s.key, s.label]))

/** Whether a client-supplied status is one we recognise. '' clears it. */
export function isFolderStatus(value) {
  return value === null || value === '' || STATUS_KEYS.has(value)
}

/**
 * The stage the facts put someone at, ignoring any stored decision.
 *
 * Ordered by how far along the relationship is, so the first condition that
 * holds is the furthest one reached.
 */
function derivedStatus({ revealed, sentByRecruiter, sentByCandidate }) {
  if (sentByCandidate) return 'replied'
  if (sentByRecruiter) return 'contacted'
  if (revealed) return 'to_contact'
  return 'potential'
}

export function listFolders(recruiterId) {
  /*
   * Company-scoped, not recruiter-scoped — and the reveal set with it.
   *
   * A dozen call sites reach this function, and a signature that asked each of
   * them for the scope would be a dozen chances to pass the wrong one, where
   * wrong means one company reading another's shortlists, or shipping a surname
   * and a photograph to somebody who has not paid for either. Two indexed reads
   * that cannot be got wrong from outside.
   */
  const companyId = companyOf(recruiterId)

  /* Who made each one, so a shared list can say where a folder came from. */
  const folders = db.prepare(`
    SELECT f.*, r.first_name AS creator_first_name, r.last_name AS creator_last_name
    FROM folders f
    LEFT JOIN recruiters r ON r.id = f.recruiter_id
    WHERE f.company_id = ?
    ORDER BY f.position, f.id
  `).all(companyId).map(({ creator_first_name, creator_last_name, ...folder }) => ({
    ...folder,
    created_by: [creator_first_name, creator_last_name].filter(Boolean).join(' ') || null,
    mine: folder.recruiter_id === recruiterId,
  }))

  const revealedIds = new Set(db.prepare(
    `SELECT candidate_id FROM organization_reveals WHERE company_id = ?`,
  ).all(companyId).map((row) => row.candidate_id))

  // The same summary the search results show, so a folder row and a result row
  // read identically. `notes` is that summary — the persisted, sanitised one —
  // and it was named in this comment before it was in the SELECT.
  const items = db.prepare(`
    SELECT fi.folder_id, fi.candidate_id, fi.position, fi.status, fi.added_at,
           /* What they scored when they were filed, and against what. */
           fi.score AS saved_score, fi.scored_for, fi.scored_at, fi.analysis AS saved_analysis,
           c.name, c.first_name, c.last_name, c.location, c.photo_name,
           c.availability, c.capacity, c.open_to_relocation, c.notes,
           /* Whether they are still around, so a folder can be narrowed the same
              way a result list can. Every column activityStatus reads — the
              three flags included, because without them somebody who said no
              reads as current in a folder while reading as hidden everywhere
              else, and the point of one clock is that it cannot. */
           c.missed_checkins, c.last_confirmed_active, c.last_seen_at, c.created_at,
           c.hidden_from_search, c.deactivated_at, c.auto_hidden_at,
           (SELECT GROUP_CONCAT(d.slot) FROM documents d WHERE d.candidate_id = c.id) AS slots,
           /* Anyone on the team, not just the caller. The folder is shared, so
              "contacted" has to mean the company contacted them — otherwise a
              colleague opens the same list and reads "yet to be contacted" over
              a conversation that is already running. */
           EXISTS (SELECT 1 FROM messages m
                   JOIN recruiters mr ON mr.id = m.recruiter_id
                   WHERE m.candidate_id = c.id AND mr.company_id = ?
                     AND m.sender = 'recruiter') AS sent_by_recruiter,
           EXISTS (SELECT 1 FROM messages m
                   JOIN recruiters mr ON mr.id = m.recruiter_id
                   WHERE m.candidate_id = c.id AND mr.company_id = ?
                     AND m.sender = 'candidate') AS sent_by_candidate
    FROM folder_items fi
    JOIN folders f ON f.id = fi.folder_id
    JOIN candidates c ON c.id = fi.candidate_id
    WHERE f.company_id = ?
    ORDER BY fi.position, fi.id
  `).all(companyId, companyId, companyId)

  /* One read for the whole folder, as the search does for a page of results. */
  const tags = tagIndex(companyId)

  const shaped = items.map((item) => {
    /*
     * Same rule as everywhere else a recruiter sees a candidate: masked until
     * their organization has revealed them.
     *
     * photo_name is destructured out and never forwarded. This list used to
     * pass it straight through from the join, which put every saved
     * candidate's face on the folders tab whether or not anyone had paid to
     * see it — the one screen where the masking did not apply.
     */
    const {
      name, first_name, last_name, slots, photo_name,
      sent_by_recruiter, sent_by_candidate, status,
      missed_checkins, last_confirmed_active, last_seen_at, created_at,
      hidden_from_search, deactivated_at, auto_hidden_at,
      /* Pulled out and re-emitted as `summary` below, so a folder row calls it
         what a result card and a profile dialog call it. */
      notes,
      saved_score, scored_for, scored_at, saved_analysis,
      ...rest
    } = item

    const revealed = revealedIds.has(item.candidate_id)
    const derived = derivedStatus({
      revealed,
      sentByRecruiter: Boolean(sent_by_recruiter),
      sentByCandidate: Boolean(sent_by_candidate),
    })
    const effective = STATUS_KEYS.has(status) ? status : derived

    return {
      ...rest,
      revealed,
      summary: notes ?? null,
      display_name: revealed
        ? [first_name, last_name].filter(Boolean).join(' ')
        : maskedDisplayName(first_name),
      has_photo: revealed && Boolean(photo_name),
      open_to_relocation: item.open_to_relocation === null ? null : Boolean(item.open_to_relocation),
      documents: slots ? slots.split(',') : [],
      /* What this team calls them — the same strip the result row draws, and
         the same thing the tag filter reads. */
      tags: tags.get(item.candidate_id) ?? [],
      /*
       * The same shape the search results carry, so one set of filter rules
       * covers both. Reported rather than folded into the row: how recently
       * somebody confirmed they are looking is a fact about them, not about
       * this folder.
       */
      activity: activityStatus({
        missed_checkins, last_confirmed_active, last_seen_at, created_at,
        hidden_from_search, deactivated_at, auto_hidden_at,
      }),
      status: {
        key: effective,
        label: STATUS_LABELS[effective],
        // So the picker can show which option is currently in force, and
        // whether it got there by itself or because somebody chose it.
        pinned: STATUS_KEYS.has(status),
      },
      /*
       * What they scored on the day they were filed, and against which search.
       *
       * Absent, not zero, when there is none — a candidate dragged in from
       * another folder was never scored against anything, and a 0% would say
       * something false about them rather than nothing.
       */
      ...(saved_score === null || saved_score === undefined
        /* Nothing was kept with them, so go and find what was stored at the
           time. Null all round when there is nothing to find, which is the
           truth about a candidate dragged in from somewhere with no search
           behind it. */
        ? (recoveredReading(item.candidate_id, item.folder_id) ?? {
          score: null, scoredFor: null, scoredAt: null, analysis: null,
        })
        : {
          score: saved_score,
          scoredFor: scored_for ?? null,
          scoredAt: scored_at ?? null,
          analysis: saved_analysis ? JSON.parse(saved_analysis) : null,
        }),
    }
  })

  /*
   * A saved candidate who has since blocked this employer leaves the folders.
   *
   * Saving somebody is not a licence that outlives their consent. Without this
   * the block was a future-search preference: the candidate vanished from every
   * new search and stayed in the folder they were already in, under their full
   * name if the organization had revealed them, reachable for as long as anyone
   * kept the list. That is the loophole worth closing, because a recruiter who
   * has already saved someone is precisely the one a candidate is trying to get
   * away from.
   *
   * The folder_items rows are left alone. The block is a live restriction and
   * can be lifted, and deleting the recruiter's shortlist because of it would
   * destroy their work over a state that may change tomorrow.
   */
  const hidden = candidatesHiddenFrom(recruiterId)
  const visible = shaped.filter((item) => !hidden.has(item.candidate_id))

  /*
   * And the Triage applicants filed into the same folders.
   *
   * They are shaped to the same fields the candidate rows above carry, so the
   * card that draws a folder does not have to know which kind it is looking at.
   * What differs is stated rather than implied:
   *
   *   fromTriage   the Triage they came out of, by id and title. This is the
   *                tag the row wears, and it is the reason a folder can hold
   *                both kinds without the list becoming ambiguous.
   *
   *   candidate_id null. There is no marketplace profile behind an applicant,
   *                so anything keyed on one — messaging, reveals, the activity
   *                clock, tags — is absent rather than empty.
   *
   * No masking, and none needed: a Triage applicant is a CV this company was
   * sent and paid to have read. There is nothing here it has not already
   * bought, which is why an applicant has no reveal state at all.
   */
  const applicants = db.prepare(`
    SELECT fti.folder_id, fti.triage_applicant_id, fti.position, fti.added_at,
           ta.display_name, ta.file_name, ta.email, ta.phone, ta.location,
           ta.absolute_fit, ta.deep_status,
           t.id AS triage_id, t.title AS triage_title
    FROM folder_triage_items fti
    JOIN folders f ON f.id = fti.folder_id
    JOIN triage_applicants ta ON ta.id = fti.triage_applicant_id
    JOIN triages t ON t.id = ta.triage_id
    WHERE f.company_id = ?
    ORDER BY fti.position, fti.id
  `).all(companyId).map((row) => ({
    folder_id: row.folder_id,
    candidate_id: null,
    triage_applicant_id: row.triage_applicant_id,
    position: row.position,
    added_at: row.added_at,
    display_name: row.display_name ?? row.file_name,
    location: row.location,
    email: row.email,
    phone: row.phone,
    availability: null,
    summary: null,
    /*
     * Null, not true and not false.
     *
     * `true` drew the green "Revealed" chip on a row nobody had revealed and no
     * reveal had been spent on — the chip means "your company paid to see this
     * person", and here nothing was paid and nothing was hidden. `false` would
     * be just as wrong the other way, since it is the state that offers a
     * Reveal button.
     *
     * A CV somebody uploaded has no reveal state: there is nothing to unlock.
     * Null says that, and both the chip and the button are gated on truthiness,
     * so neither appears.
     */
    revealed: null,
    has_photo: false,
    open_to_relocation: null,
    documents: [],
    tags: [],
    activity: null,
    /* No status. Every one of the six is about a marketplace pipeline — saved
       but not revealed, revealed but not messaged, they replied — and an
       applicant is in none of it: there is nothing to reveal and no inbox to
       message. Null rather than a seventh key, so the status filter simply
       does not match them instead of offering a stage that means nothing. */
    status: null,
    score: null,
    scoredFor: null,
    scoredAt: null,
    analysis: null,
    fromTriage: { id: row.triage_id, title: row.triage_title ?? null },
  }))

  return folders.map((folder) => ({
    ...folder,
    /* `shaped`, not the raw rows: those still carry the columns the masking
       strips out — first_name, last_name, photo_name. */
    items: [
      ...visible.filter((item) => item.folder_id === folder.id),
      ...applicants.filter((item) => item.folder_id === folder.id),
    ],
  }))
}

/**
 * File a Triage applicant into a folder.
 *
 * Both ends are checked against the caller's own company before anything is
 * written: the folder, and the Triage the applicant belongs to. Neither id is
 * trusted, because both arrive from the client — and an unchecked applicant id
 * would let one organization file another's CVs and then read the name, the
 * email and the phone number off its own folder screen.
 */
export function placeTriageApplicant({ recruiterId, folderId, applicantId }) {
  const companyId = companyOf(recruiterId)

  const folder = db.prepare(
    `SELECT id FROM folders WHERE id = ? AND company_id = ?`,
  ).get(folderId, companyId)
  if (!folder) return { ok: false, reason: 'no-folder' }

  const applicant = db.prepare(`
    SELECT ta.id FROM triage_applicants ta
    JOIN triages t ON t.id = ta.triage_id
    WHERE ta.id = ? AND t.company_id = ?
  `).get(applicantId, companyId)
  if (!applicant) return { ok: false, reason: 'no-applicant' }

  const last = db.prepare(
    `SELECT MAX(position) AS at FROM folder_triage_items WHERE folder_id = ?`,
  ).get(folderId).at

  db.prepare(`
    INSERT OR IGNORE INTO folder_triage_items (folder_id, triage_applicant_id, position, added_at)
    VALUES (?, ?, ?, ?)
  `).run(folderId, applicantId, (last ?? 0) + 1, new Date().toISOString())

  return { ok: true }
}

/** Take one out of every folder in this company. */
export function removeTriageApplicant({ recruiterId, applicantId }) {
  const companyId = companyOf(recruiterId)
  return db.prepare(`
    DELETE FROM folder_triage_items
    WHERE triage_applicant_id = ?
      AND folder_id IN (SELECT id FROM folders WHERE company_id = ?)
  `).run(applicantId, companyId).changes > 0
}

/** Which folder each Triage applicant is in, for the Triage screen's chips. */
export function triageFolderIndex(recruiterId) {
  const rows = db.prepare(`
    SELECT fti.triage_applicant_id, fti.folder_id, f.name
    FROM folder_triage_items fti
    JOIN folders f ON f.id = fti.folder_id
    WHERE f.company_id = ?
  `).all(companyOf(recruiterId))

  return Object.fromEntries(rows.map((row) => [
    row.triage_applicant_id, { id: row.folder_id, name: row.name },
  ]))
}

/**
 * The reveal log: everyone this company has spent a reveal on, newest first.
 *
 * Company-scoped from a recruiter id, exactly as listFolders is and for the
 * same reason — a signature that took the scope would be one more place to
 * pass the wrong one, and wrong here means reading another organization's
 * purchase history.
 *
 * Three things make this simpler than the folder list:
 *
 * Nobody is masked. A reveal log is by definition a list of people this
 * company has already paid to see, so the display name is the real one and the
 * photograph is theirs. maskedDisplayName has no call site here, and that is
 * the correct absence rather than a missing safeguard.
 *
 * There is no score. A reveal is not a match — the same person can be revealed
 * out of one search and be irrelevant to the next — so no number is carried and
 * the screen that draws this passes showScore={false}. What replaces it is the
 * date, which is the fact this list exists to state.
 *
 * It reads `reveals` rather than `organization_reveals`. Both record the same
 * event; `reveals` is the one hasRevealed and revealedCandidateIds consult, so
 * the log says exactly what the rest of the product treats as revealed. A row
 * that appeared here and nowhere else would be a bug nobody could see.
 */
export function revealLog(recruiterId) {
  const companyId = companyOf(recruiterId)

  const rows = db.prepare(`
    SELECT r.candidate_id, r.created_at AS revealed_at, r.recruiter_id AS revealed_by_id,
           rec.first_name AS by_first_name, rec.last_name AS by_last_name,
           c.first_name, c.last_name, c.location, c.photo_name,
           c.availability, c.capacity, c.open_to_relocation, c.notes,
           c.missed_checkins, c.last_confirmed_active, c.last_seen_at, c.created_at,
           c.hidden_from_search, c.deactivated_at, c.auto_hidden_at,
           (SELECT GROUP_CONCAT(d.slot) FROM documents d WHERE d.candidate_id = c.id) AS slots
    FROM reveals r
    JOIN candidates c ON c.id = r.candidate_id
    LEFT JOIN recruiters rec ON rec.id = r.recruiter_id
    WHERE r.company_id = ?
    ORDER BY r.created_at DESC, r.id DESC
  `).all(companyId)

  const tags = tagIndex(companyId)
  /* Where each one is filed, so the card can wear the same folder chip it
     wears in a search rather than looking like a different object here. */
  const filed = folderIndex(recruiterId)

  const shaped = rows.map((row) => ({
    candidate_id: row.candidate_id,
    revealed: true,
    display_name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    location: row.location,
    availability: row.availability,
    capacity: row.capacity,
    open_to_relocation: row.open_to_relocation === null ? null : Boolean(row.open_to_relocation),
    summary: row.notes ?? null,
    has_photo: Boolean(row.photo_name),
    documents: row.slots ? row.slots.split(',') : [],
    tags: tags.get(row.candidate_id) ?? [],
    folder: filed[row.candidate_id] ?? null,
    activity: activityStatus({
      missed_checkins: row.missed_checkins,
      last_confirmed_active: row.last_confirmed_active,
      last_seen_at: row.last_seen_at,
      created_at: row.created_at,
      hidden_from_search: row.hidden_from_search,
      deactivated_at: row.deactivated_at,
      auto_hidden_at: row.auto_hidden_at,
    }),
    revealedAt: row.revealed_at,
    /* Null when the account has since been deleted. The reveal still happened
       and the company still paid for it, so the row stays and only the name
       goes — the same rule revealedBy() follows. */
    revealedBy: [row.by_first_name, row.by_last_name].filter(Boolean).join(' ') || null,
    revealedById: row.revealed_by_id,
  }))

  /*
   * A candidate who has since blocked this employer drops out, exactly as they
   * drop out of the folders.
   *
   * The company did pay to see them, and this list is in one sense a receipt.
   * But it is also a working screen with their name, their location and a link
   * to their profile on it, and a block is a live restriction on precisely
   * that. The `reveals` row is untouched: billing history is not rewritten,
   * and the person reappears here if they ever unblock.
   */
  const hidden = candidatesHiddenFrom(recruiterId)
  return shaped.filter((item) => !hidden.has(item.candidate_id))
}

/**
 * Pin a status on a saved candidate, or pass null/'' to hand them back to the
 * automatic pipeline.
 *
 * Scoped to the company's folders, so an id from another workspace updates
 * nothing rather than reaching across. Anyone on the team may set it — the
 * shortlist is theirs jointly, and so is where each candidate stands on it.
 */
export function setFolderStatus({ recruiterId, candidateId, status }) {
  const value = status === '' || status == null ? null : status

  return db.prepare(`
    UPDATE folder_items SET status = ?
    WHERE candidate_id = ?
      AND folder_id IN (SELECT id FROM folders WHERE company_id = ?)
  `).run(value, candidateId, companyOf(recruiterId)).changes > 0
}

/* recruiter_id records who made it, for the "added by" line; company_id is what
   grants access. */
export function createFolder(recruiterId, name) {
  const companyId = companyOf(recruiterId)
  const info = db.prepare(`
    INSERT INTO folders (recruiter_id, company_id, name, position, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    recruiterId, companyId, name,
    nextPosition('folders', 'company_id', companyId),
    new Date().toISOString(),
  )

  return Number(info.lastInsertRowid)
}

export function getFolder(recruiterId, folderId) {
  return db.prepare(
    `SELECT * FROM folders WHERE id = ? AND company_id = ?`,
  ).get(folderId, companyOf(recruiterId)) ?? null
}

export function renameFolder(recruiterId, folderId, name) {
  return db.prepare(
    `UPDATE folders SET name = ? WHERE id = ? AND company_id = ?`,
  ).run(name, folderId, companyOf(recruiterId)).changes > 0
}

export function deleteFolder(recruiterId, folderId) {
  /* Scoped before the children go, or a folder id from another company would
     have its items deleted on the way to being told the folder is not there. */
  if (!getFolder(recruiterId, folderId)) return false

  db.prepare(`DELETE FROM folder_items WHERE folder_id = ?`).run(folderId)
  return db.prepare(
    `DELETE FROM folders WHERE id = ? AND company_id = ?`,
  ).run(folderId, companyOf(recruiterId)).changes > 0
}

export function moveFolder(recruiterId, folderId, position) {
  return db.prepare(
    `UPDATE folders SET position = ? WHERE id = ? AND company_id = ?`,
  ).run(position, folderId, companyOf(recruiterId)).changes > 0
}

// ---------------------------------------------------------- folder items ---

/**
 * Adds a candidate to a folder, or moves them there if they are already in
 * another of the company's folders. A candidate appears in at most one folder
 * per company — the shortlist is the team's, so two colleagues filing the same
 * person in two places would be two answers to one question.
 */
/**
 * The reading for a candidate filed before their score was kept with them.
 *
 * Everything saved from now on carries the row the recruiter was looking at.
 * Everything saved before that carries nothing — and there were folders full of
 * people whose profiles opened with no number and no reason, which is the
 * complaint this answers.
 *
 * The chain is folder → the search that made it → that search's job → the
 * analysis already stored for this candidate against it. All four links exist;
 * nothing here is recomputed or invented.
 *
 * One honest caveat, which the screen states: this is the fit that was stored
 * for the job, and a results list normalises the number it shows against the
 * pool that was searched. For most candidates the two agree; where they do not,
 * this is the figure the analysis actually recorded rather than a guess at what
 * the screen said that day.
 */
function recoveredReading(candidateId, folderId) {
  const row = db.prepare(`
    SELECT a.absolute_fit AS score, a.criteria_results, a.explanation, sc.title
    FROM search_chats sc
    JOIN jobs j ON j.chat_id = sc.id
    JOIN candidate_job_analyses a
      ON a.candidate_id = ? AND a.job_id = j.id AND a.jd_version = j.jd_version
    WHERE sc.folder_id = ?
    ORDER BY a.created_at DESC
    LIMIT 1
  `).get(candidateId, folderId)

  if (!row || row.score === null || row.score === undefined) return null

  /* criteria_results holds the requirement-by-requirement assessment the score
     view already knows how to draw. "no evidence" against a stated requirement
     is a miss; anything else is a hit. */
  let items = []
  try { items = JSON.parse(row.criteria_results ?? '{}')?.items ?? [] } catch { items = [] }

  const pick = (klass, missing) => items
    .filter((item) => item?.class === klass
      && (missing ? /no evidence/i.test(item.assessment ?? '') : !/no evidence/i.test(item.assessment ?? '')))
    .map((item) => item.requirement)
    .filter(Boolean)

  return {
    score: Math.max(0, Math.min(100, Math.round(row.score))),
    scoredFor: row.title ?? null,
    /* No date. The analysis records when it was computed, not when this person
       was filed, and printing one as the other would be worse than silence. */
    scoredAt: null,
    analysis: {
      reasoning: row.explanation ?? null,
      matchedRequired: pick('must-have', false),
      missingRequired: pick('must-have', true),
      matchedPreferred: pick('preferred', false),
      missingPreferred: pick('preferred', true),
    },
  }
}

export function placeCandidate({ recruiterId, folderId, candidateId, position, scored = null }) {
  const folder = getFolder(recruiterId, folderId)
  if (!folder) return false

  /* One transaction, because a move is a delete and an insert and the pair is
     the operation. Run loose, an insert that failed — a folder deleted by a
     colleague half a second ago, a constraint, a full disk — left the candidate
     removed from where they were and filed nowhere, which is the one outcome
     neither the old folder nor the new one was ever asked for. */
  return db.transaction(() => {
    db.prepare(`
      DELETE FROM folder_items
      WHERE candidate_id = ?
        AND folder_id IN (SELECT id FROM folders WHERE company_id = ?)
    `).run(candidateId, companyOf(recruiterId))

    db.prepare(`
      INSERT INTO folder_items
        (folder_id, candidate_id, position, added_at, score, scored_for, scored_at, analysis)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      folderId,
      candidateId,
      position ?? nextPosition('folder_items', 'folder_id', folderId),
      new Date().toISOString(),
      /* Null when they were filed from somewhere with no search behind it —
         dragged in from another folder, say. The row then simply has no score,
         which is the truth about it. */
      scored?.score ?? null,
      scored?.forJob ?? null,
      scored?.at ?? null,
      scored?.analysis ? JSON.stringify(scored.analysis) : null,
    )

    return true
  })()
}

export function removeFromFolders(recruiterId, candidateId) {
  return db.prepare(`
    DELETE FROM folder_items
    WHERE candidate_id = ?
      AND folder_id IN (SELECT id FROM folders WHERE company_id = ?)
  `).run(candidateId, companyOf(recruiterId)).changes > 0
}

/** Maps candidate id -> folder id for the company, to badge search results. */
export function folderIndex(recruiterId) {
  const rows = db.prepare(`
    SELECT fi.candidate_id, fi.folder_id, f.name
    FROM folder_items fi
    JOIN folders f ON f.id = fi.folder_id
    WHERE f.company_id = ?
  `).all(companyOf(recruiterId))

  return Object.fromEntries(rows.map((row) => [row.candidate_id, { id: row.folder_id, name: row.name }]))
}

// Views moved to the append-only `view_events` log in profiles.js (spec §4.6);
// the old per-pair `profile_views` counter no longer has a writer.

// --------------------------------------------------------------- threads ---

/**
 * Spec §4.8: a pair can accumulate several thread rows over its lifetime, since
 * reopening starts a new one and leaves the closed row as history. The newest
 * row is therefore the live one.
 */
function newestThread(candidateId, recruiterId) {
  return db.prepare(`
    SELECT * FROM message_threads
    WHERE candidate_id = ? AND recruiter_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(candidateId, recruiterId) ?? null
}

/**
 * A pair that has never spoken counts as open — nothing has been closed, so the
 * recruiter is free to start.
 */
export function threadStatus(candidateId, recruiterId) {
  return newestThread(candidateId, recruiterId)?.status ?? 'open'
}

/**
 * The id of the open thread for the pair, creating one if the conversation is
 * new or was reopened. A closed thread is never revived here — the caller has
 * to reopen it deliberately, so an accidental send cannot let a candidate back
 * into a conversation the recruiter ended.
 */
export function openThread({ candidateId, recruiterId }) {
  const existing = newestThread(candidateId, recruiterId)
  if (existing?.status === 'open') return existing.id

  const company = db.prepare(`SELECT company_id FROM recruiters WHERE id = ?`).get(recruiterId)
  const now = new Date().toISOString()

  const info = db.prepare(`
    INSERT INTO message_threads (recruiter_id, company_id, candidate_id, status, created_at, last_message_at)
    VALUES (?, ?, ?, 'open', ?, ?)
  `).run(recruiterId, company?.company_id ?? 0, candidateId, now, now)

  return Number(info.lastInsertRowid)
}

/** Recruiter-only, per §9. Returns false if there was nothing open to close. */
export function closeThread({ candidateId, recruiterId }) {
  const thread = newestThread(candidateId, recruiterId)
  if (!thread || thread.status !== 'open') return false

  return db.prepare(
    `UPDATE message_threads SET status = 'closed', closed_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), thread.id).changes > 0
}

/** Recruiter-only. Starts a fresh row so the closed one survives as history. */
export function reopenThread({ candidateId, recruiterId }) {
  const thread = newestThread(candidateId, recruiterId)
  if (thread?.status === 'open') return false

  openThread({ candidateId, recruiterId })
  return true
}

// ------------------------------------------------------------------ tags ---

/**
 * Five, and the colours they may be.
 *
 * A cap because these live in a strip beside a score on a list row: six tags is
 * a second line, and a second line is a different card. A fixed palette because
 * "any colour" on a shared object means a team ends up with four greens nobody
 * can tell apart — and because a hex string from a client is a stylesheet the
 * client gets to write.
 */
export const MAX_TAGS = 5
export const TAG_COLOURS = ['grey', 'red', 'amber', 'green', 'blue', 'purple']

/**
 * Every tag this company has written, by candidate.
 *
 * One query for a whole result page rather than one per row: a search returns
 * twenty-five people and the strip is drawn on all of them, so the alternative
 * is twenty-five round trips to find out that most of them have none.
 */
export function tagIndex(companyId) {
  const index = new Map()
  for (const row of db.prepare(`
    SELECT candidate_id, label, colour FROM candidate_tags
    WHERE company_id = ?
    ORDER BY position, id
  `).all(companyId)) {
    if (!index.has(row.candidate_id)) index.set(row.candidate_id, [])
    index.get(row.candidate_id).push({ label: row.label, colour: row.colour })
  }
  return index
}

export function listTags({ companyId, candidateId }) {
  return db.prepare(`
    SELECT label, colour FROM candidate_tags
    WHERE company_id = ? AND candidate_id = ?
    ORDER BY position, id
  `).all(companyId, candidateId)
}

/**
 * The whole set, replaced.
 *
 * The editor holds a draft and saves it on the tick, so this takes what the
 * recruiter ended up with rather than a stream of adds and removes — which
 * means a save that half-applied is not a state this can reach.
 */
export const setTags = db.transaction(({ companyId, candidateId, tags }) => {
  db.prepare(`DELETE FROM candidate_tags WHERE company_id = ? AND candidate_id = ?`)
    .run(companyId, candidateId)

  const now = new Date().toISOString()
  const seen = new Set()
  let position = 0

  for (const tag of tags) {
    const label = String(tag?.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!label) continue
    /* Case-insensitively unique: "Phone screened" and "phone screened" on one
       candidate is a mistake, not two tags. */
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const colour = TAG_COLOURS.includes(tag?.colour) ? tag.colour : 'grey'
    db.prepare(`
      INSERT INTO candidate_tags (company_id, candidate_id, label, colour, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(companyId, candidateId, label, colour, position, now)

    position += 1
    if (position >= MAX_TAGS) break
  }

  return listTags({ companyId, candidateId })
})

// -------------------------------------------------------------- comments ---

/**
 * One team's notes about one candidate, oldest first.
 *
 * The author's name comes from the join rather than from a copy taken at write
 * time: a recruiter who changes their surname should not leave a trail of notes
 * signed with the old one. `— a former colleague` when the account is gone,
 * because the note still happened.
 */
export function listComments({ companyId, candidateId }) {
  return db.prepare(`
    SELECT c.id, c.body, c.created_at, c.recruiter_id,
           TRIM(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, '')) AS author
    FROM candidate_comments c
    LEFT JOIN recruiters r ON r.id = c.recruiter_id
    WHERE c.company_id = ? AND c.candidate_id = ?
    ORDER BY c.created_at, c.id
  `).all(companyId, candidateId).map((row) => ({
    id: row.id,
    body: row.body,
    at: row.created_at,
    recruiterId: row.recruiter_id,
    author: row.author?.trim() || 'a former colleague',
  }))
}

export function addComment({ companyId, candidateId, recruiterId, body }) {
  db.prepare(`
    INSERT INTO candidate_comments (company_id, candidate_id, recruiter_id, body, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(companyId, candidateId, recruiterId, body, new Date().toISOString())

  return listComments({ companyId, candidateId })
}

// -------------------------------------------------------------- messages ---

export function listThread(candidateId, recruiterId) {
  return db.prepare(`
    SELECT id, sender, body, created_at, read_at
    FROM messages WHERE candidate_id = ? AND recruiter_id = ?
    ORDER BY created_at, id
  `).all(candidateId, recruiterId)
}

/**
 * Callers must check threadStatus first: this attaches the message to the open
 * thread and will silently start one if the pair has none, which is right for a
 * first contact but would quietly undo a close.
 */
export function sendMessage({ candidateId, recruiterId, sender, body }) {
  const now = new Date().toISOString()
  const threadId = openThread({ candidateId, recruiterId })

  const info = db.prepare(`
    INSERT INTO messages (candidate_id, recruiter_id, thread_id, sender, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidateId, recruiterId, threadId, sender, body, now)

  db.prepare(`UPDATE message_threads SET last_message_at = ? WHERE id = ?`).run(now, threadId)

  return Number(info.lastInsertRowid)
}

/** Marks everything the other side sent as read, and drops any standing mark. */
export function markThreadRead({ candidateId, recruiterId, reader }) {
  const from = reader === 'candidate' ? 'recruiter' : 'candidate'
  db.prepare(`
    UPDATE messages SET read_at = ?
    WHERE candidate_id = ? AND recruiter_id = ? AND sender = ? AND read_at IS NULL
  `).run(new Date().toISOString(), candidateId, recruiterId, from)

  /* Opening the thread is what "read" means, so it clears both halves at once
     — otherwise a thread marked unread by hand would stay lit after being read
     and the badge would never go out. */
  db.prepare(`
    DELETE FROM conversation_unread
    WHERE candidate_id = ? AND recruiter_id = ? AND party = ?
  `).run(candidateId, recruiterId, reader)
}

/**
 * Threads for the candidate's inbox, one per recruiter who has written.
 *
 * A conversation the candidate cleared is left out until something arrives
 * after they cleared it — the HAVING clause compares the newest message against
 * their own hidden_at rather than excluding the pair outright, so a recruiter
 * writing again brings the conversation back rather than being silently
 * swallowed. Nothing is deleted; see conversation_hidden in schema.js.
 */
export function candidateThreads(candidateId) {
  return db.prepare(`
    SELECT r.id AS recruiter_id, r.first_name, r.last_name, c.name AS company_name,
           MAX(m.created_at) AS last_at,
           MAX(
             SUM(CASE WHEN m.sender = 'recruiter' AND m.read_at IS NULL THEN 1 ELSE 0 END),
             /* A standing mark counts as one, so a thread flagged by hand shows
                unread even when nothing inbound is outstanding. MAX rather than
                a sum, or marking an already-unread thread would inflate it. */
             CASE WHEN EXISTS (
               SELECT 1 FROM conversation_unread u
               WHERE u.candidate_id = ? AND u.recruiter_id = r.id AND u.party = 'candidate'
             ) THEN 1 ELSE 0 END
           ) AS unread
    FROM messages m
    JOIN recruiters r ON r.id = m.recruiter_id
    JOIN companies c ON c.id = r.company_id
    WHERE m.candidate_id = ?
    GROUP BY r.id
    HAVING MAX(m.created_at) > COALESCE((
      SELECT h.hidden_at FROM conversation_hidden h
      WHERE h.candidate_id = ? AND h.recruiter_id = r.id AND h.party = 'candidate'
    ), '')
    ORDER BY last_at DESC
  `).all(candidateId, candidateId, candidateId).map((thread) => ({
    ...thread,
    status: threadStatus(candidateId, thread.recruiter_id),
  }))
}

/**
 * Clear a conversation from one party's inbox.
 *
 * Records the moment rather than deleting anything — the other side keeps their
 * copy, and a later message brings it back for this side too.
 */
export function hideConversation({ candidateId, recruiterId, party }) {
  db.prepare(`
    INSERT INTO conversation_hidden (candidate_id, recruiter_id, party, hidden_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (candidate_id, recruiter_id, party) DO UPDATE SET hidden_at = excluded.hidden_at
  `).run(candidateId, recruiterId, party, new Date().toISOString())
}

/**
 * Put a conversation back into the unread state for one party.
 *
 * Two things happen, and the second is what makes the mark reliable.
 *
 * Only the newest message from the other side becomes unread again, not the
 * whole history: "mark as unread" is a note to yourself to come back to it, and
 * resurrecting every message either side ever read would put a badge of eleven
 * on a conversation with one thing outstanding.
 *
 * And a standing mark is recorded either way. Clearing read_at was the whole
 * mechanism, which quietly made the feature depend on the other party having
 * written — a recruiter waiting on a reply had nothing to un-read, so the act
 * failed with "no message from them to mark unread" on exactly the threads a
 * recruiter most wants to flag. The mark is about the conversation, not about
 * one message in it.
 */
export function markThreadUnread({ candidateId, recruiterId, reader }) {
  /* There still has to be a conversation. The guard used to be "they have
     written", which is a different and much stronger thing; this one only
     refuses a pair who have never exchanged anything, so the mark cannot be
     recorded against a thread that does not exist. */
  const exists = db.prepare(`
    SELECT 1 FROM messages WHERE candidate_id = ? AND recruiter_id = ? LIMIT 1
  `).get(candidateId, recruiterId)
  if (!exists) return false

  const from = reader === 'candidate' ? 'recruiter' : 'candidate'
  const newest = db.prepare(`
    SELECT id FROM messages
    WHERE candidate_id = ? AND recruiter_id = ? AND sender = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(candidateId, recruiterId, from)

  if (newest) db.prepare(`UPDATE messages SET read_at = NULL WHERE id = ?`).run(newest.id)

  db.prepare(`
    INSERT INTO conversation_unread (candidate_id, recruiter_id, party, marked_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (candidate_id, recruiter_id, party) DO UPDATE SET marked_at = excluded.marked_at
  `).run(candidateId, recruiterId, reader, new Date().toISOString())

  return true
}

/**
 * Every conversation this recruiter has open, newest first — the recruiter-side
 * mirror of candidateThreads. The last message is fetched per thread rather than
 * with MAX(created_at), because MAX picks the latest timestamp but SQLite is free
 * to take the other columns from any row in the group.
 */
export function recruiterThreads(recruiterId) {
  const threads = db.prepare(`
    SELECT c.id AS candidate_id, c.name, c.first_name, c.last_name,
           c.location, c.photo_name, c.availability, c.capacity,
           MAX(m.created_at) AS last_at,
           COUNT(*) AS message_count,
           MAX(
             SUM(CASE WHEN m.sender = 'candidate' AND m.read_at IS NULL THEN 1 ELSE 0 END),
             /* The standing mark, same rule as candidateThreads — and the reason
                it exists: a recruiter waiting on a first reply has no inbound
                message to un-read, which is most of their threads. */
             CASE WHEN EXISTS (
               SELECT 1 FROM conversation_unread u
               WHERE u.candidate_id = c.id AND u.recruiter_id = ? AND u.party = 'recruiter'
             ) THEN 1 ELSE 0 END
           ) AS unread
    FROM messages m
    JOIN candidates c ON c.id = m.candidate_id
    WHERE m.recruiter_id = ?
    GROUP BY c.id
    /* A conversation this recruiter cleared stays out until something arrives
       after they cleared it — the candidate keeps their copy either way. Same
       rule as candidateThreads; see conversation_hidden in schema.js. */
    HAVING MAX(m.created_at) > COALESCE((
      SELECT h.hidden_at FROM conversation_hidden h
      WHERE h.candidate_id = c.id AND h.recruiter_id = ? AND h.party = 'recruiter'
    ), '')
    ORDER BY last_at DESC
  `).all(recruiterId, recruiterId, recruiterId)

  const lastMessage = db.prepare(`
    SELECT sender, body FROM messages
    WHERE recruiter_id = ? AND candidate_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 1
  `)

  /*
   * Full names here, and only here.
   *
   * This used to mask them, because messaging was free and a masked list was
   * the only thing stopping a surname riding along with a conversation nobody
   * had paid for. A recruiter can no longer open a thread with anyone their
   * organization has not revealed, so every candidate in this list is one they
   * already hold the details of — and continuing to show "Sarah C." to somebody
   * looking at that person's phone number on the next tab is not privacy, it is
   * just an inconsistency.
   *
   * The reveal is still checked per row rather than assumed. Threads predating
   * the gate exist, and one of them appearing here is not a licence to unmask.
   */
  const revealedByOrg = db.prepare(
    `SELECT 1 FROM organization_reveals WHERE company_id = ? AND candidate_id = ?`,
  )
  const companyId = db.prepare(`SELECT company_id FROM recruiters WHERE id = ?`)
    .get(recruiterId)?.company_id ?? null

  /*
   * And a conversation with somebody who has since blocked this employer is not
   * listed either — for the same reason the folders are not, and with the same
   * restraint: the messages stay in the database, because the block can be
   * lifted and the history is the candidate's as much as the recruiter's.
   */
  const hidden = candidatesHiddenFrom(recruiterId)

  return threads.filter((thread) => !hidden.has(thread.candidate_id)).map((thread) => {
    const last = lastMessage.get(recruiterId, thread.candidate_id)
    const revealed = Boolean(revealedByOrg.get(companyId, thread.candidate_id))
    /* photo_name is pulled out and never forwarded, as everywhere else a
       recruiter sees a candidate — the filename identifies someone on its own.
       A boolean is all the avatar needs. */
    const { name, first_name, last_name, photo_name, ...rest } = thread

    return {
      ...rest,
      display_name: revealed
        ? [first_name, last_name].filter(Boolean).join(' ')
        : maskedDisplayName(first_name),
      revealed,
      has_photo: revealed && Boolean(photo_name),
      status: threadStatus(thread.candidate_id, recruiterId),
      last_sender: last?.sender ?? null,
      last_body: last?.body ?? '',
    }
  })
}

/** Unread counts per candidate, for badging the recruiter's result list. */
export function recruiterUnreadByCandidate(recruiterId) {
  const rows = db.prepare(`
    SELECT candidate_id, COUNT(*) AS unread
    FROM messages
    WHERE recruiter_id = ? AND sender = 'candidate' AND read_at IS NULL
    GROUP BY candidate_id
  `).all(recruiterId)

  return Object.fromEntries(rows.map((row) => [row.candidate_id, row.unread]))
}

export function candidateUnreadTotal(candidateId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE candidate_id = ? AND sender = 'recruiter' AND read_at IS NULL
  `).get(candidateId).n
}

/**
 * How many conversations a candidate has, for the count beside the Messages
 * tab — the recruiter's bar has carried one all along.
 *
 * The same list the tab shows, counted. It used to count rows in
 * message_threads instead, which is a different question with a different
 * answer: candidateThreads groups actual messages by recruiter and drops
 * threads the candidate has hidden, so the badge said three while the list
 * underneath it showed one. A badge that disagrees with the thing it is
 * counting is worse than no badge.
 *
 * The extra work is a handful of rows for one candidate, which is the right
 * price for the two never disagreeing again.
 */
export function candidateThreadCount(candidateId) {
  return candidateThreads(candidateId).length
}
