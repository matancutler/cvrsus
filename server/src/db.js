import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import { ADDED_COLUMNS, SCHEMA, normalizeCompanyName } from './schema.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Overridable so a throwaway database can be pointed at a scratch directory.
 * Without this there is no way to exercise the schema and its migrations from
 * empty without risking the real file.
 */
export const DATA_DIR = process.env.CKING_DATA_DIR ?? path.join(here, '..', 'data')
export const UPLOAD_DIR = process.env.CKING_UPLOAD_DIR ?? path.join(here, '..', 'uploads')

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, 'cking.db'))
db.pragma('journal_mode = WAL')

/*
 * Foreign keys, actually enforced.
 *
 * SQLite parses REFERENCES clauses and then ignores them unless this is on —
 * it is off by default, per connection, for backwards compatibility. Two dozen
 * tables here declare `ON DELETE CASCADE` and every one of them was decoration:
 * the deletes work because deleteCandidateCompletely and
 * deleteRecruiterCompletely name each table by hand, and the declarations were
 * a second, silent promise that nothing kept. With it on, a row that names a
 * parent that is not there is refused at insert time rather than discovered
 * months later as a candidate whose company does not exist.
 *
 * Turned on before any statement is prepared, so every path in the process
 * sees the same rule.
 */
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS candidates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    first_name       TEXT,
    middle_name      TEXT,
    last_name        TEXT,
    email            TEXT    NOT NULL,
    phone            TEXT,
    location         TEXT,
    years_experience REAL,
    current_title    TEXT,
    desired_role     TEXT,
    availability     TEXT,
    links            TEXT,
    notes            TEXT,
    file_name        TEXT    NOT NULL,
    stored_name      TEXT    NOT NULL,
    file_size        INTEGER,
    photo_name       TEXT,
    cv_text          TEXT,
    skills           TEXT,
    detected_years   REAL,
    created_at       TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_candidates_created ON candidates(created_at DESC);

  /* A company is the parent account. Its join_key is what lets an HR employee
     create a subsidiary account under it. */
  CREATE TABLE IF NOT EXISTS companies (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    join_key   TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  /* Subsidiary accounts: the individual recruiters inside a company.
     The username is derived from the name at signup, because the sign-up fields
     alone (name, last name, password) cannot identify a person uniquely. */
  CREATE TABLE IF NOT EXISTS recruiters (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL,
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    UNIQUE (company_id, username)
  );

  /* Folders belong to one recruiter, not to the company, so each person
     organises the shared candidate pool their own way. */
  CREATE TABLE IF NOT EXISTS folders (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    recruiter_id INTEGER NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    position     REAL NOT NULL,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS folder_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id    INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    position     REAL NOT NULL,
    added_at     TEXT NOT NULL,
    UNIQUE (folder_id, candidate_id)
  );

  /* profile_views is deliberately absent: it was replaced by the append-only
     view_events log in schema.js. Existing databases keep their copy, which the
     migration below drains. */

  /* A thread is identified by the (candidate, recruiter) pair: chat is always
     between one candidate and one named recruiter. */
  CREATE TABLE IF NOT EXISTS messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    recruiter_id INTEGER NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
    sender       TEXT NOT NULL CHECK (sender IN ('candidate', 'recruiter')),
    body         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    read_at      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_thread
    ON messages(candidate_id, recruiter_id, created_at);

  /* One thread is fast; a recruiter's whole inbox was not. Nothing led with
     recruiter_id, so "everything sent to or from this recruiter" — which the
     dock asks on every open, and every search asks again for unread counts —
     scanned the entire table. */
  CREATE INDEX IF NOT EXISTS idx_messages_recruiter
    ON messages(recruiter_id, created_at);

  /* Short-lived one-time codes for candidate sign-in. Only the hash is kept. */
  CREATE TABLE IF NOT EXISTS login_codes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    channel      TEXT NOT NULL CHECK (channel IN ('email', 'phone')),
    code_hash    TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    consumed_at  TEXT,
    created_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_login_codes_candidate ON login_codes(candidate_id, created_at DESC);

  /*
   * Settings that the schema itself depends on.
   *
   * Not general configuration — ports and secrets stay in the environment,
   * where they belong. This is for the handful of answers that get BAKED INTO
   * the database, where a second process reading a different environment would
   * not merely behave differently but would rewrite the schema to match itself.
   */
  CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`)

/**
 * Databases created before the name was split into parts are upgraded in place.
 * `name` is still the authoritative display name; the parts are additive.
 */
function ensureColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!existing.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

for (const column of ['first_name', 'middle_name', 'last_name', 'photo_name']) {
  ensureColumn('candidates', column, 'TEXT')
}

// Everything the TalentBridge brief adds on top of the original core.
db.exec(SCHEMA)

for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
  for (const [name, definition] of columns) ensureColumn(table, name, definition)
}

/*
 * reveals.recruiter_id becomes nullable, once, on databases that predate it.
 *
 * A reveal is a thing the company bought, and every reader of this table scopes
 * by company_id. The column was NOT NULL, so deleting a recruiter had to delete
 * their rows — and that silently re-masked candidates the rest of the team had
 * already been charged for. ALTER TABLE cannot drop NOT NULL in SQLite, so the
 * table is rebuilt: same columns, same key, one constraint fewer.
 *
 * Guarded by the pragma rather than a version counter, so it runs exactly once
 * however many times the process starts, and inside a transaction, so a crash
 * midway leaves the old table intact rather than half a new one.
 */
{
  const revealColumn = db.prepare(`PRAGMA table_info(reveals)`).all()
    .find((column) => column.name === 'recruiter_id')

  if (revealColumn?.notnull) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE reveals_rebuilt (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          recruiter_id   INTEGER,
          company_id     INTEGER NOT NULL,
          candidate_id   INTEGER NOT NULL,
          reveal_trigger TEXT NOT NULL DEFAULT 'document_download'
                           CHECK (reveal_trigger IN ('document_download')),
          created_at     TEXT NOT NULL,
          UNIQUE (recruiter_id, candidate_id)
        );

        INSERT INTO reveals_rebuilt
          (id, recruiter_id, company_id, candidate_id, reveal_trigger, created_at)
        SELECT id, recruiter_id, company_id, candidate_id, reveal_trigger, created_at
        FROM reveals;

        DROP TABLE reveals;
        ALTER TABLE reveals_rebuilt RENAME TO reveals;
        CREATE INDEX IF NOT EXISTS idx_reveals_company ON reveals(company_id, created_at);
      `)
    })()
  }
}

