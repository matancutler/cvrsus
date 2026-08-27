/**
 * The locale dates are written in.
 *
 * Fixed rather than the reader's own. `toLocaleDateString(undefined, …)` uses
 * whatever the browser is set to, which put "10 août 2026" in the middle of an
 * English sentence for anyone with a French-configured machine — the interface
 * has no translations, so the date was the only word on the page that had been
 * localised, and it read as a bug rather than as a courtesy.
 *
 * en-GB for day-month order, which is what the rest of the product's audience
 * reads. When the interface is translated this becomes the active language and
 * every date follows it from one place.
 */
export const DATE_LOCALE = 'en-GB'

/** "10 Aug 2026" — the default for a date shown inside prose. */
export function formatDate(value, options = { dateStyle: 'medium' }) {
  if (!value) return ''
  return new Date(value).toLocaleDateString(DATE_LOCALE, options)
}

/** The same, with a clock — for a moment rather than a day. */
export function formatDateTime(value, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  if (!value) return ''
  return new Date(value).toLocaleString(DATE_LOCALE, options)
}

/**
 * A subscription date, in words rather than as a timestamp.
 *
 * "17 September 2026" and not "2026-09-17T12:15:29.000Z", which is what the
 * server sends and what nobody wants to read on the day they are deciding
 * whether to give a seat up.
 *
 * Falls back to "the end of the month" rather than to an empty string: the
 * sentence it sits inside is about when something takes effect, and a blank
 * there reads as "immediately", which is the opposite of what happened.
 */
export function formatSeatDate(iso) {
  if (!iso) return 'the end of the month'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'the end of the month'
  return date.toLocaleDateString(DATE_LOCALE, { day: 'numeric', month: 'long', year: 'numeric' })
}
