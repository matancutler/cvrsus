/**
 * The written half of an assessment, fetched when somebody opens it.
 *
 * The verdicts, the score, the strengths and the gaps are all on screen the
 * moment the dialog opens — they come with the search. What is missing is the
 * paragraph and the questions worth asking, and those are written on demand
 * because they used to be written for every candidate whether or not anybody
 * ever looked. A recruiter opens a handful of twenty-five results; the rest of
 * that writing was paid for and thrown away.
 *
 * Written once and stored, so the second time this asks about the same person
 * the server returns what it already has and spends nothing.
 */
import { useEffect, useState } from 'react'

import { post } from './api.js'

/**
 * @param request  `{ scope: 'search', jobId, candidateId }`
 *                 or `{ scope: 'triage', triageId, applicantId }`, or null to
 *                 ask for nothing — the dialog is shut, or this row was scored
 *                 without a model and has nothing to explain.
 * @param existing an explanation that arrived with the row, if one was already
 *                 written. Skips the request entirely.
 */
export function useExplanation(request, existing = null) {
  const [state, setState] = useState(existing ? 'ready' : 'idle')
  const [explain, setExplain] = useState(existing ?? null)

  /* The request as a string, so an object rebuilt on every render does not
     re-fire the effect. Dialogs rebuild their props constantly. */
  const key = request ? JSON.stringify(request) : null

  useEffect(() => {
    if (existing) {
      setExplain(existing)
      setState('ready')
      return undefined
    }

    if (!key) {
      setExplain(null)
      setState('idle')
      return undefined
    }

    /* A dialog closed mid-flight must not write into a component that has gone,
       and reopening a different candidate must not be overwritten by the
       previous one's answer arriving late. */
    let live = true
    setState('loading')

    post('/api/hr/analysis/explain', JSON.parse(key), 'recruiter')
      .then((data) => {
        if (!live) return
        setExplain(data.explain ?? null)
        setState(data.explain ? 'ready' : 'empty')
      })
      .catch(() => {
        /* Quietly. This is an addition to a panel that is already useful
           without it — an error banner over a page of verdicts would be a
           worse answer than simply not showing the extra section. */
        if (!live) return
        setExplain(null)
        setState('empty')
      })

    return () => { live = false }
  }, [key, existing])

  return {
    summary: explain?.summary ?? '',
    probes: explain?.probes ?? [],
    loading: state === 'loading',
  }
}
