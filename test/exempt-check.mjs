/**
 * One mailbox is one account — except for the contacts named in the environment.
 *
 * The exemption exists so an operator can walk through signup repeatedly with
 * an address and a handset where the codes actually arrive. It is a hole in a
 * rule that protects real people, so what this file is really testing is the
 * shape of the hole: that it is exactly as wide as the list and no wider, that
 * the list is empty by default, and that it lives in the index rather than in
 * whichever code path happened to remember it.
 *
 * The list is borrowed and given back through setExemptContacts, never through
 * the environment: the environment is read once at import, while the index is
 * rewritten on every one, and a suite that set the variable would leave its
 * probe list in the schema for every process afterwards.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const db = (await import('../server/src/db.js')).default
const {
  contactIsExempt, emailKey, exemptContacts, insertCandidate, phoneKey, setExemptContacts,
} = await import('../server/src/db.js')

/* What the operator configured, to be put back at the end whatever happens. */
const RESTORE = exemptContacts()
setExemptContacts(['exempt.probe@gmail.com', '052-000-1234'])
const { createReporter } = await import('./helpers.mjs')

const { section, check, finish } = createReporter('Duplicate exemptions')
const RUN = Date.now().toString(36)
const MARK = `cking-exempt-${RUN}`

let seq = 0
function make({ email, phone }) {
  seq += 1
  return insertCandidate({
    name: `Probe ${seq}`, first_name: 'Probe', middle_name: null, last_name: String(seq),
    email, phone, location: 'Tel Aviv',
    years_experience: null, current_title: null, desired_role: null,
    availability: null, links: [], notes: null,
    file_name: 'cv.pdf', stored_name: `${MARK}-${seq}.pdf`, file_size: 10,
    photo_name: null, cv_text: null, skills: [], detected_years: null,
    created_at: new Date().toISOString(),
  })
}

const refuses = (fn) => {
  try { fn(); return false } catch (error) { return /UNIQUE|constraint/i.test(error.message) }
}

/* ------------------------------------------------------- what is exempt --- */

section('The list, and only the list')

check('a listed address is exempt', contactIsExempt('exempt.probe@gmail.com'))
check('and a listed number is', contactIsExempt('052-000-1234'))
/* Canonicalised on both sides, or the exemption would depend on how somebody
   happened to type it — which is the bug the keys exist to prevent. */
check('however the address is spelled',
  contactIsExempt('Exempt.Probe+work@gmail.com'),
  'the Gmail dots and tags fold, the same as everywhere else')
check('and however the number is written',
  contactIsExempt('+972 52 000 1234'),
  'the last nine digits are the number')

check('nobody else is exempt', !contactIsExempt('someone@else.com'))
check('nor another number', !contactIsExempt('052-000-9999'))
check('nor an empty value', !contactIsExempt('') && !contactIsExempt(null))

/* ------------------------------------------------------ the rule stands --- */

section('The rule still holds for everybody else')

const ordinary = `ordinary.${RUN}@${MARK}.example.com`
const first = make({ email: ordinary, phone: `050${String(Date.now()).slice(-7)}` })
check('an ordinary account is created', Number.isInteger(first))
check('and its address cannot be taken twice',
  refuses(() => make({ email: ordinary, phone: '0501110000' })),
  'the exemption must not have loosened the rule generally')

/* -------------------------------------------------------- and the hole --- */

section('A listed contact may appear more than once')

const a = make({ email: 'exempt.probe@gmail.com', phone: '052-000-1234' })
const b = make({ email: 'exempt.probe@gmail.com', phone: '052-000-1234' })
check('twice on the same address and number', Number.isInteger(a) && Number.isInteger(b))
check('and they are two different rows', a !== b)

/* The index is where the exemption lives, so it is visible in the schema
   rather than in whichever code path remembered to check. */
