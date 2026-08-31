/**
 * How much of the search history the rail shows.
 *
 * The rail is a way back to what you were just doing, not an archive — a
 * recruiter who runs twelve searches in a morning should not have to scroll
 * past all of them to reach yesterday's. Everything is still reachable: the ⋯
 * beside the heading opens the full list.
 *
 * Plain .js rather than part of the component, because this is arithmetic about
 * dates and it should be testable without a renderer.
 */

/** Groups searches the way a person thinks about them, not by raw timestamp. */
export function bucketOf(iso) {
  const then = new Date(iso)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.floor((startOfToday - new Date(then.getFullYear(), then.getMonth(), then.getDate())) / 86400000)

  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'Previous 7 days'
  if (days < 30) return 'Previous 30 days'
  return 'Older'
}

export const ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older']

/*
 * "Yesterday" and "Previous 7 days" share one allowance because they are one
 * stretch of time with two headings — capping them separately would put ten
 * searches from the past week on a rail under a rule meant to show five.
 */
const FAMILY = {
  Today: 'today',
  Yesterday: 'week',
  'Previous 7 days': 'week',
  'Previous 30 days': 'month',
  Older: 'older',
}

const CAPS = { today: 10, week: 5, month: 3, older: 3 }

/**
 * The rail's slice of the list: at most CAPS per stretch of time. Order is
 * preserved.
 *
 * There was a second mechanism here — FLOORS, "what the older stretches keep
 * even when today has filled its ten" — applied as
 * `Math.max(CAPS[family], FLOORS[family])` once today was full. Since every
 * floor was below its own cap, the max was always the cap and the branch could
 * not change a single row either way.
 *
 * It was also solving a problem this shape does not have. The allowances are
 * per stretch and independent: a morning with fifty searches in it fills
 * today's ten and takes nothing from the week's five, because the week's count
 * is its own. The guarantee the floors were written for is what the structure
 * already does.
 */
/**
 * @param stampOf which timestamp to bucket on. Defaults to updated_at, which is
 * what a search is filed under — for a search that is "when you last ran it",
 * a fact about the recruiter. It is the wrong field for a Triage: there
 * updated_at is written by the background worker three times per tranche of
 * 25 CVs, so a processing Triage would climb the rail on its own.
 */
export function railSlice(items, stampOf = (item) => item.updated_at) {
  const taken = { today: 0, week: 0, month: 0, older: 0 }

  return items.filter((item) => {
    const family = FAMILY[bucketOf(stampOf(item))]
    if (taken[family] >= CAPS[family]) return false
    taken[family] += 1
    return true
  })
}
