/**
 * §4 — the required-field marker, site-wide.
 *
 * Its own component rather than an asterisk typed into each label string. That
 * is what removes the space before it in one place ("CV *" became "CV*"), gives
 * it its red in one place, and keeps it out of the accessible name — a literal
 * asterisk in the text made screen readers announce the field as "CV star".
 *
 * It lives in its own module because the candidate form, the contact form and
 * the recruiter sign-up all need it, and importing the entire application form
 * to borrow one span would drag that module onto every page that has a
 * required field.
 */
export default function Req() {
  return <span className="req" aria-hidden="true">*</span>
}
