/**
 * A recruiter's own contact details: kept at sign-up, and editable afterwards.
 *
 * Two claims, and the second is the one with teeth. Keeping what registration
 * collected is easy to assert and easy to believe. Letting somebody edit their
 * own account is where a self-service route can quietly become the
 * administrator route with the gate taken off — so most of this is about what
 * PATCH /api/recruiter/me refuses: an unproved contact change, somebody else's
 * account, and a rename that would move the credential they sign in with.
 */
import Database from 'better-sqlite3'
import { fileURLToPath } from 'node:url'

import { BASE, contactProofs, createReporter, json, registerAndSignIn, approveCompanyById } from './helpers.mjs'

const { check, section, finish } = createReporter()
const RUN = Date.now().toString(36)
const db = new Database(fileURLToPath(new URL('../server/data/cking.db', import.meta.url)))

const NAME = `Profile ${RUN}`
const EMAIL = `dana.${RUN}@example.com`
const PHONE = '052-555-0100'
const WEBSITE = 'example.com'

const H = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })
const me = (token) => fetch(`${BASE}/api/recruiter/me`, { headers: H(token) })
const save = (token, body) => fetch(`${BASE}/api/recruiter/me`, {
  method: 'PATCH', headers: H(token), body: JSON.stringify(body),
})

// ---------------------------------------------------------------------------

section('Sign-up keeps what it collected')

const org = await registerAndSignIn({
  companyName: NAME, firstName: 'Dana', lastName: `Prof${RUN}`,
  email: EMAIL, phone: PHONE, website: WEBSITE,
})
await approveCompanyById(org.company.id)
const token = org.token

const row = db.prepare(`SELECT * FROM recruiters WHERE id = ?`).get(org.recruiter.id)
check('the email is on the account', row.email === EMAIL, row.email ?? '(none)')
check('so is the phone number', row.phone === PHONE, row.phone ?? '(none)')
/* Stored with a scheme even though it was typed without one — a bare host is a
   clear answer to "website" and is completed rather than refused. */
check('and the website, completed to a URL', row.website === `https://${WEBSITE}`, row.website ?? '(none)')

const profile = await json(await me(token))
check('and the profile hands all three back', profile.recruiter.email === EMAIL
  && profile.recruiter.phone === PHONE
  && profile.recruiter.website === `https://${WEBSITE}`,
JSON.stringify({ email: profile.recruiter.email, phone: profile.recruiter.phone, website: profile.recruiter.website }))

// ---------------------------------------------------------------------------

section('Editing your own name')

const renamed = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: EMAIL, phone: PHONE, website: WEBSITE,
})
check('a recruiter can rename themselves', renamed.status === 200, `HTTP ${renamed.status}`)

const after = await json(await me(token))
check('the new name is returned', after.recruiter.firstName === 'Danielle'
  && after.recruiter.lastName === 'Prophet',
`${after.recruiter.firstName} ${after.recruiter.lastName}`)

/*
 * The username is the credential. Deriving it from the name at creation is a
 * convenience; rewriting it on a rename would sign somebody out of their own
 * account for fixing a typo in their surname.
 */
check('but the username they sign in with does not move',
  after.recruiter.username === org.recruiter.username,
  `${org.recruiter.username} -> ${after.recruiter.username}`)

check('and the name is still theirs after signing in again',
  db.prepare(`SELECT first_name FROM recruiters WHERE id = ?`).get(org.recruiter.id).first_name === 'Danielle')

// ---------------------------------------------------------------------------

section('A changed contact has to be proved')

const NEW_EMAIL = `moved.${RUN}@example.com`
const NEW_PHONE = '052-555-0199'

const unproved = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: NEW_EMAIL, phone: PHONE, website: WEBSITE,
})
check('a new email with no proof is refused', unproved.status === 400, `HTTP ${unproved.status}`)
check('and says which one to verify',
  /email/i.test((await unproved.json()).error ?? ''))

const unprovedPhone = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: EMAIL, phone: NEW_PHONE, website: WEBSITE,
})
check('a new phone number with no proof is refused too', unprovedPhone.status === 400,
  `HTTP ${unprovedPhone.status}`)

check('and nothing was written on the way to refusing',
  db.prepare(`SELECT email, phone FROM recruiters WHERE id = ?`).get(org.recruiter.id).email === EMAIL)