/*
 * Jobs get the company they were always meant to carry.
 *
 * The search route read `req.session.companyId`, and a session token carries
 * role, id and sid — never a company. So the read was undefined on every
 * request and every job written since the column existed has a NULL in it.
 * The recruiter is on the row and knows the answer.
 */
db.prepare(`
  UPDATE jobs
  SET company_id = (SELECT r.company_id FROM recruiters r WHERE r.id = jobs.recruiter_id)
  WHERE company_id IS NULL
`).run()

/*
 * Rows describing candidates who no longer exist.
 *
 * deleteCandidateCompletely covers every one of these tables today. It has not
 * always, and the rows left behind by the deletions that came before it were
 * still there: a thousand extracted profiles, a thousand sets of taxonomy
 * labels, six hundred experience metrics, all keyed to ids that answer nothing.
 *
 * Two things were wrong with that, and the second is the worse one.
 *
 * The retrieval stage shortlists from the derived tables rather than from
 * `candidates` — that is the point of them — so a search's pool filled up with
 * ghosts, and hydrating them produced nothing. A live JD demo could return four
 * considered and zero results, every time, with no error anywhere: the search
 * was working perfectly on people who do not exist.
 *
 * And an erasure that leaves the reading of somebody's CV behind is not an
 * erasure. `candidates` is the least descriptive table of the set; the facts,
 * the interpretation and the labels are where the person actually is.
 *
 * Runs at every start rather than once behind a flag. It is a few indexed
 * deletes at this scale, it cannot touch a row whose candidate exists, and if
 * the cascade ever springs a leak again this says so out loud instead of
 * letting a search quietly rot.
 *
 * billing_ledger is deliberately absent, exactly as it is from the cascade:
 * money moved, and the ledger is the organization's record of its own spending
 * rather than a description of a person.
 */
{
  const ORPHANED = [
    'extracted_profiles', 'extracted_facts', 'candidate_profile_intelligence',
    'candidate_taxonomy_labels', 'candidate_experience_metrics',
    'candidate_preference_tags', 'candidate_label_overrides', 'profile_overrides',
    'embeddings', 'blocked_companies', 'freshness_checkins', 'login_codes',
    'scoring_audit', 'view_events', 'reveals', 'organization_reveals',
    'candidate_job_analyses', 'displayed_match_state', 'documents',
    'messages', 'message_threads', 'conversation_hidden', 'conversation_unread',
    'folder_items', 'candidate_comments', 'candidate_tags', 'search_dismissals',
    'outreach_drafts',
  ]

  const swept = db.transaction(() => {
    let removed = 0
    for (const table of ORPHANED) {
      const exists = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      ).get(table)
      if (!exists) continue

      removed += db.prepare(`
        DELETE FROM "${table}"
        WHERE candidate_id IS NOT NULL
          AND candidate_id NOT IN (SELECT id FROM candidates)
      `).run().changes
    }

    /*
     * analytics_events, which the loop above structurally cannot reach.
     *
     * Its candidate reference is (actor_type, actor_id), not candidate_id, so
     * adding the table to the list would have swept nothing and looked like it
     * had. The actor_type test is not optional: a 'recruiter' row's actor_id is
     * a recruiter id and an 'anonymous' row's is null, and matching either
     * against the candidates table would delete rows about people who were
     * never candidates.
     *
     * candidate_account_deleted rows are left alone. They are already redacted
     * when the cascade runs, and they are the record that it did.
     */
    removed += db.prepare(`
      DELETE FROM analytics_events
      WHERE actor_type = 'candidate'
        AND actor_id IS NOT NULL
        AND name != 'candidate_account_deleted'
        AND actor_id NOT IN (SELECT id FROM candidates)
    `).run().changes

    /*
     * And the deletion records that were written before they were redacted.
     *
     * The cascade redacts this row as it erases the person, but only for
     * erasures performed since it learned to. Every earlier one still carries
     * the candidate id and a set of counts describing how much of them there
     * had been — which is a description of somebody who asked to be forgotten,
     * surviving in the one row we deliberately keep.
     *
     * The id is what makes it a record about a person rather than a record that
     * something happened, so the id is what goes. Candidate ids are
     * AUTOINCREMENT and never reused, so an actor_id matching no candidate can
     * only be somebody who was deleted.
     */
    removed += db.prepare(`
      UPDATE analytics_events SET actor_id = NULL, props = '{"redacted":true}'
      WHERE name = 'candidate_account_deleted'
        AND actor_id IS NOT NULL
        AND actor_id NOT IN (SELECT id FROM candidates)
    `).run().changes

    /*
     * The demonstration search that was interrupted trying to reveal somebody.
     *
     * Same structural blindness as analytics_events: the column is called
     * intent_candidate_id, so the loop above could not see it. Nulled rather
     * than deleted — the row is a visitor's session and the throttling record
     * the Privacy Policy discloses, and only the pointer at a person has to go.
     */
    removed += db.prepare(`
      UPDATE public_searches SET intent_candidate_id = NULL
      WHERE intent_candidate_id IS NOT NULL
        AND intent_candidate_id NOT IN (SELECT id FROM candidates)
    `).run().changes

    /*
     * And the per-search paging state, where the ids live inside JSON.
     *
     * No column to match on at all, so this one has to be read out and written
     * back. The whole table is a few hundred short rows, which is why a full
     * scan at every boot is cheaper than any way of avoiding it.
     *
     * The cursor is an index into retrieved_ids, so it moves back by however
     * many removed entries sat in front of it — otherwise a recruiter pressing
     * Show More would silently skip whoever followed the erased candidate.
     */
    const parseIds = (value) => {
      try {
        const parsed = JSON.parse(value ?? '[]')
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }

    const live = new Set(db.prepare(`SELECT id FROM candidates`).all().map((row) => row.id))
    for (const row of db.prepare(`
      SELECT id, retrieved_ids, excluded, cursor FROM retrieval_sessions
    `).all()) {
      const retrieved = parseIds(row.retrieved_ids)
      const excluded = parseIds(row.excluded)
      const keptRetrieved = retrieved.filter((id) => live.has(id))
      const keptExcluded = excluded.filter((id) => live.has(id))
      if (keptRetrieved.length === retrieved.length
        && keptExcluded.length === excluded.length) continue

      const lostAhead = retrieved.slice(0, row.cursor).filter((id) => !live.has(id)).length
      db.prepare(`
        UPDATE retrieval_sessions SET retrieved_ids = ?, excluded = ?, cursor = ?
        WHERE id = ?
      `).run(
        JSON.stringify(keptRetrieved), JSON.stringify(keptExcluded),
        Math.max(0, row.cursor - lostAhead), row.id,
      )
      removed += 1
    }

    return removed
  })()

  if (swept > 0) {
    console.log(`  Cleared ${swept} row(s) describing candidates who no longer exist.`)
  }
}

