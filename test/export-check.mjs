/**
 * Exporting a folder to a spreadsheet.
 *
 * Two things are being checked and they fail in different ways. The file has to
 * be a real .xlsx — written by hand here, so "Excel says it is corrupt" is a
 * live risk and the package is read back apart rather than trusted. And the
 * rows have to mask exactly as the screen does: an export is the one place
 * where a candidate nobody has paid for could quietly leave the building with
 * their email address attached.
 */
import fs from 'node:fs'

import { workbook, unzip } from '../server/src/xlsx.js'
import { BASE, contactProofs, createReporter, json, makePdf, registerApprovedCompany } from './helpers.mjs'

const { section, check, finish } = createReporter('Folder export')
const RUN = Date.now().toString(36)
const MARK = `@cking-export-${RUN}.example.com`

/* ------------------------------------------------------- the file itself --- */

section('It is a spreadsheet, not a file named like one')

const sample = workbook([
  ['Name', 'Score'],
  ['Pat "quote" & <angle>', 100],
  ['Nobody', ''],
], { sheetName: 'a/folder:name*' })

const parts = unzip(sample)
check('the package holds the five parts a workbook needs',
  ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']
    .every((name) => parts.has(name)),
  [...parts.keys()].join(', '))

const sheet = parts.get('xl/worksheets/sheet1.xml')
check('every row is there', (sheet.match(/<row /g) ?? []).length === 3)
check('a score is written as a number, so the column sorts and sums',
  /<c r="B2"><v>100<\/v><\/c>/.test(sheet),
  'as text it sorts 100 before 99')
check('and the characters XML cannot carry are escaped rather than emitted',
  /Pat &quot;quote&quot; &amp; &lt;angle&gt;/.test(sheet),
  'one unescaped ampersand in a candidate name is a file that will not open')
check('the sheet name is cleaned of what Excel refuses',
  /name="a folder name"/.test(parts.get('xl/workbook.xml')),
  'a folder can be called anything; a worksheet cannot')
check('two exports of the same rows are the same bytes',
  Buffer.compare(sample, workbook([
    ['Name', 'Score'],
    ['Pat "quote" & <angle>', 100],
    ['Nobody', ''],
  ], { sheetName: 'a/folder:name*' })) === 0,
  'a timestamp inside would make the output untestable')

/* ------------------------------------------------------------ the rows --- */

section('A folder exports what the screen shows, masked the same way')

const admin = await registerApprovedCompany({
  companyName: `cking-export-${RUN}`, firstName: 'Maya', lastName: 'Cohen',
  email: `maya${MARK}`, phone: `052-${String(Date.now()).slice(-6, -3)}-9601`,
})
const H = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })
const auth = H(admin.token)

const people = []
for (const first of ['Revealed', 'Hidden']) {
  const email = `${first}.${RUN}${MARK}`.toLowerCase()
  const phone = `052-${String(Date.now()).slice(-6, -3)}-96${first === 'Revealed' ? '02' : '03'}`
  const form = new FormData()
  form.append('cv', new Blob([await makePdf([
    `${first} Person`, 'Backend Engineer', 'BACKEND ENGINEER, Acme 2019-01 - present',
    '  Six years building payment systems in Python and SQL on AWS.', 'SKILLS: Python, SQL, AWS',
  ])], { type: 'application/pdf' }), 'cv.pdf')
  for (const [key, value] of Object.entries({
    firstName: first, lastName: 'Person', email, phone,
    location: 'Tel Aviv', availability: 'Immediately', capacity: 'Full time',
    openToRelocation: 'yes', openToAllOpportunities: 'true', consent: 'true',
  })) form.append(key, value)
  for (const [key, value] of Object.entries(await contactProofs({ email, phone }))) {
    form.append(key, value)
  }
  const made = await json(await fetch(`${BASE}/api/candidates`, { method: 'POST', body: form }))
  people.push({ first, email, phone, id: made.id })
}

const folder = await json(await fetch(`${BASE}/api/hr/folders`, {
  method: 'POST', headers: auth, body: JSON.stringify({ name: `cking-export-${RUN}` }),
}))
const folderId = folder.id ?? folder.folder?.id ?? folder.folders?.at(-1)?.id

for (const person of people) {
  await fetch(`${BASE}/api/hr/folders/${folderId}/items`, {
    method: 'POST', headers: auth, body: JSON.stringify({ candidateId: person.id }),
  })
}

const revealed = people[0]
check('one of the two is revealed',
  (await fetch(`${BASE}/api/hr/candidates/${revealed.id}/reveal`, {
    method: 'POST', headers: auth, body: JSON.stringify({}),
  })).status === 200)

const response = await fetch(`${BASE}/api/hr/folders/${folderId}/export`, { headers: auth })
check('the export is served as a spreadsheet', response.status === 200
  && (response.headers.get('content-type') ?? '').includes('spreadsheetml.sheet'),
  `${response.status} ${response.headers.get('content-type')}`)
check('and offered as a download named after the folder',
  /attachment; filename=/.test(response.headers.get('content-disposition') ?? ''),
  response.headers.get('content-disposition'))