/* A proof is for one destination. One made out to a different address must not
   let a third one through — that would make the check a formality. */
const wrongProof = await contactProofs({ email: `elsewhere.${RUN}@example.com`, phone: PHONE })
const mismatched = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: NEW_EMAIL, phone: PHONE, website: WEBSITE,
  emailProof: wrongProof.emailProof,
})
check('a proof for a different address does not cover this one', mismatched.status === 400,
  `HTTP ${mismatched.status}`)

const proofs = await contactProofs({ email: NEW_EMAIL, phone: NEW_PHONE })
const proved = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: NEW_EMAIL, phone: NEW_PHONE, website: WEBSITE,
  ...proofs,
})
check('with proof, both are saved', proved.status === 200, `HTTP ${proved.status}`)

const settled = db.prepare(`SELECT email, phone FROM recruiters WHERE id = ?`).get(org.recruiter.id)
check('and the account now holds them', settled.email === NEW_EMAIL && settled.phone === NEW_PHONE,
  JSON.stringify(settled))

/* Unchanged is not the same as unproved: re-saving what is already on file
   must not demand a fresh code for something nobody touched. */
const untouched = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet',
  email: NEW_EMAIL, phone: NEW_PHONE, website: WEBSITE,
})
check('saving without changing a contact needs no new proof', untouched.status === 200,
  `HTTP ${untouched.status}`)

// ---------------------------------------------------------------------------

section('What the route will not do')

const blank = await save(token, {
  firstName: '', lastName: 'Prophet', email: NEW_EMAIL, phone: NEW_PHONE, website: WEBSITE,
})
check('a blank first name is refused', blank.status === 400, `HTTP ${blank.status}`)

const noSite = await save(token, {
  firstName: 'Danielle', lastName: 'Prophet', email: NEW_EMAIL, phone: NEW_PHONE, website: '',
})
check('and so is a missing website', noSite.status === 400, `HTTP ${noSite.status}`)

const anonymous = await fetch(`${BASE}/api/recruiter/me`, {
  method: 'PATCH', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ firstName: 'Nobody', lastName: 'Here', email: NEW_EMAIL, phone: NEW_PHONE, website: WEBSITE }),
})
check('a stranger cannot reach it', anonymous.status === 401, `HTTP ${anonymous.status}`)

/*
 * The route takes no target id at all, which is what keeps it from being the
 * administrator's edit route with the gate removed. A colleague's id in the
 * body has to change nothing.
 */
const other = await registerAndSignIn({
  companyName: `Other ${RUN}`, firstName: 'Omri', lastName: `Other${RUN}`,
  email: `omri.${RUN}@example.com`,
})
const beforeOther = db.prepare(`SELECT first_name FROM recruiters WHERE id = ?`).get(other.recruiter.id)

await save(token, {
  id: other.recruiter.id, recruiterId: other.recruiter.id,
  firstName: 'Hijacked', lastName: 'Prophet',
  email: NEW_EMAIL, phone: NEW_PHONE, website: WEBSITE,
})
const afterOther = db.prepare(`SELECT first_name FROM recruiters WHERE id = ?`).get(other.recruiter.id)
check('an id in the body reaches nobody else',
  afterOther.first_name === beforeOther.first_name,
  `${beforeOther.first_name} -> ${afterOther.first_name}`)
check('it edited the caller instead',
  db.prepare(`SELECT first_name FROM recruiters WHERE id = ?`).get(org.recruiter.id).first_name === 'Hijacked')

// ------------------------------------------------------------------ tidy ---

/* ------------------------------------------------------- the company logo --- */

/*
 * One image per company: the administrator's to set, everybody's to see.
 *
 * The asymmetry is the whole feature. A photo is a person's own and any
 * recruiter may change theirs — that is why PATCH /api/recruiter/me/photo sits
 * outside orgAdminOnly. A logo is the organization's, appears beside every
 * colleague's name, and is not theirs to change; but they must still be able
 * to SEE it, so the read is open to the company and only the write is gated.
 *
 * The other half is the bytes. multer's filter reads the file NAME and nothing
 * else, so an SVG called logo.png gets past it every time — what stops it is
 * assertUploadsAreWhatTheyClaim, and a field missing from that list is a field
 * nobody sniffs. This is the check that would notice.
 */
section('The company logo')

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