// Back-fill the normalised org name used for employer blocking.
for (const row of db.prepare(`SELECT id, name FROM companies WHERE normalized_name IS NULL`).all()) {
  db.prepare(`UPDATE companies SET normalized_name = ? WHERE id = ?`)
    .run(normalizeCompanyName(row.name), row.id)
}

/*
 * Folders became a team's rather than a person's. Every existing one takes the
 * company of whoever created it, which is the only answer that does not either
 * lose somebody's shortlist or hand it to strangers.
 *
 * A folder whose creator no longer exists gets nothing and stays unreachable —
 * deliberately. Inventing a company for an orphan row would publish one
 * recruiter's saved candidates to whichever company the guess landed on.
 */
db.prepare(`
  UPDATE folders
  SET company_id = (SELECT r.company_id FROM recruiters r WHERE r.id = folders.recruiter_id)
  WHERE company_id IS NULL
`).run()

/**
 * Spec §3.2: the company key is verified by hash. It is high-entropy and
 * server-generated, so a plain SHA-256 is the right primitive here — this is an
 * API-key comparison, not a password.
 *
 * The plaintext stays in `join_key` because §3.2 also requires an org admin to
 * be able to retrieve the key, which a hash alone cannot satisfy. That is a
 * deliberate trade: drop the column and the retrieval path becomes
 * rotate-and-show-once instead.
 */
export function hashCompanyKey(key) {
  return crypto.createHash('sha256').update(String(key ?? '').trim().toUpperCase()).digest('hex')
}

for (const row of db.prepare(
  `SELECT id, join_key, created_at FROM companies WHERE company_key_hash IS NULL`,
).all()) {
  db.prepare(`
    UPDATE companies SET company_key_hash = ?, company_key_created_at = ? WHERE id = ?
  `).run(hashCompanyKey(row.join_key), row.created_at, row.id)
}

/**
 * The documents table's slot names have changed twice: once when a single
 * "additional" slot was widened to three, and again when §7 replaced those
 * anonymous slots with named types. Both are a change to a CHECK constraint,
 * which SQLite cannot ALTER — so the table is rebuilt and its rows copied.
 *
 * `certification_1` is the marker for the current shape. Detecting it rather
 * than tracking a version number means the migration is idempotent and a
 * database at either older shape lands in the same place.
 */
const documentsSql = db.prepare(
  `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents'`,
).get()?.sql ?? ''

if (documentsSql && !documentsSql.includes('certification_1')) {
  db.transaction(() => {
    db.exec(`ALTER TABLE documents RENAME TO documents_old`)
    db.exec(SCHEMA.match(/CREATE TABLE IF NOT EXISTS documents[\s\S]*?\);/)[0])
    /*
     * Only the first extra is renamed, and only to the slot that means the same
     * thing — "additional_1" and "additional" are the same idea under two
     * names. The other two keep theirs: filing them under a named type would
     * assert what those documents are, which nobody ever told us.
     */
    db.exec(`
      INSERT INTO documents (id, candidate_id, slot, file_name, stored_name, file_size, mime_type, extracted_text, uploaded_at)
      SELECT id, candidate_id,
             CASE slot
               WHEN 'additional_1' THEN 'additional'
               WHEN 'additional' THEN 'additional'
               ELSE slot
             END,
             file_name, stored_name, file_size, mime_type, extracted_text, uploaded_at
      FROM documents_old
    `)
    db.exec(`DROP TABLE documents_old`)
  })()
}

/**
 * Spec §4.8 moves messages under an explicit thread. The platform previously
 * stored a flat message list keyed by (candidate, recruiter), which is exactly
 * one thread per pair — so every existing conversation becomes an open thread
 * and keeps its history.
 */
const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all().map((c) => c.name)

