/**
 * Which candidates your team has written notes about — shared by every comment
 * icon on the page.
 *
 * A result card needs to show that a note exists without opening the panel,
 * and the panel only loads its notes when opened. Asking per card would be
 * twenty-five requests for a page of results; this asks once, holds the answer,
 * and lets every icon read from it. Posting or deleting a note updates it in
 * place, so the dot appears and disappears without a reload.
 *
 * A colleague's new note elsewhere shows up on the next page load, which is the
 * right trade for a hint: it is never wrong about notes you wrote yourself.
 */
import { useEffect, useState } from 'react'

import { get, SESSION_ENDED, SIGNED_OUT } from './api.js'

let counts = null
let loading = null
const listeners = new Set()

function publish() {
  for (const listener of listeners) listener()
}

function ensureLoaded() {
  if (counts || loading) return
  loading = get('/api/hr/comments/commented', 'recruiter')
    .then((data) => {
      counts = new Map((data.commented ?? []).map((row) => [row.candidateId, row.count]))
    })
    .catch(() => {
      /* A hint that failed to load shows no dots, which is the state a page
         with no notes is in anyway. */
      counts = new Map()
    })
    .finally(() => {
      loading = null
      publish()
    })
}

/** How many notes this candidate has, as far as this page knows. */
export function useCommentCount(candidateId) {
  const [, rerender] = useState(0)

  useEffect(() => {
    const listener = () => rerender((n) => n + 1)
    listeners.add(listener)
    ensureLoaded()
    return () => { listeners.delete(listener) }
  }, [])

  return counts?.get(Number(candidateId)) ?? 0
}

/** Called after posting or deleting, with the notes the server now holds. */
export function setCommentCount(candidateId, count) {
  if (!counts) counts = new Map()
  if (count > 0) counts.set(Number(candidateId), count)
  else counts.delete(Number(candidateId))
  publish()
}

/**
 * Forgets everything, for a sign-out.
 *
 * The notes belong to one company. Without this, a second recruiter signing in
 * to a different organization in the same tab would see dots drawn from the
 * first one's notes.
 */
export function resetCommentCounts() {
  counts = null
  loading = null
  publish()
}

/* Both ways a recruiter session ends. Guarded so importing this outside a
   browser — a test reading the module — does not throw. */
if (typeof window !== 'undefined') {
  window.addEventListener(SIGNED_OUT, resetCommentCounts)
  window.addEventListener(SESSION_ENDED, resetCommentCounts)
}
