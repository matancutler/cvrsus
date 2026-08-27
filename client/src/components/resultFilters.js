/**
 * The result-narrowing rules, kept apart from the component that renders them
 * so they are plain importable JavaScript — testable on their own, and reusable
 * anywhere results need the same treatment.
 */

export const EMPTY_RESULT_FILTERS = {
  availability: '',
  relocation: '',
  capacity: '',
  activity: '',
  hasCoverLetter: false,
  hasExtras: false,
  minScore: '',
  /* Where somebody stands on a shortlist. Only folders have one — a search
     result is nobody's pipeline yet — so it is simply never set elsewhere. */
  status: '',
  /* One of your team's own tags. Free text, so it is matched by label rather
     than by an id — the tags are the words, and there is nothing else to key
     them by. */
  tag: '',
}

/**
 * How recently the candidate has been around. Candidates who said no are
 * already absent from every result, so these only separate the ones still
 * turning up from the ones who went quiet.
 *
 * Said as activity rather than as confirmation: answering the monthly email is
 * one of two things that counts — signing in is the other — so "confirmed" named
 * the mechanism and under-described the state. The dot beside every name says
 * the same word.
 */
export const ACTIVITY_FILTERS = [
  { value: 'active', label: 'Active this month' },
  { value: 'unconfirmed', label: 'Not active (any)' },
  { value: 'stale2', label: 'Not active for 2+ months' },
  { value: 'stale6', label: 'Not active for 6+ months' },
]

/**
 * Narrowing already-returned results. Applied in the browser rather than by
 * re-running the search, so toggling a filter is instant and never re-scores.
 */
export function applyResultFilters(results, filters) {
  return results.filter((row) => {
    const { candidate, documents = [] } = row

    if (filters.tag) {
      const wanted = filters.tag.toLowerCase()
      const worn = (row.tags ?? []).some((tag) => tag.label.toLowerCase() === wanted)
      if (!worn) return false
    }

    if (filters.availability && candidate.availability !== filters.availability) return false

    if (filters.relocation === 'yes' && candidate.open_to_relocation !== true) return false
    if (filters.relocation === 'no' && candidate.open_to_relocation !== false) return false

    if (filters.capacity && candidate.capacity !== filters.capacity) return false

    if (filters.activity) {
      // A result with no activity data predates the check-in feature; treating
      // it as active keeps it visible rather than silently filtering it away.
      const state = row.activity?.state ?? 'active'
      const missed = row.activity?.missed ?? 0

      if (filters.activity === 'active' && state !== 'active') return false
      if (filters.activity === 'unconfirmed' && state !== 'unconfirmed') return false
      if (filters.activity === 'stale2' && missed < 2) return false
      if (filters.activity === 'stale6' && missed < 6) return false
    }

    if (filters.hasCoverLetter && !documents.includes('cover_letter')) return false

    if (filters.hasExtras && !documents.some((slot) => slot.startsWith('additional'))) return false

    /* Guarded on the row rather than the filter: folder items carry no score,
       and `undefined < 40` is false, so an unguarded compare would quietly let
       everything through a filter the caller was told was applied. Folders do
       not offer the field for exactly that reason. */
    if (filters.minScore !== '' && typeof row.score === 'number'
      && row.score < Number(filters.minScore)) return false

    if (filters.status && (row.status?.key ?? row.status) !== filters.status) return false

    return true
  })
}