const file = Buffer.from(await response.arrayBuffer())
const grid = [...unzip(file).get('xl/worksheets/sheet1.xml')
  .matchAll(/<row [^>]*>(.*?)<\/row>/g)]
  .map((row) => [...row[1].matchAll(
    /<c [^>]*?(?:t="inlineStr"><is><t[^>]*>(.*?)<\/t><\/is>|><v>(.*?)<\/v>)<\/c>|<c [^>]*\/>/g,
  )].map((cellMatch) => cellMatch[1] ?? cellMatch[2] ?? ''))

const headings = grid[0] ?? []
check('the columns are the card’s, in the card’s order',
  JSON.stringify(headings) === JSON.stringify([
    'Name', 'Revealed', 'Email', 'Phone', 'Location', 'Availability', 'Capacity',
    'Open to relocation', 'Professional summary', 'Score', 'Scored against',
    'Status', 'Tags', 'Documents', 'Added',
  ]), JSON.stringify(headings))

const at = (row, column) => row[headings.indexOf(column)]
const revealedRow = grid.slice(1).find((row) => at(row, 'Revealed') === 'Yes')
const hiddenRow = grid.slice(1).find((row) => at(row, 'Revealed') === 'No')

check('both candidates are in the sheet', Boolean(revealedRow) && Boolean(hiddenRow),
  `${grid.length - 1} rows`)

check('the revealed one carries their contact details',
  at(revealedRow, 'Email') === revealed.email && at(revealedRow, 'Phone') === revealed.phone,
  JSON.stringify(revealedRow))
check('and their full name',
  at(revealedRow, 'Name') === 'Revealed Person', at(revealedRow, 'Name'))

/*
 * The one that matters. A spreadsheet leaves the product and gets forwarded;
 * if masking were reimplemented here rather than taken from the same rows the
 * screen draws, this is where the copy would drift.
 */
check('the unrevealed one is a first name and nothing else',
  at(hiddenRow, 'Name') === 'Hidden', at(hiddenRow, 'Name'))
check('their email and phone are withheld, and say so',
  at(hiddenRow, 'Email') === 'Hidden until revealed'
  && at(hiddenRow, 'Phone') === 'Hidden until revealed',
  JSON.stringify(hiddenRow))
check('and neither appears anywhere in the file at all',
  !file.toString('utf8').includes(people[1].email)
  && !file.toString('utf8').includes(people[1].phone),
  'not in a cell, not in a leftover, not anywhere')

check('what is free to know is still there for both',
  at(hiddenRow, 'Location') === 'Tel Aviv' && at(hiddenRow, 'Availability') === 'Immediately',
  'the reveal buys contact details, not the fact that somebody exists')

/* --------------------------------------------------------------- gates --- */

section('Somebody else’s folder is not exportable')

const rival = await registerApprovedCompany({
  companyName: `cking-export-rival-${RUN}`, firstName: 'Noa', lastName: 'Levi',
  email: `noa${MARK}`, phone: `052-${String(Date.now()).slice(-6, -3)}-9604`,
})
const stolen = await fetch(`${BASE}/api/hr/folders/${folderId}/export`, { headers: H(rival.token) })
check('a recruiter at another company gets nothing', stolen.status === 404,
  `HTTP ${stolen.status}`)
const anonymous = await fetch(`${BASE}/api/hr/folders/${folderId}/export`)
check('and neither does somebody with no session', anonymous.status === 401,
  `HTTP ${anonymous.status}`)

/* ------------------------------------------------------------- cleanup --- */

section('Cleanup')

const db = (await import('../server/src/db.js')).default
const { deleteCandidateCompletely } = await import('../server/src/profiles.js')
const { UPLOAD_DIR } = await import('../server/src/db.js')
const path = await import('node:path')

let files = 0
for (const person of people) {
  const row = db.prepare(`SELECT id, email FROM candidates WHERE email = ?`).get(person.email)
  if (!row) continue
  if (row.email !== person.email) throw new Error(`refusing to erase ${row.id}: not this run's`)
  for (const stored of deleteCandidateCompletely(row.id)) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, stored)); files += 1 } catch { /* gone */ }
  }
}
for (const name of [`cking-export-${RUN}`, `cking-export-rival-${RUN}`]) {
  const company = db.prepare(`SELECT id, name FROM companies WHERE name = ?`).get(name)
  if (!company || company.name !== name) continue
  db.prepare(`DELETE FROM folder_items WHERE folder_id IN
    (SELECT id FROM folders WHERE company_id = ?)`).run(company.id)
  db.prepare(`DELETE FROM folders WHERE company_id = ?`).run(company.id)
  db.prepare(`DELETE FROM billing_ledger WHERE company_id = ?`).run(company.id)
  db.prepare(`DELETE FROM recruiters WHERE company_id = ?`).run(company.id)
  db.prepare(`DELETE FROM companies WHERE id = ?`).run(company.id)
}
check('test data removed', true, `${people.length} candidate(s), ${files} file(s)`)

finish()
