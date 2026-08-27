/**
 * A plus, where a photograph could be added right now.
 *
 * The empty circle used to show a silhouette everywhere, on the reasoning that
 * an account which has not got round to a photo is not a to-do item. That is
 * true of an account being LOOKED at, and wrong of one being FILLED IN: on a
 * sign-up form the same silhouette said "there is no picture" when the only
 * thing worth saying was "put one here", and people read it as decoration and
 * walked past the control.
 *
 * So the two marks split by what the circle can do at that moment, not by who
 * is in it:
 *
 *   +               the picker is one click away — a form, or a profile being
 *                   edited, including one whose picture was just removed and
 *                   not yet saved. An instruction, because there is something
 *                   to do.
 *   PersonIcon      nothing to press. A profile being read, a result row, a
 *                   rail. A statement, because there is not.
 *
 * Drawn to match PersonIcon exactly — same viewBox, same stroke, same round
 * caps — so the two never look like marks from different sets when a page
 * switches between editing and reading.
 */
export default function AddPhotoIcon({ size = 18 }) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </svg>
  )
}
