/**
 * The eye. Pricing §5.
 *
 * One symbol, one meaning: revealing a candidate's contact details. It appears
 * on the reveal button, on the balance in the header, and beside a Reveal Pack
 * — and nowhere near seats, team management or anything else, because an icon
 * that means two things means neither.
 *
 * A component rather than a copied path so that stays true: there is one place
 * the mark is drawn, and using it anywhere else is a visible decision.
 */
export default function EyeIcon({ size = 16, className = '', ...rest }) {
  return (
    <svg
      className={`eye-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative by default: the label beside it already says what it does,
      // so a screen reader announcing "eye" would only repeat the button.
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d="M1.6 12S5.3 5.2 12 5.2 22.4 12 22.4 12 18.7 18.8 12 18.8 1.6 12 1.6 12Z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  )
}