if (messageColumns.includes('thread_id')) {
  const orphaned = db.prepare(`
    SELECT m.candidate_id, m.recruiter_id, MIN(m.created_at) AS first_at, MAX(m.created_at) AS last_at
    FROM messages m WHERE m.thread_id IS NULL
    GROUP BY m.candidate_id, m.recruiter_id
  `).all()

  for (const pair of orphaned) {
    const company = db.prepare(`SELECT company_id FROM recruiters WHERE id = ?`).get(pair.recruiter_id)

    const info = db.prepare(`
      INSERT INTO message_threads (recruiter_id, company_id, candidate_id, status, created_at, last_message_at)
      VALUES (?, ?, ?, 'open', ?, ?)
    `).run(pair.recruiter_id, company?.company_id ?? 0, pair.candidate_id, pair.first_at, pair.last_at)

    db.prepare(`
      UPDATE messages SET thread_id = ? WHERE thread_id IS NULL AND candidate_id = ? AND recruiter_id = ?
    `).run(Number(info.lastInsertRowid), pair.candidate_id, pair.recruiter_id)
  }
}

/**
 * Triage stopped being sold by the session and started being sold by the CV.
 *
 * Any company that bought under the old model holds a number in
 * `triage_credits` that counts whole Triage sessions. There is no honest
 * arithmetic that turns that into a number of CVs: a session was capped at 500
 * CVs but cost the same whether you put four through it or four hundred, so
 * "one session = 500 CVs" would hand out capacity nobody paid for and
 * "one session = the average" would invent a number.
 *
 * So the conversion is a stated, deliberate grant rather than a calculation:
 * each unspent session becomes the largest pack the company could have used it
 * for, which is the only reading that cannot leave somebody worse off than the
 * thing they actually bought. It is recorded in the ledger as an adjustment
 * with its reason attached, so support can explain the number, and the old
 * column is zeroed so the grant cannot run twice.
 *
 * Idempotent by that zeroing, and a no-op on every database that never sold a
 * session — which, at the time of writing, is all of them except a developer's.
 */
const TRIAGE_SESSION_TO_CVS = Number(process.env.TRIAGE_SESSION_TO_CVS ?? 500)

const owedSessions = db.prepare(
  `SELECT id, triage_credits FROM companies WHERE triage_credits > 0`,
).all()

for (const company of owedSessions) {
  const cvs = company.triage_credits * TRIAGE_SESSION_TO_CVS
  db.transaction(() => {
    db.prepare(`
      UPDATE companies SET triage_cv_balance = triage_cv_balance + ?, triage_credits = 0
      WHERE id = ? AND triage_credits > 0
    `).run(cvs, company.id)

    db.prepare(`
      INSERT INTO billing_ledger (company_id, product, event, delta, note, created_at)
      VALUES (?, 'triage', 'adjustment', ?, ?, ?)
    `).run(
      company.id, cvs,
      `${company.triage_credits} unused Triage session(s) converted to `
      + `${cvs} CVs of processing capacity`,
      new Date().toISOString(),
    )
  })()
}

if (owedSessions.length > 0) {
  console.log(`  triage: converted session credits for ${owedSessions.length} company(ies)`)
}

/**
 * Triage is a third product, and the ledger's CHECK constraint did not know it.
 *
 * `product TEXT NOT NULL CHECK (product IN ('reveal', 'seat'))` was written when
 * there were two things to sell. SQLite cannot ALTER a CHECK, so the table is
 * rebuilt and its rows copied — the same procedure the documents slot rename
 * above uses, and for the same reason.
 *
 * Detected by reading the constraint rather than by tracking a version number,
 * which makes it idempotent and lands a database at either shape in the same
 * place. The copy is a plain INSERT ... SELECT of every column inside one
 * transaction: this table is the record behind every balance in the product, so
 * it is rebuilt whole or not at all.
 *
 * The alternative — recording Triage purchases as 'reveal' rows — was rejected
 * outright. It would corrupt the only history that can explain a balance, and
 * the corruption would be silent and permanent.
 */
const ledgerSql = db.prepare(
  `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'billing_ledger'`,
).get()?.sql ?? ''

