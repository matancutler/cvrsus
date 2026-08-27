/**
 * The pencil and the tick, in one place.
 *
 * Two profiles now use the same edit-then-save control — the candidate's and
 * the recruiter's — and a pencil that is 15px and 1.9-weight on one page and
 * something slightly different on the other is the kind of drift nobody
 * notices until both are on screen at once.
 */

/** The pencil: this can be changed. */
export function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z" />
      <path d="M14.5 6.5 17.5 9.5" />
    </svg>
  )
}

/** The tick: done, save it. */
export function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  )
}
