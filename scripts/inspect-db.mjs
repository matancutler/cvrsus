/**
 * Prints what is in the database. Read-only.
 *
 *   npm run db            # summary of every table
 *   npm run db accounts   # companies and recruiters in detail
 *   npm run db billing    # seat limits and seat purchases
 *   npm run db candidates
 *   npm run db messages
 *   npm run db views
 *   npm run db folders
 *
 * Password hashes and sign-in codes are stored hashed and are shown redacted —
 * there is no plaintext credential in here to read.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const here = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(here, '..', 'server', 'data', 'cking.db')

const db = new Database(file, { readonly: true, fileMustExist: true })

const section = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`)
const rows = (list) => (list.length ? console.table(list) : console.log('  (none)'))

const what = (process.argv[2] ?? 'summary').toLowerCase()

if (what === 'summary') {
  section('Tables')
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all()

  rows(tables.map(({ name }) => ({
    table: name,
    rows: db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n,
  })))

  console.log(`\n  ${file}`)
  console.log('  Pass a name for detail, e.g. npm run db accounts\n')
}

if (what === 'accounts' || what === 'summary') {
  section('Companies')
  rows(db.prepare(`
    SELECT id, name, join_key, seat_limit,
           (SELECT COUNT(*) FROM recruiters r WHERE r.company_id = companies.id) AS seats_used,
           created_at
    FROM companies ORDER BY id
  `).all())

  section('Recruiters')
  // LEFT JOIN so a recruiter whose company row is missing still appears —
  // an inner join would hide exactly the rows worth investigating.
  rows(db.prepare(`
    SELECT r.id,
           COALESCE(c.name, '(no company)')     AS company,
           COALESCE(c.join_key, '—')            AS company_key,
           r.first_name, r.last_name, r.username,
           /* What sign-up asks for, and what an administrator can fill in
              afterwards. An em dash rather than an empty cell, so "we hold
              nothing" is told apart from a column that failed to print —
              accounts created from the Team tab may legitimately have none. */
           COALESCE(NULLIF(r.email, ''), '—')   AS email,
           COALESCE(NULLIF(r.phone, ''), '—')   AS phone,
           COALESCE(NULLIF(r.website, ''), '—') AS website,
           CASE WHEN r.is_org_admin = 1 THEN 'yes' ELSE '' END AS admin,
           substr(r.password_hash, 1, 7) || '…(hashed)' AS password,
           r.created_at
    FROM recruiters r LEFT JOIN companies c ON c.id = r.company_id
    ORDER BY r.company_id, r.id
  `).all())
}

if (what === 'billing') {
  section('Seats')
  rows(db.prepare(`
    SELECT id, name, seat_limit,
           (SELECT COUNT(*) FROM recruiters r WHERE r.company_id = companies.id) AS seats_used
    FROM companies ORDER BY id
  `).all())

  section('Seat purchases')
  rows(db.prepare(`
    SELECT p.id, c.name AS company, p.seat_number,
           printf('%.2f', p.unit_amount / 100.0) AS amount, p.currency, p.interval,
           p.status, p.provider, p.provider_ref,
           COALESCE(r.username, '—') AS purchased_by, p.created_at
    FROM seat_purchases p
    LEFT JOIN companies c ON c.id = p.company_id
    LEFT JOIN recruiters r ON r.id = p.purchased_by
    ORDER BY p.id
  `).all())
}

if (what === 'candidates') {
  section('Candidates')
  rows(db.prepare(`
    SELECT id, name, email, phone, location, availability, capacity,
           file_name, CASE WHEN photo_name IS NULL THEN '' ELSE 'yes' END AS photo, created_at
    FROM candidates ORDER BY id
  `).all())
}

if (what === 'folders') {
  section('Folders')
  rows(db.prepare(`
    SELECT f.id, f.name, r.username AS owner,
           (SELECT COUNT(*) FROM folder_items fi WHERE fi.folder_id = f.id) AS items
    FROM folders f JOIN recruiters r ON r.id = f.recruiter_id ORDER BY f.id
  `).all())

  section('Folder contents')
  rows(db.prepare(`
    SELECT f.name AS folder, c.name AS candidate, r.username AS owner
    FROM folder_items fi
    JOIN folders f ON f.id = fi.folder_id
    JOIN candidates c ON c.id = fi.candidate_id
    JOIN recruiters r ON r.id = f.recruiter_id
    ORDER BY f.id, fi.position
  `).all())
}

if (what === 'views') {
  section('Profile views (one row per candidate + recruiter pair)')
  rows(db.prepare(`
    SELECT c.name AS candidate, r.username AS recruiter, co.name AS company,
           pv.view_count AS opens, pv.last_viewed_at
    FROM profile_views pv
    JOIN candidates c ON c.id = pv.candidate_id
    JOIN recruiters r ON r.id = pv.recruiter_id
    JOIN companies co ON co.id = r.company_id
    ORDER BY pv.last_viewed_at DESC
  `).all())
}

if (what === 'messages') {
  section('Messages')
  rows(db.prepare(`
    SELECT m.id, c.name AS candidate, r.username AS recruiter, m.sender,
           substr(m.body, 1, 60) AS body,
           CASE WHEN m.read_at IS NULL THEN 'unread' ELSE 'read' END AS state,
           m.created_at
    FROM messages m
    JOIN candidates c ON c.id = m.candidate_id
    JOIN recruiters r ON r.id = m.recruiter_id
    ORDER BY m.created_at
  `).all())
}

if (what === 'codes') {
  section('Sign-in codes (hashed — the code itself is not recoverable)')
  rows(db.prepare(`
    SELECT lc.id, c.email, lc.channel, lc.attempts,
           CASE WHEN lc.consumed_at IS NULL THEN 'open' ELSE 'used' END AS state,
           lc.expires_at
    FROM login_codes lc JOIN candidates c ON c.id = lc.candidate_id
    ORDER BY lc.created_at DESC LIMIT 20
  `).all())
}

db.close()
