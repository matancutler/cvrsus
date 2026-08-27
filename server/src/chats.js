import db from './db.js'

/**
 * Saved searches (spec §6.3 — "Chats saved and listed").
 *
 * A chat stores what the recruiter asked and what the system understood, not
 * the results. Candidates come and go, so reopening a search re-runs it: a
 * frozen result list would quietly go stale and start lying.
 */
const MAX_TITLE = 60

export function createSearchChat(recruiterId, { title, query, folderId = null } = {}) {
  const now = new Date().toISOString()
  const info = db.prepare(`
    INSERT INTO search_chats (recruiter_id, title, folder_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(recruiterId, uniqueTitle(recruiterId, title, query), folderId, now, now)

  return Number(info.lastInsertRowid)
}

export function setChatFolder(chatId, folderId) {
  db.prepare(`UPDATE search_chats SET folder_id = ? WHERE id = ?`).run(folderId, chatId)
}

/** Whitespace-collapsed first line, trimmed to something that fits a sidebar. */
function titleFrom(query) {
  const text = String(query ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return 'Untitled search'
  return text.length <= MAX_TITLE ? text : `${text.slice(0, MAX_TITLE - 1).trimEnd()}…`
}

/**
 * The search's name: the job title the parser detected, falling back to the
 * first line of the description when it found none.
 *
 * Recruiters run the same role repeatedly, so a bare title collides constantly.
 * A repeat gets the date appended, and a repeat on the same day gets a sequence
 * number too — enough to tell "Senior Frontend Engineer" hired in March from
 * the reopened one in August, without dating a title that is already unique.
 */
export function uniqueTitle(recruiterId, title, query) {
  const base = String(title ?? '').replace(/\s+/g, ' ').trim() || titleFrom(query)
  const taken = new Set(db.prepare(
    `SELECT title FROM search_chats WHERE recruiter_id = ?`,
  ).all(recruiterId).map((row) => row.title))

  if (!taken.has(base)) return base

  const dated = `${base} · ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
  if (!taken.has(dated)) return dated

  for (let n = 2; ; n += 1) {
    const numbered = `${dated} (${n})`
    if (!taken.has(numbered)) return numbered
  }
}

export function appendTurn(chatId, { role, content, results = null }) {
  db.prepare(`
    INSERT INTO search_chat_turns (chat_id, role, content, results, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(chatId, role, content, results === null ? null : JSON.stringify(results), new Date().toISOString())

  db.prepare(`UPDATE search_chats SET updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), chatId)
}

export function listSearchChats(recruiterId) {
  return db.prepare(`
    SELECT c.id, c.title, c.folder_id, c.created_at, c.updated_at,
           (SELECT COUNT(*) FROM search_chat_turns t WHERE t.chat_id = c.id AND t.role = 'user') AS searches,
           (SELECT COUNT(*) FROM folder_items fi WHERE fi.folder_id = c.folder_id) AS saved
    FROM search_chats c
    WHERE c.recruiter_id = ?
    ORDER BY c.updated_at DESC
  `).all(recruiterId)
}

/** Scoped by recruiter, so one recruiter can never open another's search. */
export function getSearchChat(recruiterId, chatId) {
  const chat = db.prepare(
    `SELECT * FROM search_chats WHERE id = ? AND recruiter_id = ?`,
  ).get(chatId, recruiterId)
  if (!chat) return null

  const turns = db.prepare(`
    SELECT id, role, content, results, created_at
    FROM search_chat_turns WHERE chat_id = ? ORDER BY created_at, id
  `).all(chatId).map((turn) => ({
    ...turn,
    results: turn.results ? safeParse(turn.results) : null,
  }))

  return { ...chat, turns }
}

export function renameSearchChat(recruiterId, chatId, title) {
  return db.prepare(
    `UPDATE search_chats SET title = ? WHERE id = ? AND recruiter_id = ?`,
  ).run(titleFrom(title), chatId, recruiterId).changes > 0
}

/**
 * Ruled out, for this search only.
 *
 * Ownership is checked by the caller against the chat, which is what scopes
 * this to one recruiter — the table itself only knows chat ids.
 */
export function dismissCandidate(chatId, candidateId) {
  db.prepare(`
    INSERT OR IGNORE INTO search_dismissals (chat_id, candidate_id, created_at)
    VALUES (?, ?, ?)
  `).run(chatId, candidateId, new Date().toISOString())
}

/** Undoes it, because "not relevant" is a judgement and judgements change. */
export function restoreCandidate(chatId, candidateId) {
  db.prepare(`DELETE FROM search_dismissals WHERE chat_id = ? AND candidate_id = ?`)
    .run(chatId, candidateId)
}

/** Everyone ruled out of one search. Empty for a search with no chat yet. */
export function dismissedCandidateIds(chatId) {
  if (!chatId) return []
  return db.prepare(`SELECT candidate_id FROM search_dismissals WHERE chat_id = ?`)
    .all(chatId).map((row) => row.candidate_id)
}

export function deleteSearchChat(recruiterId, chatId) {
  const owned = db.prepare(
    `SELECT 1 FROM search_chats WHERE id = ? AND recruiter_id = ?`,
  ).get(chatId, recruiterId)
  if (!owned) return false

  db.prepare(`DELETE FROM search_chat_turns WHERE chat_id = ?`).run(chatId)
  db.prepare(`DELETE FROM search_dismissals WHERE chat_id = ?`).run(chatId)
  db.prepare(`DELETE FROM search_chats WHERE id = ?`).run(chatId)
  return true
}

function safeParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
