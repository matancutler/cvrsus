#!/usr/bin/env node
/**
 * Candidate maintenance from the command line.
 *
 *   node server/scripts/candidates.mjs list [--search text] [--limit 50]
 *   node server/scripts/candidates.mjs show <id|email|phone>
 *   node server/scripts/candidates.mjs set <id|email> [--first X] [--last Y] [--email …]
 *                                            [--phone …] [--location …] [--availability …]
 *                                            [--capacity …] [--summary "…"]
 *                                            [--open-to-all true|false] [--tags "a, b"]
 *   node server/scripts/candidates.mjs activate <id|email>
 *   node server/scripts/candidates.mjs deactivate <id|email>
 *   node server/scripts/candidates.mjs delete <id|email> [--yes]
 *
 * There is no `add`. A candidate account is created by uploading a CV, and the
 * CV is the entire basis of their profile — a row inserted here without one
 * would be a person the matching system can say nothing about, appearing in
 * searches with no evidence behind them. Use the form at / instead.
 *
 * Editing goes through the same version bump the app uses, so a change to
 * anything matching depends on invalidates the cached analyses that were based
 * on the old values. Editing these fields with raw SQL does NOT do that, and
 * leaves recruiters looking at conclusions drawn from data that no longer
 * exists.
 */
import fs from 'node:fs'
import path from 'node:path'

import { SUMMARY_MAX_CHARS } from '../src/ai.js'
import db, { UPLOAD_DIR, getCandidate, updateCandidate } from '../src/db.js'
import {
  activityStatus, deactivate, deleteCandidateCompletely, deletionPreview,
  effectiveProfile, listDocuments, reactivate,
} from '../src/profiles.js'
import { MATCHING_RELEVANT_FIELDS } from '../src/matching/config.js'
import {
  buildIntelligence, bumpProfileVersion, getIntelligence, isMatchingRelevantChange,
} from '../src/matching/intelligence.js'
import { getPreferences, setPreferences, PreferenceError } from '../src/matching/preferences.js'

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
const value = (key) => (flags.get(key) === true ? fail(`--${key} needs a value.`) : flags.get(key))

/** Id, email, or the last nine digits of a phone number. */
function resolveCandidate(token) {
  if (!token) fail('Which candidate? Pass an id, an email address or a phone number.')

  if (/^\d+$/.test(token)) {
    const byId = getCandidate(Number(token))
    if (byId) return byId
  }

  const byEmail = db.prepare(`SELECT * FROM candidates WHERE email = ? COLLATE NOCASE`).all(token)
  if (byEmail.length === 1) return getCandidate(byEmail[0].id)
  if (byEmail.length > 1) fail(`"${token}" matches ${byEmail.length} accounts. Use the id.`)

  const digits = String(token).replace(/\D/g, '').slice(-9)
  if (digits.length === 9) {
    const rows = db.prepare(`SELECT id, phone FROM candidates WHERE phone IS NOT NULL`).all()
      .filter((row) => String(row.phone).replace(/\D/g, '').endsWith(digits))
    if (rows.length === 1) return getCandidate(rows[0].id)
    if (rows.length > 1) fail(`That number matches ${rows.length} accounts. Use the id.`)
  }

  return fail(`No candidate matches "${token}".`)
}

// ------------------------------------------------------------------ list ---

if (command === 'list' || command === undefined) {
  const search = value('search')
  const limit = Number(value('limit') ?? 50)

  const rows = db.prepare(`
    SELECT id, first_name, last_name, email, location, created_at, deactivated_at, profile_version
    FROM candidates
    ${search ? `WHERE first_name LIKE @q OR last_name LIKE @q OR email LIKE @q OR location LIKE @q` : ''}
    ORDER BY id DESC LIMIT @limit
  `).all({ q: `%${search ?? ''}%`, limit })

  if (rows.length === 0) console.log('\n  No candidates.\n')
  else {
    console.log('')
    console.log('  id    name                  email                           v   status')
    console.log('  ----  --------------------  ------------------------------  --  ------')
    for (const row of rows) {
      console.log(
        `  ${String(row.id).padEnd(4)}  ${`${row.first_name} ${row.last_name}`.slice(0, 20).padEnd(20)}  `
        + `${String(row.email).slice(0, 30).padEnd(30)}  `
        + `${String(row.profile_version ?? 1).padEnd(2)}  `
        + `${row.deactivated_at ? 'deactivated' : 'active'}`,
      )
    }
    console.log(`\n  ${rows.length} shown.\n`)
  }
}

