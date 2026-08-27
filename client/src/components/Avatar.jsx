import { useState } from 'react'

/**
 * Somebody's photo, or their initials when there is none.
 *
 * The recruiter panel had its own version of this and the candidate portal had
 * none, which is how the account page ended up being the one screen that never
 * showed you the photo you had uploaded. One component, so the two cannot drift
 * and a third place that needs it does not become a third copy.
 *
 * `src` is passed in rather than built here: a recruiter's photo, a colleague's
 * and your own live at three different routes, and the component has no way to
 * know which of them applies.
 */
export default function Avatar({ src, firstName, lastName, size = 'normal' }) {
  /*
   * A src that 404s falls back to the initials rather than to a broken image.
   * The file can genuinely be gone — an upload swept, a photo deleted between
   * the payload and the render — and a broken-image glyph in a header is worse
   * than the initials that were the alternative anyway.
   */
  const [failed, setFailed] = useState(false)

  const initials = [firstName, lastName]
    .filter(Boolean)
    .map((part) => String(part)[0])
    .join('')
    .toUpperCase() || '?'

  /* 'xlarge' is the candidate portal's masthead, where the photo is the subject
     of the page rather than a marker in a list. */
  const sizes = { large: ' result-avatar-large', xlarge: ' result-avatar-xlarge' }

  return (
    <span className={`result-avatar${sizes[size] ?? ''}`}>
      {src && !failed
        ? <img src={src} alt="" onError={() => setFailed(true)} />
        : <span className="result-initials">{initials}</span>}
    </span>
  )
}
