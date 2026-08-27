#!/usr/bin/env node
/**
 * Recruiter maintenance from the command line.
 *
 *   node server/scripts/recruiters.mjs list [company]
 *   node server/scripts/recruiters.mjs show <id|username>
 *   node server/scripts/recruiters.mjs add <company> "First Last" [--password "..."] [--admin]
 *   node server/scripts/recruiters.mjs set <id|username> [--first X] [--last Y] [--admin true|false]
 *   node server/scripts/recruiters.mjs password <id|username> [--password "..."]
 *   node server/scripts/recruiters.mjs delete <id|username> [--yes]
 *
 * Passwords can be SET but never READ. They are stored as salted scrypt hashes,
 * which are one-way by design: there is no query that returns somebody's
 * password, and adding one would mean storing them reversibly so that anyone
 * with a copy of the database file — or an old backup — would have every
 * password, on a platform where people reuse them.
 */
import {
  createRecruiter, deleteRecruiterCompletely, defaultPasswordFor,
  recruiterDeletionPreview, setRecruiterPassword, updateRecruiter,
} from '../src/accounts.js'
import db from '../src/db.js'

const [command, ...rest] = process.argv.slice(2)
const flags = new Map()
const args = []

for (let i = 0; i < rest.length; i += 1) {
  if (rest[i].startsWith('--')) {
    const key = rest[i].slice(2)
    const next = rest[i + 1]
    if (next && !next.startsWith('--')) { flags.set(key, next); i += 1 } else flags.set(key, true)
  } else args.push(rest[i])
}

const fail = (message) => { console.error(`\n  ${message}\n`); process.exit(1) }

function resolveCompany(token) {
  if (!token) fail('Which company? Pass an id or an exact name.')
  const byId = /^\d+$/.test(token)
    ? db.prepare(`SELECT * FROM companies WHERE id = ?`).get(Number(token))
    : null
  if (byId) return byId

  const matches = db.prepare(`SELECT * FROM companies WHERE name = ? COLLATE NOCASE`).all(token)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) fail(`"${token}" matches ${matches.length} companies. Use the id.`)
  return fail(`No company matches "${token}".`)
}

/** Username is unique per company, so a bare username may be ambiguous. */
function resolveRecruiter(token) {
  if (!token) fail('Which recruiter? Pass an id or a username.')

  const byId = /^\d+$/.test(token)
    ? db.prepare(`SELECT * FROM recruiters WHERE id = ?`).get(Number(token))
    : null
  if (byId) return byId

  const matches = db.prepare(`SELECT * FROM recruiters WHERE username = ? COLLATE NOCASE`).all(token)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    fail(`"${token}" exists at ${matches.length} companies (ids ${matches.map((r) => r.id).join(', ')}). Use the id.`)
  }
  return fail(`No recruiter matches "${token}". Run "list" to see them.`)
}

const companyName = (id) => db.prepare(`SELECT name FROM companies WHERE id = ?`).get(id)?.name ?? '(no company)'

// ------------------------------------------------------------------ list ---

if (command === 'list' || command === undefined) {
  const company = args[0] ? resolveCompany(args[0]) : null
  const rows = company
    ? db.prepare(`SELECT * FROM recruiters WHERE company_id = ? ORDER BY id`).all(company.id)
    : db.prepare(`SELECT * FROM recruiters ORDER BY company_id, id`).all()

  if (rows.length === 0) console.log('\n  No recruiters.\n')
  else {
    console.log('')
    console.log('  id    username              name                  company')
    console.log('  ----  --------------------  --------------------  -------')
    for (const row of rows) {
      console.log(
        `  ${String(row.id).padEnd(4)}  ${row.username.padEnd(20)}  `
        + `${`${row.first_name} ${row.last_name}`.padEnd(20)}  `
        + `${companyName(row.company_id)}${row.is_org_admin ? '  [admin]' : ''}`,
      )
    }
    console.log('')
  }
}

// ------------------------------------------------------------------ show ---

else if (command === 'show') {
  const person = resolveRecruiter(args[0])
  const preview = recruiterDeletionPreview(person.id)

  console.log(`\n  ${person.first_name} ${person.last_name}  (id ${person.id})`)
  console.log(`  username : ${person.username}`)
  console.log(`  company  : ${companyName(person.company_id)} (id ${person.company_id})`)
  console.log(`  admin    : ${person.is_org_admin ? 'yes' : 'no'}`)
  console.log(`  created  : ${person.created_at}`)
  console.log(`  password : (stored as a one-way hash — cannot be shown)`)
  console.log(`\n  attached: ${JSON.stringify(preview)}\n`)
}

// ------------------------------------------------------------------- add ---

else if (command === 'add') {
  const company = resolveCompany(args[0])
  const name = args[1]
  if (!name) fail(`Who? add ${company.id} "Maya Cohen"`)

  const [firstName, ...restName] = String(name).trim().split(/\s+/)
  const lastName = restName.join(' ')
  if (!lastName) fail(`Give a first and last name; got "${name}".`)

  const password = flags.get('password') === true ? null : flags.get('password')
  if (password && String(password).length < 8) fail('A password must be at least 8 characters.')

  /*
   * The seat limit is checked here as well as in the app. This script bypasses
   * the HTTP layer, so without it a company could quietly end up with more
   * accounts than it pays for and nothing would ever notice.
   */
  const used = db.prepare(`SELECT COUNT(*) AS n FROM recruiters WHERE company_id = ?`).get(company.id).n
  const limit = company.seat_limit ?? 1
  if (used >= limit && flags.get('over-seat-limit') !== true) {
    fail(`${company.name} uses ${used} of ${limit} seat(s).\n`
      + '  Buy a seat in the app, or pass --over-seat-limit to override deliberately.')
  }

  const recruiter = await createRecruiter({
    companyId: company.id, firstName, lastName,
    password: password ?? undefined,
    isOrgAdmin: flags.get('admin') === true,
  })

  console.log(`\n  Added ${firstName} ${lastName} to ${company.name}`)
  console.log(`  username    : ${recruiter.username}`)
  console.log(`  password    : ${recruiter.initialPassword}`)
  console.log(`  company key : ${company.join_key}`)
  console.log(`  admin       : ${recruiter.isOrgAdmin ? 'yes' : 'no'}\n`)
}

