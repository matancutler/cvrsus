/**
 * One mailbox, one number, one account.
 *
 * This was enforced by whichever route happened to be checking, which meant it
 * held on the paths somebody had thought about and not on the others. The
 * sign-up route refused a duplicate; the operator CLI wrote the column
 * directly and did not. That gap is on the account-recovery path — an operator
 * moving a locked-out candidate to a new address — which is the worst possible
 * place for it, and duplicate identities have already cost real accounts here.
 *
 * So the rule lives in the database now, as a UNIQUE index on a derived key
 * rather than on the typed column. That distinction is the whole point:
 * indexing `email` would treat dana.smith@gmail.com and danasmith@gmail.com as
 * different addresses when they are one inbox, and `phone` would treat
 * "+972 50 123 4567" and "050-123-4567" as different numbers.
 *
 * These checks go through the real write paths — insertCandidate and
 * updateCandidate — because a test that writes raw SQL would prove only that
 * SQLite has indexes, which was never in doubt.
 */
import db, {
  emailKey,
  getCandidate,
  insertCandidate,
  phoneKey,
  updateCandidate,
} from '../server/src/db.js'
import { createReporter } from './helpers.mjs'

const { section, check, finish } = createReporter('Identity')
const RUN = Date.now().toString(36)
const MARK = `cking-id-${RUN}`
/* Digits, not the base36 run id: phoneKey wants nine of them and returns null
   for anything shorter, and two nulls do not collide — which would have made
   this file pass while proving nothing. */
const DIGITS = String(Date.now()).slice(-7)
const NUMBER = `050${DIGITS}`

let seq = 0
function make({ email, phone }) {
  seq += 1
  return insertCandidate({
    name: `Ida ${seq}`, first_name: 'Ida', middle_name: null, last_name: String(seq),
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

/* ------------------------------------------------------------- the keys --- */

section('The key is the mailbox, not the spelling')

check('gmail dots and tags fold together',
  emailKey('Dana.Smith+jobs@gmail.com') === emailKey('danasmith@gmail.com'))
check('and googlemail is the same provider',
  emailKey('a.b@googlemail.com') === 'ab@googlemail.com')
/* Everywhere else a dot is significant, and folding it would hand one person
   another person's account. */
check('but a dot elsewhere is significant',
  emailKey('dana.smith@cvrsvs.com') !== emailKey('danasmith@cvrsvs.com'),
  'only Gmail documents dots as decoration')
check('phone formats fold to the last nine digits',
  phoneKey('+972 50 123 4567') === phoneKey('050-123-4567'))

/* ------------------------------------------------------------ the rule --- */

section('A second account cannot take a mailbox that is in use')

const first = make({ email: `ida.${RUN}@${MARK}.example.com`, phone: NUMBER })
check('the first account is created', Number.isInteger(first) && first > 0)

check('the same address again is refused',
  refuses(() => make({ email: `ida.${RUN}@${MARK}.example.com`, phone: '0509999999' })))

check('and so is a different spelling of the same Gmail inbox',
  refuses(() => {
    make({ email: `zoe.${RUN}@gmail.com`, phone: '0508888888' })
    make({ email: `z.o.e.${RUN}+work@gmail.com`, phone: '0508888887' })
  }),
  'this is the pair that used to produce two profiles for one person')

section('Nor a phone number that is in use')

check('the same number again is refused',
  refuses(() => make({ email: `other.${RUN}@${MARK}.example.com`, phone: NUMBER })))
check('and so is the same number written internationally',
  refuses(() => make({
    email: `intl.${RUN}@${MARK}.example.com`,
    phone: `+972 50 ${DIGITS.slice(0, 3)} ${DIGITS.slice(3)}`,
  })),
  'the last nine digits are the number')

section('An edit cannot take one either')

const second = make({ email: `bea.${RUN}@${MARK}.example.com`, phone: '0507777777' })
check('a second, genuinely different account is fine', Number.isInteger(second))

check('moving it onto the first account’s address is refused',
  refuses(() => updateCandidate(second, { email: `ida.${RUN}@${MARK}.example.com` })))
check('moving it onto the first account’s number is refused',
  refuses(() => updateCandidate(second, { phone: NUMBER })))
/* This is the path that mattered: the operator CLI changes an address through
   updateCandidate, and used to write the column with no check at all. */
check('and the address it did have is untouched by the refusal',
  getCandidate(second).email === `bea.${RUN}@${MARK}.example.com`)

section('The key follows the value')

const moved = `bea.moved.${RUN}@${MARK}.example.com`
check('a legitimate change succeeds', updateCandidate(second, { email: moved }))
check('and the key moves with it', getCandidate(second).email_key === emailKey(moved),
  'a stale key would keep the old address reserved and free the new one')
check('the old address is available again',
  !refuses(() => make({ email: `bea.${RUN}@${MARK}.example.com`, phone: '0506666666' })))

/* An update that says nothing about contact details must not blank the keys —
   doing so would quietly release the address for anybody to claim. */
updateCandidate(second, { location: 'Haifa' })
check('an unrelated edit leaves the keys alone',
  getCandidate(second).email_key === emailKey(moved))

section('A missing detail is not a shared one')

const noPhone = make({ email: `nophone.${RUN}@${MARK}.example.com`, phone: null })
const alsoNoPhone = make({ email: `nophone2.${RUN}@${MARK}.example.com`, phone: null })
check('two accounts may both have no phone number',
  Number.isInteger(noPhone) && Number.isInteger(alsoNoPhone),
  'NULL is not a value two people share')

/* ------------------------------------------------------------ cleanup --- */

section('Cleanup')

let removed = 0
for (const row of db.prepare(`SELECT id, stored_name FROM candidates WHERE stored_name LIKE ?`)
  .all(`${MARK}-%`)) {
  if (!String(row.stored_name).startsWith(MARK)) throw new Error(`refusing ${row.id}`)
  db.prepare(`DELETE FROM candidates WHERE id = ?`).run(row.id)
  removed += 1
}
/* The Gmail pair carries a real aliasing domain and so cannot wear the marker
   in its address; it is removed by the exact addresses this run generated. */
for (const address of [`zoe.${RUN}@gmail.com`, `z.o.e.${RUN}+work@gmail.com`]) {
  const row = db.prepare(`SELECT id, email FROM candidates WHERE email = ?`).get(address)
  if (!row) continue
  if (row.email !== address) throw new Error(`refusing to erase ${row.id}: not this run's`)
  db.prepare(`DELETE FROM candidates WHERE id = ?`).run(row.id)
  removed += 1
}
check('test data removed', true, `${removed} candidate(s)`)

finish()
