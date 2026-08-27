#!/usr/bin/env node
/**
 * Company maintenance from the command line.
 *
 *   node server/scripts/companies.mjs list
 *   node server/scripts/companies.mjs show <id|name>
 *   node server/scripts/companies.mjs add "Acme Hiring" --admin "Maya Cohen" [--password "..."]
 *   node server/scripts/companies.mjs pending
 *   node server/scripts/companies.mjs approve <id|name>
 *   node server/scripts/companies.mjs rename <id> "New Name"
 *   node server/scripts/companies.mjs delete <id>            (dry run — shows what would go)
 *   node server/scripts/companies.mjs delete <id> --yes      (actually deletes)
 *
 * Why this exists rather than raw SQL: nineteen tables reference a company or
 * one of its recruiters, and none of them declare a foreign key. A hand-written
 * DELETE FROM companies leaves every one of those rows pointing at an id that no
 * longer exists — invisible until something reads them months later.
 *
 * Creation goes through the app's own functions, so a company made here is
 * identical to one made through the UI: same key generation, same username
 * derivation, same password hashing. Nothing here reimplements those.
 */
import {
  approveCompany, createCompany, createRecruiter, declineCompany, deleteRecruiterCompletely,
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

/** Who is making the call. `--by "Name"` wins; the machine's user is the
    fallback, which is right for a one-operator setup and honest either way. */
function reviewer() {
  const named = flags.get('by')
  if (typeof named === 'string' && named.trim()) return named.trim()
  return process.env.USERNAME ?? process.env.USER ?? 'operator'
}

const fail = (message) => { console.error(`\n  ${message}\n`); process.exit(1) }

/** Accepts an id or an exact name, so you never have to look one up first. */
function resolveCompany(token) {
  if (!token) fail('Which company? Pass an id or an exact name.')

  const byId = /^\d+$/.test(token)
    ? db.prepare(`SELECT * FROM companies WHERE id = ?`).get(Number(token))
    : null
  if (byId) return byId

  const byName = db.prepare(`SELECT * FROM companies WHERE name = ? COLLATE NOCASE`).all(token)
  if (byName.length === 1) return byName[0]
  if (byName.length > 1) {
    fail(`"${token}" matches ${byName.length} companies (ids ${byName.map((c) => c.id).join(', ')}). Use the id.`)
  }

  return fail(`No company matches "${token}". Run "list" to see them.`)
}

/** Everything that would be removed along with the company. */
function impactOf(company) {
  const recruiters = db.prepare(`SELECT id, username, first_name, last_name, is_org_admin FROM recruiters WHERE company_id = ?`)
    .all(company.id)
  const ids = recruiters.map((r) => r.id)
  const list = ids.length ? ids.join(',') : '-1'

  const count = (sql) => db.prepare(sql).get()?.n ?? 0

  return {
    recruiters,
    folders: count(`SELECT COUNT(*) AS n FROM folders WHERE recruiter_id IN (${list})`),
    threads: count(`SELECT COUNT(*) AS n FROM message_threads WHERE company_id = ${company.id}`),
    messages: count(`SELECT COUNT(*) AS n FROM messages WHERE recruiter_id IN (${list})`),
    searches: count(`SELECT COUNT(*) AS n FROM search_chats WHERE recruiter_id IN (${list})`),
    jobs: count(`SELECT COUNT(*) AS n FROM jobs WHERE recruiter_id IN (${list})`),
    analyses: count(`SELECT COUNT(*) AS n FROM candidate_job_analyses WHERE job_id IN (SELECT id FROM jobs WHERE recruiter_id IN (${list}))`),
    reveals: count(`SELECT COUNT(*) AS n FROM reveals WHERE company_id = ${company.id}`),
    seats: count(`SELECT COUNT(*) AS n FROM seat_purchases WHERE company_id = ${company.id}`),
  }
}

// ------------------------------------------------------------------ list ---

if (command === 'list' || command === undefined) {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.join_key, c.seat_limit, c.created_at, c.approval_status,
           (SELECT COUNT(*) FROM recruiters r WHERE r.company_id = c.id) AS recruiters
    FROM companies c ORDER BY c.id
  `).all()

  if (rows.length === 0) console.log('\n  No companies.\n')
  else {
    console.log('')
    // Status first: whether a company can reach anybody is the most
    // consequential thing about it, and it was the one column this omitted.
    console.log('  id   status    key             people  name')
    console.log('  ---  --------  --------------  ------  ----')
    for (const row of rows) {
      console.log(
        `  ${String(row.id).padEnd(3)}  ${String(row.approval_status ?? 'approved').padEnd(8)}  `
        + `${String(row.join_key ?? '—').padEnd(14)}  `
        + `${String(row.recruiters).padStart(6)}  ${row.name}`,
      )
    }
    console.log('')
  }
}

// ------------------------------------------------------------------ show ---

else if (command === 'show') {
  const company = resolveCompany(args[0])
  const impact = impactOf(company)

  console.log(`\n  ${company.name}  (id ${company.id})`)
  console.log(`  company key : ${company.join_key}`)
  console.log(`  approval    : ${company.approval_status ?? 'approved'}`)
  console.log(`  seat limit  : ${company.seat_limit ?? 1}`)
  console.log(`  created     : ${company.created_at}`)
  console.log('\n  Recruiters:')
  if (impact.recruiters.length === 0) console.log('    (none — this company has no way in)')
  for (const person of impact.recruiters) {
    console.log(`    ${String(person.id).padEnd(4)} ${person.username.padEnd(20)} `
      + `${person.first_name} ${person.last_name}${person.is_org_admin ? '  [admin]' : ''}`)
  }
  console.log(`\n  folders ${impact.folders} · threads ${impact.threads} · messages ${impact.messages} `
    + `· searches ${impact.searches} · jobs ${impact.jobs} · analyses ${impact.analyses} `
    + `· reveals ${impact.reveals} · seat purchases ${impact.seats}\n`)
}

// ------------------------------------------------------------------- add ---

else if (command === 'add') {
  const name = args[0]
  if (!name) fail('Give the company a name: add "Acme Hiring" --admin "Maya Cohen"')

  const admin = flags.get('admin')
  if (!admin || admin === true) {
    fail('A company needs an administrator, or nobody can sign in.\n'
      + '  Try: add "Acme Hiring" --admin "Maya Cohen"')
  }

  const [firstName, ...restName] = String(admin).trim().split(/\s+/)
  const lastName = restName.join(' ')
  if (!lastName) fail(`--admin needs a first and last name; got "${admin}".`)

  const password = flags.get('password') === true ? null : flags.get('password')
  if (password && String(password).length < 8) fail('A password must be at least 8 characters.')

  // Approved on creation: the pending state exists to hold a stranger who
  // signed themselves up (§15), and whoever ran this command is not one.
  const company = createCompany(name, { approvalStatus: 'approved' })
  const recruiter = await createRecruiter({
    companyId: company.id, firstName, lastName,
    password: password ?? undefined, isOrgAdmin: true,
  })

  console.log(`\n  Created "${company.name}" (id ${company.id})`)
  console.log(`  company key : ${company.joinKey}`)
  console.log(`  username    : ${recruiter.username}`)
  // Straight from the creation call, so what is printed is what was hashed.
  console.log(`  password    : ${recruiter.initialPassword}`)
  console.log('\n  Sign in at /hr with the company key, username and password.\n')
}

// --------------------------------------------------------------- pending ---

/*
 * Audit §15 removed the sign-up secret, so anyone can register a company. What
 * they cannot do is see a candidate until someone here says so — this is where
 * that decision is made.
 */
else if (command === 'pending') {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.created_at,
           (SELECT r.email FROM recruiters r WHERE r.company_id = c.id AND r.is_org_admin = 1 LIMIT 1) AS email,
           (SELECT r.website FROM recruiters r WHERE r.company_id = c.id AND r.is_org_admin = 1 LIMIT 1) AS website
    FROM companies c WHERE c.approval_status = 'pending' ORDER BY c.created_at
  `).all()

  if (rows.length === 0) console.log('\n  Nothing waiting.\n')
  else {
    console.log('\n  Awaiting approval:\n')
    for (const row of rows) {
      console.log(`  ${String(row.id).padEnd(4)} ${row.name}`)
      console.log(`       ${row.email ?? '(no email)'}  ·  ${row.website ?? '(no website)'}`)
      console.log(`       registered ${row.created_at}\n`)
    }
    console.log('  Approve:  node server/scripts/companies.mjs approve <id>')
    console.log('  Decline:  node server/scripts/companies.mjs decline <id> --reason "..."\n')
  }
}