const logoBody = (bytes, name) => {
  const form = new FormData()
  form.append('logo', new Blob([bytes], { type: 'image/png' }), name)
  return form
}
const setLogo = (token, body) => fetch(`${BASE}/api/company/logo`, {
  method: 'PATCH', headers: { authorization: `Bearer ${token}` }, body,
})
const getLogo = (token) => fetch(`${BASE}/api/company/logo`, {
  headers: { authorization: `Bearer ${token}` },
})

check('a company starts with no logo', (await getLogo(token)).status === 404)

const uploaded = await setLogo(token, logoBody(PNG, 'logo.png'))
const uploadedBody = await uploaded.json().catch(() => ({}))
check('an administrator can set one', uploaded.status === 200 && uploadedBody.hasLogo === true)
check('and it is versioned, so a replacement busts its own cache',
  typeof uploadedBody.logoVersion === 'string' && uploadedBody.logoVersion.length === 8)

const served = await getLogo(token)
check('it serves back as the image it is', served.status === 200
  && served.headers.get('content-type') === 'image/png')
check('with the headers that stop it being active content',
  served.headers.get('x-content-type-options') === 'nosniff'
  && served.headers.get('content-security-policy') === "default-src 'none'; sandbox",
  'the type is taken from the bytes, never from the name')

const lying = await setLogo(token, logoBody(SVG, 'evil.png'))
check('an SVG called .png is refused', lying.status === 400,
  'multer checks the name; only the byte sniff catches this')
check('and the refusal does not destroy the logo already on file',
  (await getLogo(token)).status === 200)

const told = await json(await me(token))
check('every seat is told there is one',
  told.company?.hasLogo === true && told.company?.name === NAME,
  'it is a column on companies, so one row is one answer for the whole team')

/*
 * Demoted in place rather than given a second seat: the gate under test is
 * is_org_admin, and buying a seat to prove it would test the seat instead.
 */
db.prepare(`UPDATE recruiters SET is_org_admin = 0 WHERE id = ?`).run(org.recruiter.id)

const refused = await setLogo(token, logoBody(PNG, 'again.png'))
check('a colleague who is not an administrator cannot change it', refused.status === 403)
check('but can still see it', (await getLogo(token)).status === 200,
  'it is their company too')
check('and is still told about it', (await json(await me(token))).company?.hasLogo === true)

db.prepare(`UPDATE recruiters SET is_org_admin = 1 WHERE id = ?`).run(org.recruiter.id)

const removeBody = new FormData()
removeBody.append('removeLogo', 'true')
const removed = await setLogo(token, removeBody)
check('an administrator can take it away',
  removed.status === 200 && (await removed.json()).hasLogo === false)
check('and it stops being served', (await getLogo(token)).status === 404)

check('an empty request is refused rather than treated as a removal',
  (await setLogo(token, new FormData())).status === 400,
  'a form that lost its file must not silently clear the logo')

/* ------------------------------------------------ the header's one shape --- */

section('My profile has one header, in both modes')

/*
 * The company's mark is a full-bleed banner with the portrait on its lower
 * edge. There is no second arrangement.
 *
 * There was, for a while, and nobody wrote it deliberately: the block that
 * draws the logo appeared on `shownLogo || editing`, while the class that lays
 * it out as a banner was applied on `shownLogo` alone. The two agreed whenever
 * a logo was set and disagreed the moment one was not — so pressing the pencil
 * on a company with no logo fell back to the old side-by-side row, an empty
 * rectangle beside the portrait, which is nothing like the header it had just
 * replaced.
 *
 * Asserting the shared condition rather than the rendered result, because the
 * bug was precisely that two conditions existed. One name, read twice.
 */
const nodeFs = await import('node:fs')
const panelSrc = nodeFs.readFileSync(new URL('../client/src/pages/HrPanel.jsx', import.meta.url), 'utf8')