// ------------------------------------------------------------------- set ---

else if (command === 'set') {
  const person = resolveRecruiter(args[0])
  const changes = []

  const first = flags.get('first')
  const last = flags.get('last')
  if (first === true || last === true) fail('--first and --last need a value.')

  if (first || last) {
    updateRecruiter(person.id, {
      firstName: first ?? person.first_name,
      lastName: last ?? person.last_name,
      photoName: person.photo_name,
    })
    changes.push(`name -> ${first ?? person.first_name} ${last ?? person.last_name}`)
  }

  const admin = flags.get('admin')
  if (admin !== undefined) {
    const makeAdmin = admin === true || admin === 'true'
    /*
     * A company with no administrator cannot manage its own team, and nothing
     * in the app can restore one — so removing the last admin is refused here
     * rather than discovered later.
     */
    if (!makeAdmin && person.is_org_admin) {
      const others = db.prepare(
        `SELECT COUNT(*) AS n FROM recruiters WHERE company_id = ? AND is_org_admin = 1 AND id != ?`,
      ).get(person.company_id, person.id).n
      if (others === 0) fail(`${person.username} is the only administrator at ${companyName(person.company_id)}.\n`
        + '  Promote somebody else first, or the company loses control of its own team.')
    }
    db.prepare(`UPDATE recruiters SET is_org_admin = ? WHERE id = ?`).run(makeAdmin ? 1 : 0, person.id)
    changes.push(`admin -> ${makeAdmin ? 'yes' : 'no'}`)
  }

  if (changes.length === 0) fail('Nothing to change. Try --first, --last or --admin true|false.')

  // Re-read rather than echoing what we asked for, so the output is what the
  // database actually holds.
  const after = db.prepare(`SELECT * FROM recruiters WHERE id = ?`).get(person.id)
  console.log(`\n  ${person.username}: ${changes.join(', ')}`)
  console.log(`  now: ${after.first_name} ${after.last_name}, admin ${after.is_org_admin ? 'yes' : 'no'}\n`)
}

// -------------------------------------------------------------- password ---

else if (command === 'password') {
  const person = resolveRecruiter(args[0])
  const supplied = flags.get('password') === true ? null : flags.get('password')

  if (supplied && String(supplied).length < 8) fail('A password must be at least 8 characters.')

  const next = supplied ?? defaultPasswordFor(person.username)
  await setRecruiterPassword(person.id, next)

  console.log(`\n  ${person.username}'s password is now: ${next}`)
  console.log('  Tell them out of band, and have them change it.\n')
}

// ---------------------------------------------------------------- delete ---

else if (command === 'delete') {
  const person = resolveRecruiter(args[0])
  const preview = recruiterDeletionPreview(person.id)
  const confirmed = flags.get('yes') === true

  if (person.is_org_admin) {
    const others = db.prepare(
      `SELECT COUNT(*) AS n FROM recruiters WHERE company_id = ? AND is_org_admin = 1 AND id != ?`,
    ).get(person.company_id, person.id).n
    if (others === 0 && flags.get('orphan-company') !== true) {
      fail(`${person.username} is the only administrator at ${companyName(person.company_id)}.\n`
        + '  Deleting them leaves the company with nobody who can manage it.\n'
        + '  Promote somebody else first, or pass --orphan-company if that is what you want.')
    }
  }

  console.log(`\n  ${confirmed ? 'Deleting' : 'Would delete'} ${person.first_name} ${person.last_name}`
    + ` (${person.username}) at ${companyName(person.company_id)}:`)
  console.log(`    ${JSON.stringify(preview)}`)
  console.log('\n  Candidates they messaged are NOT deleted; the conversations are.')

  if (!confirmed) {
    console.log(`\n  Nothing was changed. Re-run with --yes:`)
    console.log(`    node server/scripts/recruiters.mjs delete ${person.id} --yes\n`)
    process.exit(0)
  }

  const photo = deleteRecruiterCompletely(person.id)
  console.log(`\n  Deleted.${photo ? ' Their photo is now unreferenced; restarting the server sweeps it.' : ''}\n`)
}

else {
  console.log(`
  Recruiter maintenance

    list [company]                        every recruiter, or one company's
    show <id|username>                    one account and what is attached
    add <company> "First Last"            create an account
        [--password "..."] [--admin]      (default password: username123)
    set <id|username> [--first X]         rename, or grant/revoke admin
        [--last Y] [--admin true|false]
    password <id|username>                reset to username123,
        [--password "..."]                or set one you choose
    delete <id|username> [--yes]          dry run without --yes

  Passwords can be set but never read — they are stored as one-way hashes.
`)
  process.exit(command ? 1 : 0)
}

db.close()
