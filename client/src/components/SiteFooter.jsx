import { Link } from 'react-router-dom'

import Wordmark from './Wordmark.jsx'

/**
 * §9 asks for the Instagram glyph in place of the `ig` placeholder.
 *
 * All four are drawn rather than only that one: LinkedIn, Facebook and X were
 * text placeholders too, so swapping a single letter for a real mark would
 * leave one icon standing among three initials — which reads as a rendering
 * failure rather than as a set. Line art in currentColor, so they take the
 * footer's white without a second asset.
 */
const GLYPHS = {
  LinkedIn: (
    <>
      <path d="M6.2 9.4v8.4M6.2 6.3v.1" strokeLinecap="round" />
      <path d="M10.6 17.8V9.4m0 3.2c0-1.8 1.2-3 2.9-3s3.1 1.2 3.1 3.2v5.2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  Facebook: (
    <path
      d="M14.6 7.2h1.7M14.6 7.2c-1.2 0-2 .8-2 2v2.1m0 0h-2.6m2.6 0v6.5m0-6.5h2.7"
      strokeLinecap="round" strokeLinejoin="round"
    />
  ),
  Instagram: (
    <>
      <rect x="4.4" y="4.4" width="15.2" height="15.2" rx="4.6" />
      <circle cx="12" cy="12" r="3.7" />
      <circle cx="16.6" cy="7.4" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  X: (
    <path
      d="M5.2 5.2h2.9l10.7 13.6h-2.9zM18.4 5.2 5.6 18.8"
      strokeLinecap="round" strokeLinejoin="round"
    />
  ),
}

/**
 * Social destinations.
 *
 * Left empty deliberately: a link to a guessed handle is worse than no link,
 * because it either 404s or points at somebody else's account. An empty string
 * renders the glyph without an anchor, so the row still reads as complete while
 * the accounts are being set up. Fill these in and they become links with no
 * other change.
 */
const SOCIAL = [
  { name: 'LinkedIn', href: '' },
  { name: 'Facebook', href: '' },
  { name: 'Instagram', href: '' },
  { name: 'X', href: '' },
]

function Glyph({ name }) {
  return (
    <svg
      viewBox="0 0 24 24" width="17" height="17"
      fill="none" stroke="currentColor" strokeWidth="1.7"
      aria-hidden="true" focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  )
}

/**
 * A ground barely darker than the page, with everything on it in oxblood.
 *
 * About and Contact are deliberately absent: they live in the header, and
 * duplicating them here would give the same destination two homes and make the
 * footer look like navigation rather than the legal footing it is.
 */
export default function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          {/* Not inverted any more. The mark keeps its oxblood tile, which is
              the version drawn for a light ground. */}
          <Wordmark size={22} />
          {/* Cursus in running text, CVRSVS only as the wordmark beside it.
              The copyright line is a sentence, not a logo, so it takes the
              spelling the rest of the prose uses. */}
          <span className="muted">© {new Date().getFullYear()} Cursus</span>
        </div>

        <nav className="site-footer-links" aria-label="Legal">
          <Link to="/privacy">Privacy Policy</Link>
          <Link to="/terms">Terms of Service</Link>
        </nav>

        <ul className="site-footer-social">
          {SOCIAL.map(({ name, href }) => (
            <li key={name}>
              {href ? (
                <a href={href} aria-label={name} target="_blank" rel="noreferrer noopener">
                  <Glyph name={name} />
                </a>
              ) : (
                <span className="social-dim" aria-label={`${name} (coming soon)`}>
                  <Glyph name={name} />
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </footer>
  )
}