// ------------------------------------------------------------------ show ---

else if (command === 'show') {
  const candidate = resolveCandidate(args[0])
  const profile = effectiveProfile(candidate.id)
  const preferences = getPreferences(candidate.id)
  const intelligence = getIntelligence(candidate.id)

  console.log(`\n  ${candidate.first_name} ${candidate.last_name}  (id ${candidate.id})`)
  console.log(`  email        : ${candidate.email}`)
  console.log(`  phone        : ${candidate.phone}`)
  console.log(`  location     : ${candidate.location ?? '—'}`)
  console.log(`  availability : ${candidate.availability ?? '—'}   capacity: ${candidate.capacity ?? '—'}`)
  console.log(`  applied      : ${candidate.created_at}`)
  console.log(`  activity     : ${activityStatus(candidate).label}`)
  console.log(`  profile ver  : ${candidate.profile_version ?? 1}`)
  console.log(`  summary      : ${candidate.notes ? `${candidate.notes.slice(0, 90)}…` : '(none written)'}`)
  console.log(`\n  open to all  : ${preferences.openToAll ? 'yes' : 'no'}`)
  if (!preferences.openToAll) {
    console.log(`  interests    : ${preferences.tags.map((t) => t.raw).join(', ') || '(none)'}`)
  }
  console.log(`  documents    : ${listDocuments(candidate.id).map((d) => d.slot).join(', ') || '(none)'}`)
  console.log(`  extracted    : ${profile.extractionSource ?? '(not yet)'}  title: ${profile.current_title ?? '—'}`)
  console.log(`  labels       : ${(intelligence?.labels ?? []).map((l) => l.conceptId).join(', ') || '(none)'}`)
  console.log(`\n  attached: ${JSON.stringify(deletionPreview(candidate.id))}\n`)
}

// ------------------------------------------------------------------- set ---

else if (command === 'set') {
  const candidate = resolveCandidate(args[0])
  const changes = {}

  const map = {
    first: 'first_name', last: 'last_name', email: 'email', phone: 'phone',
    location: 'location', availability: 'availability', capacity: 'capacity',
    summary: 'notes',
  }

  for (const [flag, column] of Object.entries(map)) {
    if (!flags.has(flag)) continue
    const next = value(flag)
    changes[column] = next === '' ? null : next
  }

  if ('notes' in changes && changes.notes && changes.notes.length > SUMMARY_MAX_CHARS) {
    fail(`A professional summary is capped at ${SUMMARY_MAX_CHARS} characters; that one is ${changes.notes.length}.`)
  }

  if (changes.first_name || changes.last_name) {
    changes.name = [
      changes.first_name ?? candidate.first_name,
      candidate.middle_name,
      changes.last_name ?? candidate.last_name,
    ].filter(Boolean).join(' ')
  }

  // Preferences live in their own table and are validated together.
  let preferencesChanged = false
  if (flags.has('open-to-all') || flags.has('tags')) {
    const before = getPreferences(candidate.id)
    const openToAll = flags.has('open-to-all')
      ? !['false', 'no', '0'].includes(String(value('open-to-all')).toLowerCase())
      : before.openToAll
    const tags = flags.has('tags')
      ? String(value('tags')).split(',').map((t) => t.trim()).filter(Boolean)
      : before.tags.map((t) => t.raw)

    try {
      setPreferences(candidate.id, { openToAll, tags })
    } catch (error) {
      if (error instanceof PreferenceError) fail(error.message)
      throw error
    }
    preferencesChanged = true
  }

  if (Object.keys(changes).length === 0 && !preferencesChanged) {
    fail('Nothing to change. See --help for the fields you can set.')
  }

  if (Object.keys(changes).length > 0) updateCandidate(candidate.id, changes)

  /*
   * The same rule the app applies (§6.1/§6.2): only a change matching depends
   * on moves the version and rebuilds the interpretation. Correcting a typo in
   * an email address must not throw away analyses somebody paid for.
   */
  const matters = preferencesChanged || isMatchingRelevantChange(candidate, changes)
  if (matters) {
    const version = bumpProfileVersion(candidate.id)
    buildIntelligence(candidate.id)
    console.log(`\n  Updated. Matching-relevant, so the profile is now version ${version}`)
    console.log('  and cached job analyses from the previous version will not be reused.')
  } else {
    console.log('\n  Updated. Nothing matching depends on changed, so no analysis was invalidated.')
  }

  console.log(`  fields: ${[...Object.keys(changes), ...(preferencesChanged ? ['preferences'] : [])].join(', ')}`)
  console.log(`\n  Note: the CV is unchanged. Re-extraction only happens when a new CV is uploaded.\n`)
}