// --------------------------------------------------------------- approve ---

else if (command === 'approve') {
  const company = resolveCompany(args[0])

  if (company.approval_status === 'approved') {
    console.log(`\n  "${company.name}" is already approved.\n`)
  } else {
    /* Named where the operator gave a name, so the review channel can say who
       cleared it. --by, or whoever is signed in to the machine. */
    approveCompany(company.id, { reviewedBy: reviewer() })
    console.log(`\n  Approved "${company.name}" (id ${company.id}).`)
    // Said plainly, because approving a declined company is the undo for a
    // decline and it should be obvious that it worked.
    if (company.approval_status === 'declined') {
      console.log('  It had been declined; that is now reversed.')
    }
    console.log('  Its recruiters can now search and reveal candidates.\n')
  }
}

// --------------------------------------------------------------- decline ---

/*
 * The other half of the decision, which did not exist: you could approve a
 * company or leave it pending forever, and there was no way to record a no.
 *
 * Recorded rather than deleted. A refusal that leaves no trace gets re-reviewed
 * from scratch every time somebody looks at the queue, and the reason is
 * exactly what you want in front of you if the same company registers again.
 *
 * Nothing is removed: the account, its recruiters and anything they saved all
 * stay, they simply reach no candidate. Use `delete` if it should not exist.
 */
