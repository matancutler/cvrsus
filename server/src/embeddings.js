import crypto from 'node:crypto'

import db from './db.js'

/**
 * Semantic retrieval: which candidates a job description is *about*, rather
 * than which ones repeat its words.
 *
 * A profile is turned into one vector — a point in meaning-space — when it is
 * created or edited. A search turns the job description into a vector the same
 * way and ranks by distance. "Shipped a Vue design system" lands near a React
 * role without anyone maintaining a synonym list, and "reacted quickly to
 * incidents" does not.
 *
 * This decides *which* profiles Claude reads in full, not how they score. Hard
 * facts — location, capacity, availability — are filtered exactly before this
 * runs, because "nearly full-time" is not a thing.
 *
 * Anthropic does not offer an embeddings endpoint; their documentation points
 * at Voyage AI, which is the provider implemented here. Without a key the
 * platform falls back to the keyword shortlist it used before, so nothing
 * breaks — searches are just worse at finding people who phrase things
 * differently.
 */

export const EMBEDDING_MODEL = process.env.VOYAGE_MODEL ?? 'voyage-3'
const ENDPOINT = 'https://api.voyageai.com/v1/embeddings'

export function isConfigured() {
  return Boolean(process.env.VOYAGE_API_KEY)
}

/**
 * `input_type` matters: the same text embedded as a document and as a query
 * lands in slightly different places, and the provider expects the asymmetry.
 * A CV is a document; a job description is the query searching for one.
 */
async function embed(texts, inputType, { signal } = {}) {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({ input: texts, model: EMBEDDING_MODEL, input_type: inputType }),
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`Embedding request failed (${response.status}): ${detail.slice(0, 200)}`)
  }

  const body = await response.json()
  const vectors = (body?.data ?? []).map((row) => row.embedding)
  if (vectors.length !== texts.length) {
    throw new Error(`Expected ${texts.length} embeddings, got ${vectors.length}`)
  }
  return vectors
}

export async function embedDocument(text, options) {
  return (await embed([text], 'document', options))[0]
}

export async function embedQuery(text, options) {
  return (await embed([text], 'query', options))[0]
}

// ------------------------------------------------------------ what we embed ---

/**
 * The text that represents a candidate.
 *
 * Structured fields first, then the CV — the extracted profile is the cleaner
 * signal, and truncation should bite on raw text rather than on a title. The
 * name is left out: it says nothing about capability and plenty about
 * ethnicity, and this decides who a recruiter is shown.
 */
export function profileText(candidate, profile) {
  const history = (profile?.employment_history ?? []).slice(0, 12).map((job) => (
    [job.title, job.company, job.summary].filter(Boolean).join(' — ')
  )).join('\n')

  const education = (profile?.education ?? []).slice(0, 6).map((item) => (
    [item.qualification, item.field, item.institution].filter(Boolean).join(', ')
  )).join('\n')

  return [
    profile?.current_title ?? candidate.current_title,
    profile?.seniority && `Seniority: ${profile.seniority}`,
    profile?.industry && `Industry: ${profile.industry}`,
    (profile?.skills ?? candidate.skills ?? []).join(', '),
    profile?.summary,
    history && `Experience:\n${history}`,
    education && `Education:\n${education}`,
    candidate.notes,
    candidate.cv_text && String(candidate.cv_text).slice(0, 8000),
  ].filter(Boolean).join('\n\n')
}

/** Changes when the meaning changes, so unchanged profiles are not re-embedded. */
export function sourceHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

// ------------------------------------------------------------------ storage ---

/** Float32 packs to a quarter the size of JSON and reads back without parsing. */
export function toBlob(vector) {
  return Buffer.from(Float32Array.from(vector).buffer)
}

export function fromBlob(blob) {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
}

export function storeEmbedding(candidateId, vector, hash) {
  db.prepare(`
    INSERT INTO embeddings (candidate_id, vector, dimensions, model, source_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (candidate_id) DO UPDATE SET
      vector = excluded.vector, dimensions = excluded.dimensions,
      model = excluded.model, source_hash = excluded.source_hash,
      created_at = excluded.created_at
  `).run(candidateId, toBlob(vector), vector.length, EMBEDDING_MODEL, hash, new Date().toISOString())
}

export function getEmbedding(candidateId) {
  const row = db.prepare(`SELECT * FROM embeddings WHERE candidate_id = ?`).get(candidateId)
  return row ? { ...row, vector: fromBlob(row.vector) } : null
}

/** Every stored vector, keyed by candidate — one read per search rather than N. */
export function allEmbeddings() {
  const map = new Map()
  for (const row of db.prepare(`SELECT candidate_id, vector, model FROM embeddings`).all()) {
    // A vector from a different model is not comparable; ignore it rather than
    // silently ranking against nonsense until it is regenerated.
    if (row.model !== EMBEDDING_MODEL) continue
    map.set(row.candidate_id, fromBlob(row.vector))
  }
  return map
}

// ---------------------------------------------------------------- similarity ---

/**
 * Cosine similarity. Voyage returns normalised vectors, but the magnitudes are
 * divided out anyway so this stays correct if that ever changes or a different
 * provider is swapped in.
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0

  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }

  if (magA === 0 || magB === 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

/**
 * Orders candidates by how close their profile sits to the role.
 *
 * Anyone without a usable vector keeps a null similarity and is sorted last
 * rather than dropped — a candidate who has not been embedded yet should not
 * become invisible because of it.
 */
export function rankBySimilarity(candidateIds, queryVector, vectors = allEmbeddings()) {
  return candidateIds
    .map((id) => {
      const vector = vectors.get(id)
      return { id, similarity: vector ? cosine(queryVector, vector) : null }
    })
    .sort((a, b) => {
      if (a.similarity === null && b.similarity === null) return 0
      if (a.similarity === null) return 1
      if (b.similarity === null) return -1
      return b.similarity - a.similarity
    })
}

/**
 * Embeds a candidate if their profile text has changed. Returns what happened
 * so the caller can log it without inspecting the database again.
 */
export async function refreshEmbedding(candidateId, text) {
  if (!isConfigured()) return { status: 'skipped', reason: 'not_configured' }
  if (!text || text.trim().length < 40) return { status: 'skipped', reason: 'too_little_text' }

  const hash = sourceHash(text)
  const existing = getEmbedding(candidateId)
  if (existing?.source_hash === hash && existing.model === EMBEDDING_MODEL) {
    return { status: 'unchanged' }
  }

  const vector = await embedDocument(text)
  storeEmbedding(candidateId, vector, hash)
  return { status: 'stored', dimensions: vector.length }
}
