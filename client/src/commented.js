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
 *
 * ---
 *
 * WHY EVERY ENTRY IS SCOPED
 *
 * Two different kinds of thing are commented on, and their ids are two
 * independent sequences that collide constantly: a marketplace candidate, and
 * a Triage applicant. This map was keyed on the number alone and loaded only
 * from the marketplace endpoint, so Triage applicant #42 wore a dot when
 * candidate #42 had notes and wore nothing when it had notes of its own — and
 * worse in the other direction, writing a note on applicant #42 set the count
 * for candidate #42 and put a dot on a stranger in Search, Folders and Reveal
 * History for the rest of the session.
 *
 * The scope is part of the key. Nothing else changed.
 */
import { useEffect, useState } from 'react'

import { get, SESSION_ENDED, SIGNED_OUT } from './api.js'

let counts = null
let loading = null

/*
 * Subscribers by key, not one list of everybody.
 *
 * Every comment icon on the page held a listener in a single set, and any
 * change woke all of them. Triage seeds a whole scope on every 2.5-second poll,
 * so one unchanged poll re-rendered every comment button on screen — twenty-five
 * of them, twenty-four times a minute, to show counts that had not moved.
 *
 * Keyed subscription means a count that changes wakes the one icon that shows
 * it. `all` is for the two events that genuinely affect everything: the shared
 * endpoint arriving, and a sign-out clearing the map.
 */
const byKey = new Map()
const all = new Set()

function wake(listeners) {
  if (!listeners) return
  for (const listener of listeners) listener()
}

function publish(keys) {
  if (!keys) {
    wake(all)
    for (const listeners of byKey.values()) wake(listeners)
    return
  }
  for (const key of keys) wake(byKey.get(key))
  wake(all)
}

/* One key space for two id sequences that overlap. */
const key = (id, scope) => `${scope}:${Number(id)}`

function ensureLoaded() {
  if (counts || loading) return
  loading = get('/api/hr/comments/commented', 'recruiter')
    .then((data) => {
      counts = new Map((data.commented ?? []).map(
        (row) => [key(row.candidateId, 'candidate'), row.count],
      ))
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

/**
 * How many notes this thing has, as far as this page knows.
 *
 * `scope` says what kind of thing the id names. It defaults to 'candidate'
 * because that is what the shared endpoint returns and what every marketplace
 * surface asks about; Triage passes 'triage' and seeds its own counts from the
 * index the results page already sends.
 */
export function useCommentCount(candidateId, scope = 'candidate') {
  const [, rerender] = useState(0)
  const mine = key(candidateId, scope)

  useEffect(() => {
    const listener = () => rerender((n) => n + 1)
    let listeners = byKey.get(mine)
    if (!listeners) {
      listeners = new Set()
      byKey.set(mine, listeners)
    }
    listeners.add(listener)
    ensureLoaded()

    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) byKey.delete(mine)
    }
  }, [mine])

  return counts?.get(mine) ?? 0
}

/** Called after posting or deleting, with the notes the server now holds. */
export function setCommentCount(candidateId, count, scope = 'candidate') {
  if (!counts) counts = new Map()
  const at = key(candidateId, scope)
  if (count > 0) counts.set(at, count)
  else counts.delete(at)
  publish([at])
}

/**
 * Primes a whole scope from an index the server already sent.
 *
 * The Triage results payload carries `commented` — applicant id to note count
 * — computed for the whole session. Without this the Triage dots would have to
 * be fetched per row, or be wrong, and they were wrong.
 *
 * Merged rather than replacing the map, because the marketplace scope in it is
 * loaded from somewhere else and both are on screen at once.
 */
export function seedCommentCounts(index, scope) {
  if (!index) return
  if (!counts) counts = new Map()

  /* Only what moved. This runs on a 2.5-second poll and the counts are almost
     always identical to the ones already held, so publishing unconditionally
     meant re-rendering every icon on the page to redraw the same dots. */
  const changed = []
  for (const [id, count] of Object.entries(index)) {
    const at = key(id, scope)
    const was = counts.get(at) ?? 0
    if (was === count) continue
    if (count > 0) counts.set(at, count)
    else counts.delete(at)
    changed.push(at)
  }

  if (changed.length > 0) publish(changed)
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
