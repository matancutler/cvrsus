import crypto from 'node:crypto'

import db from './db.js'
import { constantTimeEqual, hashLoginCode, hashPassword, verifyPassword } from './auth.js'
import { normalizeCompanyName } from './schema.js'
import { track } from './analytics.js'
import { notifySlack, stamp } from './slack.js'
import { sendRecruiterApproved, sendRecruiterDeclined } from './notify.js'

const CODE_TTL_MINUTES = 10
const MAX_CODE_ATTEMPTS = 5

// ------------------------------------------------------------- companies ---

/** Avoids characters that are easy to misread when a key is retyped. */
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function generateJoinKey() {
  const block = () => Array.from(
    { length: 4 },
    () => KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)],
  ).join('')

  return `${block()}-${block()}-${block()}`
}

/**
 * §15 removed the shared sign-up secret, so registration is open and the gate
 * moved to what a new company may DO rather than whether it may exist.
 * `approvalStatus` decides that: 'pending' companies sign in and set themselves
 * up, but reach no candidate until someone approves them.
 */
export function createCompany(name, { approvalStatus = 'pending' } = {}) {
  const now = new Date().toISOString()

  // Collisions are vanishingly unlikely, but a UNIQUE index deserves a retry
  // rather than a 500 on the one occasion it happens.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const joinKey = generateJoinKey()
    try {
      /*
       * normalized_name is written here, not left to the startup backfill.
       *
       * It was only ever filled by the `WHERE normalized_name IS NULL` pass in
       * db.js, which runs at boot — so every company registered after that ran
       * had a null one until the next restart, and employer blocking resolves
       * an organisation through exactly this column. A candidate who blocked a
       * company that signed up this morning was not hidden from them at all,
       * and nothing anywhere reported a problem.
       */
      const info = db.prepare(`
        INSERT INTO companies (name, normalized_name, join_key, created_at, approval_status, approved_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        name, normalizeCompanyName(name), joinKey, now,
        approvalStatus, approvalStatus === 'approved' ? now : null,
      )

      return { id: Number(info.lastInsertRowid), name, joinKey, approvalStatus }
    } catch (error) {
      if (!String(error.message).includes('UNIQUE')) throw error
    }
  }
  throw new Error('Could not allocate a company key. Please try again.')
}

/**
 * Who the review decision is about, and who to write to.
 *
 * The administrator rather than the company: an approval email carries the
 * company key, which is a credential, and it goes to the person who applied
 * rather than to whichever colleague happens to be first in the table.
 */
function reviewSubject(companyId) {
  const company = db.prepare(
    `SELECT id, name, join_key FROM companies WHERE id = ?`,
  ).get(companyId)
  if (!company) return null

  const admin = db.prepare(`
    SELECT id, first_name, last_name, email FROM recruiters
    WHERE company_id = ? ORDER BY is_org_admin DESC, id LIMIT 1
  `).get(companyId)

  return {
    company,
    admin,
    name: admin ? [admin.first_name, admin.last_name].filter(Boolean).join(' ') : null,
  }
}

/**
 * Lets an operator open the door for a company that has been checked.
 *
 * Sends the key and closes the loop in the review channel — but only on the
 * transition. Approving a company that is already approved is a no-op an
 * operator can run twice without a second key email landing in somebody's inbox
 * and reading like a fresh account.
 */
export function approveCompany(companyId, { reviewedBy = null } = {}) {
  const before = db.prepare(
    `SELECT approval_status FROM companies WHERE id = ?`,
  ).get(companyId)?.approval_status

  db.prepare(`
    UPDATE companies SET approval_status = 'approved', approved_at = ? WHERE id = ?
  `).run(new Date().toISOString(), companyId)

  if (before === 'approved') return

  const subject = reviewSubject(companyId)
  if (!subject) return

  track('recruiter_approved', {
    actorType: 'company', actorId: companyId, reviewedBy: reviewedBy ?? null,
  })

  if (subject.admin?.email) {
    sendRecruiterApproved({
      to: subject.admin.email,
      name: subject.admin.first_name,
      companyName: subject.company.name,
      companyKey: subject.company.join_key,
    }).catch(() => {})
  }

  notifySlack('Recruiter approved', [
    `${subject.name ?? 'Unknown'} · ${subject.company.name}`,
    `Reviewed by: ${reviewedBy ?? 'unattributed'}`,
    stamp(),
  ])
}

/**
 * Turns a company down.
 *
 * A recorded decision rather than a deletion. Leaving a refusal as "still
 * pending" means nobody can tell a company that has been looked at and refused
 * from one nobody has reached yet, so the same account gets reviewed again and
 * again. Deleting instead would lose the record entirely — and lose the reason,
 * which is exactly what you want in front of you if they register a second time.
 *
 * Reversible: approve() clears it, because a decline is often "not yet" and the
 * decision should not need a database edit to undo.
 */
export function declineCompany(companyId, reason = null, { reviewedBy = null } = {}) {
  const before = db.prepare(
    `SELECT approval_status FROM companies WHERE id = ?`,
  ).get(companyId)?.approval_status

  db.prepare(`
    UPDATE companies
    SET approval_status = 'declined', approved_at = NULL, declined_at = ?, declined_reason = ?
    WHERE id = ?
  `).run(new Date().toISOString(), reason, companyId)

  /* Once per decision. Re-recording the same refusal — which an operator does
     when they add a reason to one already declined — is not a second decision
     and must not send a second email. */
  if (before === 'declined') return

  const subject = reviewSubject(companyId)
  if (!subject) return

  track('recruiter_declined', {
    actorType: 'company', actorId: companyId, reviewedBy: reviewedBy ?? null,
  })

  if (subject.admin?.email) {
    /* The reason is deliberately not in the email. It is recorded on the
       company for whoever picks up the conversation, and a generic refusal is
       what keeps that conversation possible. */
    sendRecruiterDeclined({ to: subject.admin.email, name: subject.admin.first_name })
      .catch(() => {})
  }

  notifySlack('Recruiter not approved', [
    `${subject.name ?? 'Unknown'} · ${subject.company.name}`,
    `Reviewed by: ${reviewedBy ?? 'unattributed'}`,
    stamp(),
  ])
}

export function findCompanyByJoinKey(joinKey) {
  return db.prepare(`SELECT * FROM companies WHERE join_key = ?`).get(
    String(joinKey ?? '').trim().toUpperCase(),
  ) ?? null
}

export function getCompany(id) {
  return db.prepare(`SELECT * FROM companies WHERE id = ?`).get(id) ?? null
}

/**
 * Set or clear the company's logo, returning the filename it replaced.
 *
 * The old name comes back so the caller can unlink the file AFTER the row has
 * stopped pointing at it — the same order every photo route here follows, so a
 * failed write never leaves a row naming a file that is already gone.
 */
export function setCompanyLogo(companyId, logoName) {
  const previous = db.prepare(`SELECT logo_name FROM companies WHERE id = ?`).get(companyId)
  db.prepare(`UPDATE companies SET logo_name = ? WHERE id = ?`).run(logoName ?? null, companyId)
  return previous?.logo_name ?? null
}

export function countCompanies() {
  return db.prepare(`SELECT COUNT(*) AS n FROM companies`).get().n
}

// ------------------------------------------------------------ recruiters ---

/**
 * The sign-up fields are name, last name and password only, which cannot
 * identify a person uniquely, so a username is derived and shown to them.
 */
function deriveUsername(companyId, firstName, lastName) {
  const base = `${firstName}.${lastName}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9.]+/g, '')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '') || 'recruiter'

  const taken = db.prepare(
    `SELECT username FROM recruiters WHERE company_id = ? AND (username = ? OR username LIKE ?)`,
  ).all(companyId, base, `${base}%`).map((row) => row.username)

  if (!taken.includes(base)) return base

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}${suffix}`
    if (!taken.includes(candidate)) return candidate
  }
}

/**
 * `password` may be omitted, in which case the account starts on the default
 * derived from its username. The username is only known once it has been
 * de-duplicated against the company, which is why the caller cannot compute it
 * beforehand — the plaintext comes back as `initialPassword` instead.
 */
export async function createRecruiter({
  companyId, firstName, lastName, password, photoName = null, isOrgAdmin = false,
  // §17 — asked for on the administrator sign-up. Null for a colleague account
  // the administrator creates from the Team tab, which asks for neither.
  email = null, phone = null, website = null,
}) {
  const username = deriveUsername(companyId, firstName, lastName)
  const initialPassword = password ?? defaultPasswordFor(username)
  const passwordHash = await hashPassword(initialPassword)

  const info = db.prepare(`
    INSERT INTO recruiters (
      company_id, first_name, last_name, username, password_hash, photo_name,
      email, phone, website, is_org_admin, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    companyId, firstName, lastName, username, passwordHash, photoName,
    email, phone, website, isOrgAdmin ? 1 : 0, new Date().toISOString(),
  )

  return {
    id: Number(info.lastInsertRowid),
    companyId, firstName, lastName, username,
    email, phone, website,
    hasPhoto: Boolean(photoName),
    isOrgAdmin,
    initialPassword,
  }
}