if (ledgerSql && !ledgerSql.includes("'triage'")) {
  db.transaction(() => {
    db.exec(`ALTER TABLE billing_ledger RENAME TO billing_ledger_old`)
    db.exec(SCHEMA.match(/CREATE TABLE IF NOT EXISTS billing_ledger[\s\S]*?\);/)[0])
    db.exec(`
      INSERT INTO billing_ledger (
        id, company_id, product, event, delta, amount, currency, provider,
        provider_ref, actor_id, candidate_id, pack_key, note, created_at
      )
      SELECT id, company_id, product, event, delta, amount, currency, provider,
             provider_ref, actor_id, candidate_id, pack_key, note, created_at
      FROM billing_ledger_old
    `)
    db.exec(`DROP TABLE billing_ledger_old`)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ledger_company
        ON billing_ledger(company_id, product, created_at DESC)
    `)
  })()
}

/**
 * The pre-spec build had a `contact_reveals` table and a `profile_views`
 * counter. Spec §7 makes the download the only reveal, and §4.6 replaces the
 * counter with an append-only event log. Carry anything real across, then leave
 * the old tables in place rather than dropping them — an accidental drop of a
 * billing meter is not a recoverable mistake.
 */
const legacyTables = new Set(db.prepare(
  `SELECT name FROM sqlite_master WHERE type = 'table'`,
).all().map((row) => row.name))

if (legacyTables.has('contact_reveals')) {
  db.exec(`
    INSERT OR IGNORE INTO reveals (recruiter_id, company_id, candidate_id, reveal_trigger, created_at)
    SELECT recruiter_id, company_id, candidate_id, 'document_download', revealed_at FROM contact_reveals
  `)
}

if (legacyTables.has('profile_views')) {
  db.exec(`
    INSERT INTO view_events (candidate_id, recruiter_id, company_id, org_name, recruiter_name, event_type, created_at)
    SELECT pv.candidate_id, pv.recruiter_id, r.company_id,
           COALESCE(c.name, 'unknown'),
           TRIM(COALESCE(r.first_name, '') || ' ' || COALESCE(r.last_name, '')),
           'card_expand', pv.last_viewed_at
    FROM profile_views pv
    LEFT JOIN recruiters r ON r.id = pv.recruiter_id
    LEFT JOIN companies c ON c.id = r.company_id
    WHERE NOT EXISTS (
      SELECT 1 FROM view_events ve
      WHERE ve.candidate_id = pv.candidate_id AND ve.recruiter_id = pv.recruiter_id
    )
  `)
}

/**
 * The earliest account in each org becomes the org admin, which is the closest
 * thing to "the person who created the company" that the data records.
 *
 * The seat_limit grandfathering that used to sit here is gone with the model it
 * belonged to: capacity is now five included seats plus whatever the
 * organization bought, and wallet.js reconciles the older data at boot.
 */
db.exec(`
  UPDATE recruiters SET is_org_admin = 1
  WHERE id IN (
    SELECT MIN(id) FROM recruiters GROUP BY company_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM recruiters peer
    WHERE peer.company_id = recruiters.company_id AND peer.is_org_admin = 1
  );
`)

// Backfill the parts for rows that predate the split, so the HR panel does not
// show blanks for candidates who applied earlier.
for (const row of db.prepare(`SELECT id, name FROM candidates WHERE first_name IS NULL`).all()) {
  const parts = String(row.name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) continue

  db.prepare(`UPDATE candidates SET first_name = ?, middle_name = ?, last_name = ? WHERE id = ?`).run(
    parts[0],
    parts.length > 2 ? parts.slice(1, -1).join(' ') : null,
    parts.length > 1 ? parts.at(-1) : null,
    row.id,
  )
}

const insertStmt = db.prepare(`
  INSERT INTO candidates (
    name, first_name, middle_name, last_name, email, phone, location,
    years_experience, current_title, desired_role,
    availability, links, notes, file_name, stored_name, file_size, photo_name,
    cv_text, skills, detected_years, created_at, email_key, phone_key
  ) VALUES (
    @name, @first_name, @middle_name, @last_name, @email, @phone, @location,
    @years_experience, @current_title, @desired_role,
    @availability, @links, @notes, @file_name, @stored_name, @file_size, @photo_name,
    @cv_text, @skills, @detected_years, @created_at, @email_key, @phone_key
  )
`)

/**
 * The canonical keys for whatever contact details a write carries.
 *
 * One function, used by the insert and the update, so the two cannot drift.
 * Only ever derives a key for a field actually being written: an update that
 * touches nobody's email must not blank the key and quietly free the address
 * for somebody else to take.
 */
function contactKeys(fields) {
  const keys = {}
  if ('email' in fields) keys.email_key = fields.email ? emailKey(fields.email) : null
  if ('phone' in fields) keys.phone_key = fields.phone ? phoneKey(fields.phone) : null
  return keys
}

/** Columns every read returns except cv_text, which is large and rarely needed in lists. */
const LIST_COLUMNS = `
  id, name, first_name, middle_name, last_name, email, phone, location,
  years_experience, current_title, desired_role,
  availability, links, notes, file_name, stored_name, file_size, photo_name, skills,
  detected_years, created_at
`

const selectAllStmt = db.prepare(`SELECT ${LIST_COLUMNS} FROM candidates ORDER BY created_at DESC`)
const selectOneStmt = db.prepare(`SELECT * FROM candidates WHERE id = ?`)
const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM candidates`)

/** Rows are stored with JSON in `skills` and `links`; hydrate them for callers. */
function hydrate(row) {
  if (!row) return null
  return {
    ...row,
    skills: safeParse(row.skills, []),
    links: safeParse(row.links, []),
  }
}

function safeParse(value, fallback) {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

export function insertCandidate(record) {
  const info = insertStmt.run({
    ...record,
    links: JSON.stringify(record.links ?? []),
    skills: JSON.stringify(record.skills ?? []),
    /* Always both, because this is an INSERT and every named parameter has to
       be bound — contactKeys omits a field the caller did not mention, which
       is right for an UPDATE and wrong here. */
    email_key: record.email ? emailKey(record.email) : null,
    phone_key: record.phone ? phoneKey(record.phone) : null,
  })
  return Number(info.lastInsertRowid)
}

export function listCandidates() {
  return selectAllStmt.all().map(hydrate)
}

/** Includes cv_text — used by the matcher and the single-candidate view. */
export function getCandidate(id) {
  return hydrate(selectOneStmt.get(id))
}

/*
 * Every column except the CV text, read from the table rather than listed here.
 *
 * A hand-written list is a maintenance trap: LIST_COLUMNS above already omits
 * five columns the recruiter-facing view reads — hidden_from_search,
 * last_confirmed_active, last_seen_at, missed_checkins, open_to_relocation —
 * so a card built from it would quietly report everyone as inactive and nobody
 * as open to relocating. Asking the schema means a column added next month is
 * included without anybody remembering to come back here.
 */
const CARD_COLUMNS = db.prepare(`PRAGMA table_info(candidates)`).all()
  .map((column) => column.name)
  .filter((name) => name !== 'cv_text')
  .join(', ')

/**
 * The people behind a page of search results, in one query.
 *
 * Was a getCandidate() per row inside a .map — twenty-five round trips per
 * search response, each pulling the whole candidate row including cv_text,
 * which is the one genuinely large column and the one nothing on a result card
 * reads. A page of results was carrying a megabyte of CV prose out of SQLite to
 * render a name, a score and a location.
 *
 * Returns a Map so the caller keeps its own ordering — the ranking is the
 * point, and IN (...) does not preserve it.
 */
export function candidatesByIds(ids) {
  const wanted = [...new Set(ids)].filter((id) => Number.isInteger(id))
  if (!wanted.length) return new Map()

  const rows = db.prepare(
    `SELECT ${CARD_COLUMNS} FROM candidates WHERE id IN (${wanted.map(() => '?').join(', ')})`,
  ).all(...wanted)

  return new Map(rows.map((row) => [row.id, hydrate(row)]))
}

/*
 * There is deliberately no `deleteCandidate` here.
 *
 * There was: a bare DELETE from this one table. It left the person's documents,
 * extracted facts, taxonomy labels, cached job analyses and uploaded files
 * behind — everything that actually describes them — while removing the row
 * that made them findable. Both delete routes now call
 * `deleteCandidateCompletely` in profiles.js, which covers every table.
 *
 * Removed rather than kept for the one caller that wanted it, because the
 * shallow spelling being available is how it came to be used at all.
 */

export function countCandidates() {
  return countStmt.get().n
}

/** Every upload filename the database still points at. */
/**
 * Every filename any row in the database points at.
 *
 * This is the whitelist the startup sweep deletes against, so a table left out
 * of it is a table whose files are destroyed on the next restart — silently,
 * and with no way back. It knew about candidates only, and three owners were
 * already missing:
 *
 *   documents        a candidate's cover letter, portfolio and references
 *   recruiters       a recruiter's own photograph
 *   companies        the company logo
 *
 * The first of those was not hypothetical. A database with three document rows
 * had one file left on disk; the other two had been swept, months of restarts
 * ago, from under rows that still name them.
 *
 * ANY new table that stores an upload belongs here. The sweep's own comment
 * says so, and this is the list it means.
 */
export function referencedUploadNames() {
  const names = new Set()

  const add = (rows) => {
    for (const row of rows) {
      for (const value of Object.values(row)) if (value) names.add(value)
    }
  }

  add(db.prepare(`SELECT stored_name, photo_name FROM candidates`).all())
  add(db.prepare(`SELECT stored_name FROM documents`).all())
  add(db.prepare(`SELECT photo_name FROM recruiters`).all())
  add(db.prepare(`SELECT logo_name FROM companies`).all())

  return names
}

/** The matcher needs cv_text for every candidate, so it gets its own query. */
export function listCandidatesWithText() {
  return db.prepare(`SELECT * FROM candidates ORDER BY created_at DESC`).all().map(hydrate)
}

/**
 * Writes are filtered against this list, so a stray key in a request body can
 * never reach a column. Anything the candidate may change has to be named here.
 */
const UPDATABLE_COLUMNS = new Set([
  'name', 'first_name', 'middle_name', 'last_name', 'email', 'phone', 'location',
  'availability', 'notes', 'photo_name',
  'file_name', 'stored_name', 'file_size', 'cv_text', 'skills', 'detected_years',
  // Spec §4.1 intake fields.
  'open_to_relocation', 'preferred_regions', 'capacity', 'notice_period',
  // Consent, identity and freshness.
  'consent_at', 'consent_version', 'phone_verified', 'phone_verified_at', 'auth_provider',
  'last_confirmed_active', 'missed_checkins', 'hidden_from_search', 'profile_completion',
])

/** Partial update from the candidate's own account page. */
export function updateCandidate(id, fields) {
  const entries = Object.entries(fields).filter(([column]) => UPDATABLE_COLUMNS.has(column))
  if (entries.length === 0) return false

  /* Derived here rather than by the caller. Every route, script and repair that
     changes an address goes through this function, so this is the one place
     that can guarantee the key moves with it. */
  const derived = Object.entries(contactKeys(Object.fromEntries(entries)))
  const all = [...entries, ...derived]

  const assignments = all.map(([column]) => `${column} = @${column}`).join(', ')
  const payload = Object.fromEntries(
    all.map(([column, value]) => [column, column === 'skills' ? JSON.stringify(value ?? []) : value]),
  )

  return db.prepare(`UPDATE candidates SET ${assignments} WHERE id = @id`)
    .run({ ...payload, id }).changes > 0
}

/** Compares the last 9 digits so "+972 54 987 6543" matches "054-987-6543". */
/**
 * The last nine digits, which is what makes "050-123-4567", "0501234567" and
 * "+972 50 123 4567" the same number. Exported because sign-up verification has
 * to agree with sign-in about when two spellings are one phone.
 */
export function phoneKey(value) {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length >= 9 ? digits.slice(-9) : null
}

/**
 * Resolves the email address or phone number a candidate typed on the sign-in
 * screen back to their record.
 */
/*
 * Providers where a dot and a +tag are the same mailbox.
 *
 * Only these. Everywhere else a dot in the local part is significant, and
 * treating "j.smith@" as "jsmith@" would hand one person another person's
 * account — so the rule is applied where it is a documented fact about the
 * provider and nowhere else.
 */
const ALIASING_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

/**
 * The one mailbox an address refers to.
 *
 * "Dana.Levi+jobs@gmail.com" and "danalevi@gmail.com" are the same inbox, and
 * somebody who signs up with one and later types the other means the same
 * account. Without this they were told no application existed and offered the
 * chance to create a second one.
 *
 * Exported because the duplicate guard on sign-up has to agree with the lookup
 * here: if these two disagreed, an address could fail to sign in AND be allowed
 * to register again, which is the pair of behaviours that made a lost profile.
 */
/** Whether this address is at a provider where dots and +tags are aliases. */
function aliasable(value) {
  const at = String(value ?? '').lastIndexOf('@')
  return at > 0 && ALIASING_DOMAINS.has(String(value).slice(at + 1).trim().toLowerCase())
}

/*
 * Contacts that may appear on more than one candidate.
 *
 * For the operator's own address and number, so that signing up can be walked
 * through repeatedly without deleting the account each time — the codes go to a
 * real inbox and a real handset, which is the whole point of testing with them.
 *
 * From the environment rather than from source: this repository is published,
 * and a personal email address hard-coded into it would be published with it.
 * Set DUPLICATE_EXEMPT_CONTACTS to a comma-separated list of addresses and
 * numbers; leave it unset and nothing is exempt, which is the right default for
 * anybody else running this.
 *
 * Note what an exemption costs, because it is not free: findCandidateByContact
 * resolves an address to the NEWEST row, so signing in with an exempt address
 * reaches the most recent of the duplicates and the earlier ones become
 * unreachable from the sign-in page. That is fine for throwaway test accounts
 * and would not be fine for anybody real, which is why this is a named list
 * rather than a switch that turns the rule off.
 */
const EXEMPT_SETTING = 'duplicate_exempt_contacts'

const parseContacts = (text) => String(text ?? '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)

/*
 * Kept in the database, seeded from the environment.
 *
 * It used to be read from the environment alone, and that was wrong in a way
 * that took a real signup failure to see. The list is baked into a partial
 * UNIQUE index, so whichever process last imported this file decides what the
 * index says — and the test suites import it too, from a working directory
 * with no .env. Every test run therefore rebuilt the index with an empty list,
 * silently un-exempting the operator's own address on the SERVER that was
 * still running, until somebody restarted it. The server went on allowing the
 * signup and the index went on refusing it.
 *
 * So the environment is a way to SET the list, not the list itself: when
 * DUPLICATE_EXEMPT_CONTACTS is defined it is written down and becomes the
 * answer, and when it is absent the stored answer stands. A process with no
 * opinion now inherits one instead of imposing emptiness.
 */
let EXEMPT = (() => {
  const stored = db.prepare(`SELECT value FROM app_settings WHERE key = ?`)
    .get(EXEMPT_SETTING)?.value

  const declared = process.env.DUPLICATE_EXEMPT_CONTACTS
  if (declared === undefined) return parseContacts(stored)

  if (declared !== stored) {
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(EXEMPT_SETTING, declared, new Date().toISOString())
  }
  return parseContacts(declared)
})()

export function emailKey(value) {
  const text = String(value ?? '').trim().toLowerCase()
  const at = text.lastIndexOf('@')
  if (at < 1) return text

  const local = text.slice(0, at)
  const domain = text.slice(at + 1)
  if (!ALIASING_DOMAINS.has(domain)) return text

  return `${local.split('+')[0].replace(/\./g, '')}@${domain}`
}

/* The exemptions, in the same shape as the columns they are compared against. */
let exemptEmailKeys = []
let exemptPhoneKeys = []

const deriveExemptKeys = () => {
  exemptEmailKeys = [...new Set(EXEMPT.filter((e) => e.includes('@')).map(emailKey))]
  exemptPhoneKeys = [...new Set(EXEMPT.map(phoneKey).filter(Boolean))]
}

deriveExemptKeys()

/** The contacts currently allowed to appear more than once, as written. */
export function exemptContacts() {
  return [...EXEMPT]
}

/**
 * Change the list, persist it, and rebuild the indexes to match — one call, so
 * the three can never drift apart.
 *
 * Exported for the test suite, which has to borrow the list and give it back;
 * doing that through the environment is what broke it before, because the
 * environment is read once at import and the index is rewritten every time.
 */
export function setExemptContacts(contacts) {
  const list = Array.isArray(contacts) ? contacts.map((c) => String(c).trim()).filter(Boolean)
    : parseContacts(contacts)

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(EXEMPT_SETTING, list.join(','), new Date().toISOString())

  EXEMPT = list
  deriveExemptKeys()
  ensureContactIndexes()
  return [...EXEMPT]
}

/** Whether this address or number is allowed to appear on more than one row. */
export function contactIsExempt(value) {
  const text = String(value ?? '').trim()
  if (!text) return false
  return text.includes('@')
    ? exemptEmailKeys.includes(emailKey(text))
    : exemptPhoneKeys.includes(phoneKey(text))
}

/*
 * One mailbox, one number, one account — made true, then kept true.
 *
 * Runs at boot, before anything can write. Two steps, in this order:
 *
 *   1. derive email_key/phone_key for rows that predate the columns, and for
 *      any row a repair touched without going through updateCandidate;
 *   2. put a UNIQUE index on each, which is what actually stops a second
 *      account taking a contact detail the first one holds.
 *
 * Step 2 can fail, and the failure is the point. SQLite refuses to build a
 * unique index over data that already violates it, so a database with two
 * accounts on one mailbox will not get the constraint — and this says so
 * loudly with the ids rather than carrying on and letting everyone believe
 * duplicates are impossible. Resolving those is a decision about whose CV and
 * whose paid-for reveals survive, which is not a decision a migration should
 * make on its own.
 *
 * Both indexes are partial. A candidate with no phone number is normal, and
 * NULLs are distinct in SQLite anyway; the WHERE clause makes that explicit and
 * keeps the index off rows it says nothing about.
 */
{
  const backfilled = db.transaction(() => {
    let touched = 0
    const rows = db.prepare(`
      SELECT id, email, phone FROM candidates
      WHERE (email IS NOT NULL AND email_key IS NULL)
         OR (phone IS NOT NULL AND phone_key IS NULL)
    `).all()

    for (const row of rows) {
      db.prepare(`UPDATE candidates SET email_key = ?, phone_key = ? WHERE id = ?`).run(
        row.email ? emailKey(row.email) : null,
        row.phone ? phoneKey(row.phone) : null,
        row.id,
      )
      touched += 1
    }
    return touched
  })()

  if (backfilled > 0) console.log(`  keyed ${backfilled} candidate contact detail(s)`)

  /*
   * The index carries the exemption, rather than the application checking for
   * it separately.
   *
   * A partial index is the honest way to say "unique, except for these": the
   * guarantee stays in the database, where nothing can route around it, and the
   * exception is visible in the schema instead of living in whichever code path
   * happened to remember. It is rebuilt when the list changes, because SQLite
   * keeps the WHERE clause as written and an out-of-date one would silently go
   * on enforcing yesterday's answer.
   */
  ensureContactIndexes()
}

/**
 * Write the two unique indexes so they say what the exemption list says.
 *
 * Idempotent, and the only correct way to build these: an index recreated by
 * hand anywhere else states whatever that caller happened to believe. The
 * first version of the test suite did exactly that in its cleanup — rebuilt
 * them as plain unique indexes, which is not "as I found them" but "with no
 * exemptions at all".
 */
export function ensureContactIndexes() {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`

  for (const [what, column, exempt] of [
    ['mailbox', 'email_key', exemptEmailKeys],
    ['phone number', 'phone_key', exemptPhoneKeys],
  ]) {
    const name = `idx_candidates_${column}`
    const where = exempt.length
      ? `${column} IS NOT NULL AND ${column} NOT IN (${exempt.map(quote).join(', ')})`
      : `${column} IS NOT NULL`
    const wanted = `CREATE UNIQUE INDEX ${name} ON candidates(${column}) WHERE ${where}`

    const existing = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`,
    ).get(name)?.sql

    if (existing === wanted) continue
    if (existing) db.exec(`DROP INDEX ${name}`)

    try {
      db.exec(wanted)
    } catch (error) {
      const clashes = db.prepare(`
        SELECT ${column} AS key, GROUP_CONCAT(id) AS ids
        FROM candidates WHERE ${column} IS NOT NULL
        GROUP BY ${column} HAVING COUNT(*) > 1
      `).all()

      console.warn(`  WARNING: cannot enforce one account per ${what} — `
        + `${clashes.length} already shared. Nothing prevents more until these are resolved:`)
      for (const clash of clashes) console.warn(`    ${clash.key} → candidate ids ${clash.ids}`)
      console.warn(`    (${error.message})`)
    }
  }
}

export function findCandidateByContact(identifier) {
  const value = String(identifier ?? '').trim()
  if (!value) return null

  const byEmail = db.prepare(
    `SELECT * FROM candidates WHERE lower(email) = lower(?) ORDER BY created_at DESC LIMIT 1`,
  ).get(value)
  if (byEmail) return hydrate(byEmail)

  /*
   * Then the same mailbox spelled differently.
   *
   * The test is the DOMAIN, not whether the typed address happens to contain a
   * dot. Gating on "does this differ from its own key" only caught the case
   * where the typed form was the dotted one — somebody who registered
   * "dana.cutler@gmail.com" and later typed "danacutler@gmail.com" got no
   * match, and could then register a second account on the same mailbox, which
   * is the whole thing this is here to stop.
   */
  const wantedEmail = emailKey(value)
  if (aliasable(value)) {
    const aliased = db.prepare(
      `SELECT id, email FROM candidates WHERE email IS NOT NULL ORDER BY created_at DESC`,
    ).all().find((row) => emailKey(row.email) === wantedEmail)

    if (aliased) return getCandidate(aliased.id)
  }

  const wanted = phoneKey(value)
  if (!wanted) return null

  /*
   * Two columns, then one row.
   *
   * The comparison has to happen in JS — the last nine digits of a number
   * spelled five different ways is not something SQL can index — but it only
   * needs the phone and the id to do it. This used to be `SELECT *`, so every
   * sign-in by phone loaded every candidate on the platform with their entire
   * CV text attached, to find one row and throw the rest away.
   */
  const match = db.prepare(
    `SELECT id, phone FROM candidates WHERE phone IS NOT NULL ORDER BY created_at DESC`,
  ).all().find((row) => phoneKey(row.phone) === wanted)

  return match ? getCandidate(match.id) : null
}

/**
 * Deletes enquiries older than the retention period.
 *
 * Called opportunistically from the contact route, the way the signup-code
 * sweep is: it keeps a write-only table from growing without bound and needs no
 * scheduler.
 *
 * Two years, because an enquiry is a person's name, email address and whatever
 * they chose to tell us, kept for a business purpose that ends when the
 * conversation does. This table had no expiry at all and no reader either, so
 * the practical retention period was "for as long as the product exists".
 */
export const CONTACT_RETENTION_DAYS = 730

export function sweepContactMessages() {
  const cutoff = new Date(Date.now() - CONTACT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  return db.prepare(`DELETE FROM contact_messages WHERE created_at < ?`).run(cutoff).changes
}

/** An enquiry from the public contact page. */
export function insertContactMessage({ name, email, reason = null, message }) {
  return db.prepare(`
    INSERT INTO contact_messages (name, email, reason, message, created_at) VALUES (?, ?, ?, ?, ?)
  `).run(name, email, reason, message, new Date().toISOString()).lastInsertRowid
}

export default db

/**
 * Accounts that share one identity, for an operator to look at.
 *
 * Reports, never merges. Two candidate rows on one mailbox each have a CV, a
 * message history, reveals somebody paid for and notes a recruiter wrote — and
 * merging them means choosing which of each survives. That is a decision with
 * an owner, and it is not this function.
 *
 * The guards on the apply and edit routes mean no new pair can form. This
 * exists for rows that predate them, and for the case where an operator has
 * imported or restored data: a silent duplicate is the failure that hides until
 * somebody's profile has "gone missing".
 *
 * Grouped by the same keys the lookups use, so what it reports is exactly what
 * would collide at sign-in rather than a looser or stricter idea of sameness.
 */
export function duplicateIdentities() {
  const rows = db.prepare(`SELECT id, email, phone FROM candidates`).all()

  const group = (key) => {
    const seen = new Map()
    for (const row of rows) {
      const value = key(row)
      if (!value) continue
      if (!seen.has(value)) seen.set(value, [])
      seen.get(value).push(row.id)
    }
    return [...seen].filter(([, ids]) => ids.length > 1).map(([value, ids]) => ({ value, ids }))
  }

  return {
    byEmail: group((row) => emailKey(row.email)),
    byPhone: group((row) => phoneKey(row.phone)),
  }
}