check('the logo block and the banner layout share one condition',
  /const showLogoBlock = /.test(panelSrc)
  && /className=\{showLogoBlock \? 'profile-identity profile-identity-banner'/.test(panelSrc)
  && /\{showLogoBlock && \(/.test(panelSrc),
  'two conditions is how edit mode ended up with a different header from view mode')

check('and neither is written as its own expression any more',
  !/shownLogo \? 'profile-identity profile-identity-banner'/.test(panelSrc)
  && !/\{\(shownLogo \|\| editing\) && \(/.test(panelSrc))

/*
 * The pencil is the dialog's control, not a row in the page.
 *
 * It sat in a .form-lock-bar between the photograph and the first field, which
 * spent a whole line of vertical space on one 28px button. It is portalled into
 * the dialog header instead - portalled rather than passed as a prop because
 * the state behind it (editing, whether the contacts are settled, what a press
 * does) belongs to the screen, while the place it goes belongs to the dialog.
 */
check('the dialog offers a slot beside its close button',
  /const DialogActionSlot = createContext/.test(panelSrc)
  && /<div className="workspace-dialog-actions" ref=\{setActionSlot\} \/>/.test(panelSrc))
check('and it is state, not a ref, so the portal renders once the node exists',
  /const \[actionSlot, setActionSlot\] = useState\(null\)/.test(panelSrc),
  'a ref does not re-render: the first pass has no node, and the portal would never appear')
check('My profile puts its pencil there', /<DialogAction>/.test(panelSrc))
check('with a fallback for being drawn outside a dialog',
  /if \(!slot\) return <div className="form-lock-bar">/.test(panelSrc))
check('and the tick in edit mode is the same control, so it inherits the position',
  /<DialogAction>[\s\S]{0,700}editing \? <TickIcon \/> : <PencilIcon \/>/.test(panelSrc))

const headCss = nodeFs.readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8')
/*
 * Next to the title, not next to the close button.
 *
 * It had an auto margin for a while, which sent it to the far corner where the
 * two read as a pair. They are not one: the close belongs to the dialog and
 * shuts it whatever is inside, this one belongs to the screen and edits the
 * thing the title names.
 */
check('the slot claims no slack, so it sits against the title',
  /\.workspace-dialog-actions \{(?:[^}]*)\}/.test(headCss)
  && !/\.workspace-dialog-actions \{[^}]*margin-left: auto/.test(headCss))
check('and the close button keeps its own corner',
  !/\.workspace-dialog-actions:not\(:empty\) \+ \.btn-quiet/.test(headCss)
  && /\.modal-head \.btn-quiet \{[^}]*margin-left: auto/.test(headCss),
  'the gap between the two is what says they are different kinds of control')
check('an empty slot takes no space at all',
  /\.workspace-dialog-actions:empty \{ display: none/.test(headCss))

check('the portrait Remove sits under it, not beside it',
  /\.profile-identity-banner \.photo-row \{[^}]*flex-direction: column/.test(headCss),
  'beside it the controls floated in the middle of the company logo, belonging to neither')

check('the banner is full-bleed, cancelling the dialog body\u2019s padding',
  /\.profile-identity-banner \{[^}]*margin: -1\.25rem -1\.25rem 0/.test(
    nodeFs.readFileSync(new URL('../client/src/styles.css', import.meta.url), 'utf8')),
  'a banner that stops short of the card edge is a picture in a box')

section('Cleanup')

const ids = db.prepare(`SELECT id FROM companies WHERE name IN (?, ?)`).all(NAME, `Other ${RUN}`).map((r) => r.id)
if (ids.length) {
  const list = ids.join(',')
  const rl = db.prepare(`SELECT id FROM recruiters WHERE company_id IN (${list})`).all()
    .map((r) => r.id).join(',') || '-1'
  db.exec(`
    DELETE FROM retrieval_sessions WHERE recruiter_id IN (${rl});
    DELETE FROM jobs WHERE recruiter_id IN (${rl});
    DELETE FROM folder_items WHERE folder_id IN (SELECT id FROM folders WHERE recruiter_id IN (${rl}));
    DELETE FROM folders WHERE recruiter_id IN (${rl});
    DELETE FROM seat_usage_periods WHERE recruiter_id IN (${rl});
    DELETE FROM seat_purchases WHERE company_id IN (${list});
    DELETE FROM billing_ledger WHERE company_id IN (${list});
    DELETE FROM organization_reveals WHERE company_id IN (${list});
    DELETE FROM recruiters WHERE company_id IN (${list});
    DELETE FROM companies WHERE id IN (${list});
  `)
}
check('test companies removed', db.prepare(
  `SELECT COUNT(*) AS n FROM companies WHERE name IN (?, ?)`,
).get(NAME, `Other ${RUN}`).n === 0)

finish()