const indexes = db.prepare(`
  SELECT name, sql FROM sqlite_master
  WHERE type = 'index' AND name LIKE 'idx_candidates_%_key'
`).all()
check('both unique indexes exist', indexes.length === 2, `${indexes.length}`)
check('and each carries the exemption in its own WHERE clause',
  indexes.every((row) => /NOT IN \(/.test(row.sql)),
  'an exemption enforced only in application code is one a script can walk past')
check('the address is carved out by its canonical key',
  indexes.some((row) => row.sql.includes(emailKey('exempt.probe@gmail.com'))))
check('and the number by its last nine digits',
  indexes.some((row) => row.sql.includes(phoneKey('052-000-1234'))))

/* ------------------------------------------- and it survives other people --- */

/*
 * The regression this file exists for.
 *
 * The list used to be read from the environment alone, and the index is
 * rewritten from it on every import — so any process that imported db.js from a
 * directory with no .env rebuilt both indexes with an empty list. The test
 * suites are exactly such processes. Every run therefore stripped the operator's
 * own address out of a schema that a SERVER was still running against, and that
 * server, holding the old list in memory, went on accepting a signup the
 * database then refused: a raw "UNIQUE constraint failed: candidates.email_key"
 * shown to a candidate under their own email address.
 *
 * A child process, because the bug only appears on a fresh import — this one
 * already has the module loaded and would prove nothing.
 */

section('An unconfigured process inherits the list rather than imposing none')

const indexSql = () => db.prepare(`
  SELECT GROUP_CONCAT(sql, ' | ') AS sql FROM sqlite_master
  WHERE type = 'index' AND name LIKE 'idx_candidates_%_key'
`).get().sql

const beforeImport = indexSql()

const elsewhere = { ...process.env }
delete elsewhere.DUPLICATE_EXEMPT_CONTACTS

let imported = true
try {
  execFileSync(process.execPath,
    ['--input-type=module', '-e', `await import('./server/src/db.js')`],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), env: elsewhere, stdio: 'ignore' })
} catch { imported = false }

check('db.js can be imported with the variable unset', imported)
check('and the exemptions are still in the index afterwards',
  indexSql() === beforeImport,
  'this is the failure that reached a candidate as raw SQLite text')

/* ------------------------------------------------------------ cleanup --- */

section('Cleanup')

let removed = 0
for (const row of db.prepare(`SELECT id, stored_name FROM candidates WHERE stored_name LIKE ?`)
  .all(`${MARK}-%`)) {
  if (!String(row.stored_name).startsWith(MARK)) throw new Error(`refusing ${row.id}`)
  db.prepare(`DELETE FROM candidates WHERE id = ?`).run(row.id)
  removed += 1
}
check('test data removed', true, `${removed} candidate(s)`)

/*
 * And the list is given back exactly as it was found — not rebuilt from a guess
 * about what it should be.
 *
 * An earlier version recreated the two indexes by hand as plain unique ones,
 * which reads as "restored" and means "un-exempted": it stripped the
 * operator's own address from a running server's schema, and the next signup
 * failed with a raw SQLite constraint error while the route, still holding the
 * old list in memory, believed it was allowed.
 */
setExemptContacts(RESTORE)

check('the probe exemptions are out of the schema',
  db.prepare(`
    SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type = 'index' AND name LIKE 'idx_candidates_%_key' AND sql LIKE '%exempt.probe%'
  `).get().n === 0)
check('and the configured list is back',
  exemptContacts().join(',') === RESTORE.join(','),
  RESTORE.length ? RESTORE.join(', ') : 'nothing was exempt')
check('and it is still exempt in the schema, not only in memory',
  RESTORE.every((contact) => db.prepare(`
    SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type = 'index' AND name LIKE 'idx_candidates_%_key' AND sql LIKE ?
  `).get(`%${contact.includes('@') ? emailKey(contact) : phoneKey(contact)}%`).n === 1),
  'this is the check that would have caught the bug that prompted it')

finish()