else if (command === 'decline') {
  const company = resolveCompany(args[0])
  const reason = typeof flags.get('reason') === 'string' ? flags.get('reason') : null

  if (company.approval_status === 'declined') {
    console.log(`\n  "${company.name}" is already declined.`)
    console.log(`  Reason on file: ${company.declined_reason ?? '(none given)'}\n`)
  } else {
    declineCompany(company.id, reason, { reviewedBy: reviewer() })
    console.log(`\n  Declined "${company.name}" (id ${company.id}).`)
    if (reason) console.log(`  Reason: ${reason}`)
    console.log('  Its recruiters can still sign in, but reach no candidate profiles.')
    console.log(`  Undo with: node server/scripts/companies.mjs approve ${company.id}\n`)
  }
}

// ---------------------------------------------------------------- rename ---

else if (command === 'rename') {
  const company = resolveCompany(args[0])
  const name = args[1]
  if (!name) fail(`What should "${company.name}" be called? rename ${company.id} "New Name"`)

  db.prepare(`UPDATE companies SET name = ? WHERE id = ?`).run(name, company.id)
  console.log(`\n  ${company.name} -> ${name}\n`)
}

// ---------------------------------------------------------------- delete ---

else if (command === 'delete') {
  const company = resolveCompany(args[0])
  const impact = impactOf(company)
  const confirmed = flags.get('yes') === true

  console.log(`\n  ${confirmed ? 'Deleting' : 'Would delete'} "${company.name}" (id ${company.id}):`)
  console.log(`    ${impact.recruiters.length} recruiter account(s): `
    + `${impact.recruiters.map((r) => r.username).join(', ') || '(none)'}`)
  console.log(`    ${impact.folders} folder(s), ${impact.threads} conversation(s), ${impact.messages} message(s)`)
  console.log(`    ${impact.searches} saved search(es), ${impact.jobs} job(s), ${impact.analyses} cached analysis(es)`)
  console.log(`    ${impact.reveals} reveal(s), ${impact.seats} seat purchase(s)`)
  console.log('\n  Candidates are NOT touched — they belong to the marketplace, not to a company.')

  if (!confirmed) {
    console.log(`\n  Nothing was changed. Re-run with --yes to go ahead:`)
    console.log(`    node server/scripts/companies.mjs delete ${company.id} --yes\n`)
    process.exit(0)
  }

  /*
   * Recruiters go through the app's own cascade so this stays correct when
   * that function learns about a new table. Everything left is company-scoped
   * and is cleared here, inside one transaction: a half-deleted company is
   * worse than either outcome.
   */
  const photos = []
  db.transaction(() => {
    for (const person of impact.recruiters) {
      const photo = deleteRecruiterCompletely(person.id)
      if (photo) photos.push(photo)
    }

    db.prepare(`DELETE FROM reveals WHERE company_id = ?`).run(company.id)
    db.prepare(`DELETE FROM message_threads WHERE company_id = ?`).run(company.id)
    db.prepare(`DELETE FROM seat_purchases WHERE company_id = ?`).run(company.id)

    /*
     * The billing tables. Added with the pricing model, after this script was
     * written — so deleting a company left its ledger behind, pointing at an id
     * that no longer existed. Exactly the failure the header above warns about,
     * committed by the tool that exists to prevent it.
     *
     * The lesson generalises: anything keyed on company_id has to be added here
     * at the same time it is added to the schema, because nothing in SQLite
     * will complain when it is not.
     */
    db.prepare(`DELETE FROM billing_ledger WHERE company_id = ?`).run(company.id)
    db.prepare(`DELETE FROM organization_reveals WHERE company_id = ?`).run(company.id)

    db.prepare(`UPDATE view_events SET company_id = NULL WHERE company_id = ?`).run(company.id)
    db.prepare(`UPDATE jobs SET company_id = NULL WHERE company_id = ?`).run(company.id)
    db.prepare(`DELETE FROM companies WHERE id = ?`).run(company.id)
  })()

  console.log(`\n  Deleted. ${photos.length} profile photo(s) are now unreferenced;`)
  console.log('  restarting the server sweeps them from server/uploads.\n')
}

// ----------------------------------------------------------------- usage ---

else {
  console.log(`
  Company maintenance

    list                              every company, with seat use
    show <id|name>                    one company and everything attached to it
    pending                           companies waiting to be approved (§15)
    approve <id|name>                 let a company reach candidate profiles
    decline <id|name> [--reason "…"]  refuse it — recorded, reversible, deletes nothing
    decline <id|name> [--reason "…"]  refuse it — recorded, reversible, deletes nothing
    add "Name" --admin "First Last"   create a company and its administrator
                                      [--password "..."] (default: username123)
    rename <id|name> "New Name"       rename in place
    delete <id|name>                  dry run: show what would be removed
    delete <id|name> --yes            remove it and everything attached

  Candidates are never touched by any of these.
`)
  process.exit(command ? 1 : 0)
}

db.close()
