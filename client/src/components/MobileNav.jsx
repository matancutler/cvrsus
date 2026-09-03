import { useEffect, useRef } from 'react'

import useDismissOnOutside from '../useDismiss.js'
import { Link, NavLink, useLocation } from 'react-router-dom'

import Wordmark from './Wordmark.jsx'

/**
 * The header on a phone: a wordmark and a hamburger, and a drawer behind it.
 *
 * Below 900px the three-column header had been wrapping into two rows — the
 * nav dropping under the logo — which cost a whole band of a screen that has
 * none to spare and left the bar looking like a mistake rather than a choice.
 * One line and a button is the convention, and the drawer is where the
 * destinations go.
 *
 * The drawer is a dialog, and behaves like one: it traps nothing it should not,
 * closes on Escape, on the backdrop, and on arriving anywhere — and while it is
 * open the page behind it does not scroll, which is the difference between a
 * panel and a thing that slides around under your thumb.
 */

function Chevron() {
  return (
    <svg
      className="drawer-chevron" viewBox="0 0 24 24" width="18" height="18"
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24" width="20" height="20"
      fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

/** The destinations, in the header's order plus Home — which the wordmark
    normally carries, and the wordmark is inside the drawer here. */
const LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/about', label: 'About' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/contact', label: 'Contact' },
]

export default function MobileNav({ open, onOpen, onClose, onDemo }) {
  const { pathname } = useLocation()
  const panel = useRef(null)
  const toggle = useRef(null)

  /* A press on the page behind the drawer closes it, as it does for every other
     popup. Escape already did; a tap did not, so the one gesture everybody
     tries on a drawer was the one that did nothing. */
  useDismissOnOutside({
    ref: panel,
    trigger: toggle,
    onDismiss: onClose,
    active: open,
  })

  // Arriving somewhere is the end of navigating, so the drawer closes itself
  // rather than needing every link to remember to.
  useEffect(() => { onClose() }, [pathname])

  useEffect(() => {
    if (!open) return undefined

    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      onClose()
      // Escape has to hand focus back, or it is left on a panel that is gone.
      toggle.current?.focus()
    }

    /*
     * The page behind must not scroll. Without this, a flick anywhere over the
     * backdrop scrolls the document under the drawer, which reads as the panel
     * having come loose from the page.
     */
    const { overflow } = document.body.style
    document.body.style.overflow = 'hidden'
    document.addEventListener('keydown', onKeyDown)

    // Focus into the panel so a keyboard lands inside it rather than behind.
    panel.current?.querySelector('a, button')?.focus()

    return () => {
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, onClose])

  return (
    <>
      <button
        ref={toggle}
        type="button"
        className="nav-toggle"
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="mobile-drawer"
        onClick={onOpen}
      >
        {/* Three lines, drawn rather than typed: the ☰ character renders at a
            different weight in every font and sits off-centre in most. */}
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      {/* Rendered only when open: a permanently mounted drawer is a permanent
          set of tab stops sitting off-screen. */}
      {open && (
        <div className="drawer-backdrop" onClick={onClose}>
          <div
            id="mobile-drawer"
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            ref={panel}
            // The backdrop closes; the panel is not the backdrop.
            onClick={(event) => event.stopPropagation()}
          >
            <div className="drawer-head">
              <Wordmark size={22} />
              <button type="button" className="drawer-close" aria-label="Close menu" onClick={onClose}>
                <CloseIcon />
              </button>
            </div>

            <nav className="drawer-links" aria-label="Main">
              {LINKS.map((link) => (
                <NavLink key={link.to} to={link.to} end={link.end} className="drawer-link">
                  {link.label}
                  <Chevron />
                </NavLink>
              ))}
              {/* The demo, with the destinations because that is where a
                  recruiter looks for it — but it opens over the page rather
                  than going anywhere, so the drawer closes first and no chevron
                  promises a new screen. */}
              {onDemo && (
                <button
                  type="button"
                  className="drawer-link"
                  onClick={() => { onClose(); onDemo() }}
                >
                  Live Demo
                </button>
              )}
            </nav>

            {/*
              Two doors rather than one "Sign in".
              A candidate and a recruiter sign in to different products with
              different credentials, so the choice has to happen somewhere —
              and a drawer has room to make it here instead of behind another
              tap, which is what the header dropdown does on desktop.
            */}
            <div className="drawer-actions">
              <Link className="btn btn-primary btn-block" to="/account">
                Candidate sign in
              </Link>
              <Link className="btn btn-outline btn-block" to="/hr">
                Recruiter sign in
              </Link>
              <p className="drawer-note">
                New here? <Link to="/">Create an account</Link>. It takes under two minutes.
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