// ------------------------------------------------------ activate / suspend ---

else if (command === 'activate' || command === 'deactivate') {
  const candidate = resolveCandidate(args[0])
  const off = command === 'deactivate'

  /*
   * Through the app's own helpers, not a direct UPDATE.
   *
   * Visibility is decided by `hidden_from_search`, while `deactivated_at` only
   * records when it happened — so setting the timestamp alone looks like it
   * worked and changes nothing. Reactivating also has to clear the missed
   * check-in counter, or the profile comes back already carrying months of
   * "not confirmed".
   */
  if (off) deactivate(candidate.id)
  else reactivate(candidate.id)

  console.log(`\n  ${candidate.first_name} ${candidate.last_name} is now `
    + `${off ? 'deactivated — hidden from every recruiter search' : 'active and searchable again'}.`)
  console.log('  This is the same state their own account page controls.\n')
}

// ---------------------------------------------------------------- delete ---

else if (command === 'delete') {
  const candidate = resolveCandidate(args[0])
  const preview = deletionPreview(candidate.id)
  const confirmed = flags.get('yes') === true

  console.log(`\n  ${confirmed ? 'Deleting' : 'Would delete'} ${candidate.first_name} ${candidate.last_name}`
    + ` <${candidate.email}> (id ${candidate.id}):`)
  console.log(`    ${JSON.stringify(preview)}`)
  console.log('    plus their CV, extracted facts, profile intelligence and every cached analysis.')
  console.log('\n  This is irreversible and is what an erasure request requires.');

  if (!confirmed) {
    console.log(`\n  Nothing was changed. Re-run with --yes:`)
    console.log(`    node server/scripts/candidates.mjs delete ${candidate.id} --yes\n`)
    process.exit(0)
  }

  const files = deleteCandidateCompletely(candidate.id)
  let removed = 0
  for (const name of files) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, name)); removed += 1 } catch { /* already gone */ }
  }

  console.log(`\n  Deleted, along with ${removed} file(s) from disk.\n`)
}

else {
  console.log(`
  Candidate maintenance

    list [--search text] [--limit 50]     recent candidates
    show <id|email|phone>                 one profile and everything attached
    set <id|email> --first X --last Y     edit fields
        --email … --phone … --location …
        --availability … --capacity …
        --summary "…"                     (max ${SUMMARY_MAX_CHARS} characters)
        --open-to-all true|false
        --tags "fintech, security"
    activate | deactivate <id|email>      searchable, or hidden from recruiters
    delete <id|email> [--yes]             dry run without --yes

  Matching-relevant fields (${MATCHING_RELEVANT_FIELDS.slice(0, 4).join(', ')}, …)
  bump the profile version and rebuild the interpretation, exactly as the app
  does. Editing them with raw SQL does not, and leaves stale analyses in place.

  There is no "add" — an account comes from a CV upload at /.
`)
  process.exit(command ? 1 : 0)
}

db.close()