/**
 * Short opaque tag that changes whenever the stored photo does. The photo URL is
 * keyed on the recruiter id, so without this a replaced photo keeps rendering
 * from cache until a hard refresh. A hash rather than the filename itself, so
 * the storage name never leaves the server.
 */
export function photoVersion(photoName) {
  if (!photoName) return null
  return crypto.createHash('sha1').update(String(photoName)).digest('hex').slice(0, 8)
}

/**
 * Name and photo only. The username and password are not editable here — the
 * first is a sign-in credential derived once at registration, and the second
 * needs the current password before it may change.
 */
/**
 * `contact` carries the fields sign-up asks for — email, phone, website — so a
 * recruiter can maintain them afterwards rather than having them fixed forever
 * at the moment they registered. Omitted keys are left alone, because the Team
 * editor edits a colleague's name and photo and knows nothing about the rest.
 */
export function updateRecruiter(id, { firstName, lastName, photoName, contact = null }) {
  const changed = db.prepare(`
    UPDATE recruiters SET first_name = ?, last_name = ?, photo_name = ? WHERE id = ?
  `).run(firstName, lastName, photoName ?? null, id).changes > 0

  if (contact) {
    const columns = ['email', 'phone', 'website'].filter((key) => key in contact)
    if (columns.length > 0) {
      db.prepare(`UPDATE recruiters SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...columns.map((c) => contact[c] ?? null), id)
    }
  }

  // Keep the seat's copy of the name in step while the account still exists,
  // or a rename would leave billing showing the old one forever.
  if (changed) {
    db.prepare(`UPDATE seat_purchases SET occupant_name = ? WHERE occupant_id = ?`)
      .run(`${firstName} ${lastName}`, id)
  }

  return changed
}

/**
 * The default password for an account: its username with 123 on the end. For
 * most people that is first.last123, since the username is derived from their
 * name; someone whose username needed a numeric suffix to stay unique gets
 * that suffix here too, so the rule shown in the UI is always literally true.
 *
 * Guessable by design — it exists so an administrator can hand over access
 * without inventing a password, and so a reset needs no new value. It is a
 * starting password, not a secret, which is why the account holder replaces it
 * from My profile.
 */
export function defaultPasswordFor(username) {
  return `${String(username ?? '').trim().toLowerCase() || 'recruiter'}123`
}

export async function setRecruiterPassword(id, password) {
  const hash = await hashPassword(password)
  return db.prepare(`UPDATE recruiters SET password_hash = ? WHERE id = ?`).run(hash, id).changes > 0
}

/**
 * Who is asking to reset a password, given what a sign-in screen knows.
 *
 * The company key is required alongside the username, exactly as signing in is:
 * a username on its own is not scoped to anything, so without the key this
 * would answer "does this person exist" for every company at once.
 */
export function findRecruiterForReset({ joinKey, username }) {
  const company = findCompanyByJoinKey(joinKey)
  if (!company) return null

  return db.prepare(
    `SELECT * FROM recruiters WHERE company_id = ? AND username = ?`,
  ).get(company.id, String(username ?? '').trim().toLowerCase()) ?? null
}

/** How long a reset link is worth anything. */
export const PASSWORD_RESET_MINUTES = 60

/**
 * Mint a reset token for an administrator.
 *
 * Stored hashed, like a sign-in code: the row is a credential, and a database
 * read should not hand out a working reset link for every administrator on the
 * system. The plain token is returned once, to be delivered, and is not
 * recoverable afterwards.
 *
 * Any earlier unused token for the same person is spent at the same time, so
 * asking twice does not leave two working links in two mailboxes.
 */
export function issuePasswordReset({ recruiterId, secret }) {
  const token = crypto.randomBytes(32).toString('base64url')
  const now = new Date()
  const expires = new Date(now.getTime() + PASSWORD_RESET_MINUTES * 60_000)

  db.transaction(() => {
    db.prepare(`
      UPDATE recruiter_password_resets SET used_at = ?
      WHERE recruiter_id = ? AND used_at IS NULL
    `).run(now.toISOString(), recruiterId)

    db.prepare(`
      INSERT INTO recruiter_password_resets (token_hash, recruiter_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(hashLoginCode(token, secret), recruiterId, now.toISOString(), expires.toISOString())
  })()

  return { token, expiresAt: expires.toISOString() }
}

/**
 * Spend a reset token and set the new password.
 *
 * Marked used inside the same transaction that changes the password, so a token
 * replayed while the first request is still running cannot set the password
 * twice — and a token that has expired, been used, or never existed all return
 * the same answer, because distinguishing them tells an attacker which guesses
 * were close.
 */
export async function redeemPasswordReset({ token, password, secret }) {
  const row = db.prepare(
    `SELECT * FROM recruiter_password_resets WHERE token_hash = ?`,
  ).get(hashLoginCode(String(token ?? ''), secret))

  if (!row || row.used_at || row.expires_at <= new Date().toISOString()) return null

  const spent = db.prepare(`
    UPDATE recruiter_password_resets SET used_at = ?
    WHERE token_hash = ? AND used_at IS NULL
  `).run(new Date().toISOString(), row.token_hash).changes > 0
  if (!spent) return null

  await setRecruiterPassword(row.recruiter_id, password)
  return getRecruiter(row.recruiter_id)
}

export function getRecruiter(id) {
  return db.prepare(`
    SELECT r.*, c.name AS company_name, c.join_key
    FROM recruiters r
    JOIN companies c ON c.id = r.company_id
    WHERE r.id = ?
  `).get(id) ?? null
}

export async function authenticateRecruiter({ joinKey, username, password }) {
  const company = findCompanyByJoinKey(joinKey)
  if (!company) return null

  const recruiter = db.prepare(
    `SELECT * FROM recruiters WHERE company_id = ? AND username = ?`,
  ).get(company.id, String(username ?? '').trim().toLowerCase())

  // Hash anyway when the user is unknown, so a missing username and a wrong
  // password take the same amount of time.
  const stored = recruiter?.password_hash
    ?? 'scrypt$00000000000000000000000000000000$00'
  const ok = await verifyPassword(String(password ?? ''), stored)

  return recruiter && ok ? { ...recruiter, company_name: company.name } : null
}

/*
 * One recruiter, one live session.
 *
 * Three small functions rather than one, because each is a different moment:
 * claiming the account for a device, asking whether a token still holds it, and
 * letting go on the way out. See the session_id column for why the newest
 * sign-in is the one that wins.
 */
export function claimRecruiterSession(recruiterId, sessionId) {
  db.prepare(`UPDATE recruiters SET session_id = ? WHERE id = ?`).run(sessionId, recruiterId)
  return sessionId
}

export function recruiterSessionIsCurrent(recruiterId, sessionId) {
  if (!sessionId) return false
  const row = db.prepare(`SELECT session_id FROM recruiters WHERE id = ?`).get(recruiterId)
  /* Compared in constant time like any other bearer secret: this value decides
     whether a request is honoured, and it arrives from outside. */
  return Boolean(row?.session_id) && constantTimeEqual(row.session_id, sessionId)
}

/**
 * Ends the session on sign-out, so the token cannot be replayed afterwards.
 *
 * Only when the caller is the device that holds it. A second device signing in
 * has already claimed the account, and the first one's sign-out must not reach
 * across and end that newer session on its way out of its own.
 */
export function releaseRecruiterSession(recruiterId, sessionId) {
  if (!recruiterSessionIsCurrent(recruiterId, sessionId)) return false
  db.prepare(`UPDATE recruiters SET session_id = NULL WHERE id = ?`).run(recruiterId)
  return true
}

/*
 * The company's website.
 *
 * It lives on the recruiter row for historical reasons — sign-up asks the
 * administrator for it along with their own email and phone — but it is not a
 * fact about a person. Everyone at a company shares one, and a team where three
 * seats claim three different addresses is describing three companies.
 *
 * So one value, taken from an administrator and copied to every seat: read here
 * when a colleague account is created, and written across the company whenever
 * an administrator changes their own. An ordinary recruiter has no say in it,
 * which is why nothing offers them the field.
 */
export function companyWebsite(companyId) {
  const row = db.prepare(`
    SELECT website FROM recruiters
    WHERE company_id = ? AND website IS NOT NULL AND website != ''
    ORDER BY is_org_admin DESC, created_at
    LIMIT 1
  `).get(companyId)
  return row?.website ?? null
}

/** Applies one website to every seat. Returns how many rows it touched. */
export function setCompanyWebsite(companyId, website) {
  return db.prepare(`UPDATE recruiters SET website = ? WHERE company_id = ?`)
    .run(website, companyId).changes
}

/**
 * Everyone in the company, for the "who has an account" view.
 *
 * `withContact` adds each person's email, phone and website, and defaults to
 * off. This list goes to every recruiter — it is what the workspace counts
 * seats from — so including contact details unconditionally would hand one
 * colleague's phone number to another as a side effect of them opening the app.
 * The administrator manages these accounts and sees them on the Team screen;
 * nobody else is asking, so nobody else is told.
 */
export function listRecruiters(companyId, { withContact = false } = {}) {
  const shared = withContact ? companyWebsite(companyId) : null

  return db.prepare(`
    SELECT id, first_name, last_name, username, created_at, is_org_admin, photo_name,
           email, phone, website,
           CASE WHEN photo_name IS NULL THEN 0 ELSE 1 END AS has_photo
    FROM recruiters WHERE company_id = ? ORDER BY created_at
  `).all(companyId).map(({ photo_name, email, phone, website, ...person }) => ({
    ...person,
    /*
     * The website reported is the company's, not the row's.
     *
     * Accounts created before the website was inherited still hold NULL, and
     * an administrator looking at a colleague would be told "not on file"
     * about an address the company plainly has. One value for the company
     * means reading one value for the company — see companyWebsite.
     */
    ...(withContact ? { email, phone, website: shared ?? website } : {}),
    photo_version: photoVersion(photo_name),
  }))
}

/** What the confirmation screen shows before an administrator commits. */
export function recruiterDeletionPreview(recruiterId) {
  const count = (sql) => db.prepare(sql).get(recruiterId).n

  return {
    /* Reported so the admin knows what changes hands, not what is destroyed:
       folders belong to the company now and survive the person who made them. */
    folders: count(`SELECT COUNT(*) AS n FROM folders WHERE recruiter_id = ?`),
    conversations: count(
      `SELECT COUNT(DISTINCT candidate_id) AS n FROM messages WHERE recruiter_id = ?`,
    ),
    messages: count(`SELECT COUNT(*) AS n FROM messages WHERE recruiter_id = ?`),
    savedSearches: count(`SELECT COUNT(*) AS n FROM search_chats WHERE recruiter_id = ?`),
    // Kept rather than destroyed, but the admin should still see the number.
    downloads: count(`SELECT COUNT(*) AS n FROM reveals WHERE recruiter_id = ?`),
  }
}

/**
 * Removes a recruiter and everything that was only ever theirs.
 *
 * The split is deliberate. Private working material — folders, conversations,
 * saved searches — goes, because it means nothing without the person. Records
 * that exist to be audited or billed do NOT: view_events and scoring_audit are
 * detached (their recruiter_id goes null, and view_events already denormalises
 * the name for exactly this case), reveals are left intact because they are the
 * billing meter, and seat purchases keep their row with the buyer detached.
 * Recruiter ids are AUTOINCREMENT, so a detached row can never be silently
 * re-attached to a future account.
 *
 * Returns the photo filename to unlink, if any.
 */
export function deleteRecruiterCompletely(recruiterId) {
  const recruiter = db.prepare(`SELECT photo_name FROM recruiters WHERE id = ?`).get(recruiterId)

  db.transaction(() => {
    /*
     * Folders stay. They are the company's shared shortlists now, not this
     * person's private working material, and deleting a departing recruiter
     * used to take the team's saved candidates with them — including work paid
     * for by reveals. Their authorship is handed to whoever is left so the
     * "added by" line still names a real colleague; if nobody is left the
     * company is being wound up anyway and the rows go with it.
     */
    const heir = db.prepare(`
      SELECT id FROM recruiters
      WHERE company_id = (SELECT company_id FROM recruiters WHERE id = ?)
        AND id != ?
      ORDER BY is_org_admin DESC, created_at
      LIMIT 1
    `).get(recruiterId, recruiterId)

    if (heir) {
      db.prepare(`UPDATE folders SET recruiter_id = ? WHERE recruiter_id = ?`)
        .run(heir.id, recruiterId)
    } else {
      db.prepare(`
        DELETE FROM folder_items WHERE folder_id IN (SELECT id FROM folders WHERE recruiter_id = ?)
      `).run(recruiterId)
      db.prepare(`DELETE FROM folders WHERE recruiter_id = ?`).run(recruiterId)
    }

    db.prepare(`DELETE FROM messages WHERE recruiter_id = ?`).run(recruiterId)
    db.prepare(`DELETE FROM message_threads WHERE recruiter_id = ?`).run(recruiterId)

    /* Per-party conversation state. Keyed by the pair rather than by a message,
       so the two deletes above do not take it with them. */
    db.prepare(`DELETE FROM conversation_hidden WHERE recruiter_id = ?`).run(recruiterId)
    db.prepare(`DELETE FROM conversation_unread WHERE recruiter_id = ?`).run(recruiterId)

    /* Any outstanding reset link. A live credential for an account that no
       longer exists should not survive the account by even a minute. */
    db.prepare(`DELETE FROM recruiter_password_resets WHERE recruiter_id = ?`).run(recruiterId)

    db.prepare(`
      DELETE FROM search_chat_turns WHERE chat_id IN (SELECT id FROM search_chats WHERE recruiter_id = ?)
    `).run(recruiterId)
    /* Dismissals hang off the chat, not off the recruiter, so deleting the
       chats first left rows keyed to an id that no longer exists — unreachable
       by any query and waiting to be re-attached to whatever chat id SQLite
       hands out next. Innermost first, like the block below. */
    db.prepare(`
      DELETE FROM search_dismissals WHERE chat_id IN (SELECT id FROM search_chats WHERE recruiter_id = ?)
    `).run(recruiterId)
    db.prepare(`DELETE FROM search_chats WHERE recruiter_id = ?`).run(recruiterId)
    db.prepare(`DELETE FROM outreach_drafts WHERE recruiter_id = ?`).run(recruiterId)

    /*
     * Matching state. Every one of these is scoped to the recruiter who ran the
     * search — nobody else can read a job, a session or its cached analyses —
     * so leaving them behind would strand rows that no query can ever reach
     * again. Deleted innermost first: the children are found through their
     * parent, so removing the parent first would orphan them permanently.
     */
    db.prepare(`
      DELETE FROM displayed_match_state WHERE session_id IN
        (SELECT id FROM retrieval_sessions WHERE recruiter_id = ?)
    `).run(recruiterId)
    db.prepare(`DELETE FROM retrieval_sessions WHERE recruiter_id = ?`).run(recruiterId)
    db.prepare(`
      DELETE FROM candidate_job_analyses WHERE job_id IN
        (SELECT id FROM jobs WHERE recruiter_id = ?)
    `).run(recruiterId)
    db.prepare(`
      DELETE FROM job_match_profiles WHERE job_id IN
        (SELECT id FROM jobs WHERE recruiter_id = ?)
    `).run(recruiterId)
    db.prepare(`DELETE FROM jobs WHERE recruiter_id = ?`).run(recruiterId)

    /*
     * Anonymised, never deleted. The company paid for these.
     *
     * Every reader of this table scopes by company_id — hasRevealed,
     * revealedCandidateIds, revealedBy — so deleting a leaver's rows re-masked
     * candidates their colleagues had already paid to see, and did it silently:
     * the wallet was debited months ago and organization_reveals still says so,
     * while the surface that decides what a recruiter may open had forgotten.
     * The column is nullable for exactly this, and revealedBy already reads a
     * missing recruiter as "a former colleague".
     */
    db.prepare(`UPDATE reveals SET recruiter_id = NULL WHERE recruiter_id = ?`).run(recruiterId)

    db.prepare(`UPDATE view_events SET recruiter_id = NULL WHERE recruiter_id = ?`).run(recruiterId)
    db.prepare(`UPDATE scoring_audit SET recruiter_id = NULL WHERE recruiter_id = ?`).run(recruiterId)
    db.prepare(`UPDATE seat_purchases SET purchased_by = NULL WHERE purchased_by = ?`).run(recruiterId)

    // The seat is freed but occupant_name is kept, so the billing history can
    // still say whose seat it was.
    db.prepare(`UPDATE seat_purchases SET occupant_id = NULL WHERE occupant_id = ?`).run(recruiterId)

    /*
     * The billing tables, added with the pricing model after this function was
     * written. Two different treatments, on purpose:
     *
     * Their seat's consumption record goes — it describes a seat that no longer
     * exists, and leaving it would make the next person given that recruiter id
     * inherit somebody else's spending.
     *
     * The ledger and the reveal record STAY, with the actor unset. Those rows
     * are the organization's: money moved and a candidate was opened, and both
     * remain true after the person who did it has gone. A ledger that deletes
     * its own history when an employee leaves cannot answer the question it
     * exists to answer. Both columns already render a missing actor as "—".
     */
    db.prepare(`DELETE FROM seat_usage_periods WHERE recruiter_id = ?`).run(recruiterId)
    db.prepare(`UPDATE billing_ledger SET actor_id = NULL WHERE actor_id = ?`).run(recruiterId)
    db.prepare(`UPDATE organization_reveals SET revealed_by = NULL WHERE revealed_by = ?`).run(recruiterId)

    db.prepare(`DELETE FROM recruiters WHERE id = ?`).run(recruiterId)
  })()

  return recruiter?.photo_name ?? null
}

export function recruiterDisplayName(recruiter) {
  return [recruiter.first_name, recruiter.last_name].filter(Boolean).join(' ')
}

// ----------------------------------------------------------- login codes ---

/**
 * How long a spent or expired code is kept before it is deleted.
 *
 * Far longer than the ten-minute TTL, deliberately. These rows are the
 * brute-force ledger — redeemLoginCode counts failed attempts off the stored
 * row — and a sweep that ran close to the TTL would erase the evidence of
 * somebody working through the code space at the moment it mattered most.
 * A day is the same margin sweepVerificationCodes uses against a comparable
 * TTL, and it is chosen for the same reason.
 */
const CODE_RETENTION_HOURS = 24

/**
 * Deletes codes nobody is going to use again. Called opportunistically, the way
 * sweepVerificationCodes is, because there is no scheduler and this table had
 * no expiry of any kind: rows accumulated for the life of the database, each
 * one a hashed credential attached to a candidate id and a channel.
 *
 * Only rows past the retention window go. A live code cannot be caught by this
 * however often it runs, which is what makes it safe on the request path.
 */
export function sweepLoginCodes() {
  const cutoff = new Date(Date.now() - CODE_RETENTION_HOURS * 60 * 60 * 1000).toISOString()
  return db.prepare(`DELETE FROM login_codes WHERE created_at < ?`).run(cutoff).changes
}

export function issueLoginCode({ candidateId, channel, code, secret }) {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000)

  // Any earlier code becomes unusable the moment a new one is requested.
  db.prepare(
    `UPDATE login_codes SET consumed_at = ? WHERE candidate_id = ? AND consumed_at IS NULL`,
  ).run(now.toISOString(), candidateId)

  db.prepare(`
    INSERT INTO login_codes (candidate_id, channel, code_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(candidateId, channel, hashLoginCode(code, secret), expiresAt.toISOString(), now.toISOString())

  return { expiresAt: expiresAt.toISOString(), expiresInMinutes: CODE_TTL_MINUTES }
}

/**
 * Returns `{ ok: true }` on success, otherwise a reason the caller can turn
 * into a message. Attempts are counted so a six-digit code cannot be brute
 * forced against a long-lived row.
 */
export function redeemLoginCode({ candidateId, code, secret }) {
  const row = db.prepare(`
    SELECT * FROM login_codes
    WHERE candidate_id = ? AND consumed_at IS NULL
    ORDER BY created_at DESC LIMIT 1
  `).get(candidateId)

  if (!row) return { ok: false, reason: 'no-code' }
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' }
  if (row.attempts >= MAX_CODE_ATTEMPTS) return { ok: false, reason: 'too-many-attempts' }

  if (row.code_hash !== hashLoginCode(code, secret)) {
    db.prepare(`UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?`).run(row.id)
    return { ok: false, reason: 'mismatch', remaining: MAX_CODE_ATTEMPTS - row.attempts - 1 }
  }

  db.prepare(`UPDATE login_codes SET consumed_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), row.id)

  return { ok: true }
}
