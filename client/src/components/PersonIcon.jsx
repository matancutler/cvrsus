/**
 * A person, where a photograph would be.
 *
 * The default picture for every account until somebody uploads one — a
 * candidate's, a recruiter's, and the masked cards in the live demo, which is
 * where this silhouette started. It replaced a "＋" on the profile pages: a plus
 * is an instruction, and an account that has simply not got round to a photo is
 * not a to-do item. The frame is still a button while a profile is being
 * edited, so nothing is lost by saying what is there rather than what to do.
 *
 * Sized by the caller through `size`, because the same mark appears at 18px in
 * a demo row and at half the width of an avatar on a profile.
 */
export default function PersonIcon({ size = 18 }) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <circle cx="12" cy="8" r="3.6" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </svg>
  )
}
