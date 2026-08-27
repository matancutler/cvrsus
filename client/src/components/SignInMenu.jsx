import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

/**
 * §1 — Sign in, as a boxed button that opens onto the two doors.
 *
 * A candidate and a recruiter sign in to different products with different
 * credentials, so the branch has to happen somewhere. Making it happen here
 * means neither sign-in screen has to open by asking who you are, and the
 * header keeps one control on the right instead of two links that look alike
 * and go to unrelated places.
 */
export default function SignInMenu() {
  const [open, setOpen] = useState(false)
  const wrap = useRef(null)

  /**
   * Close on anything that means "I am done with this": a click elsewhere, or
   * Escape. Without the outside-click half the menu survives navigation to a
   * page in the background and hangs over it.
   */
  useEffect(() => {
    if (!open) return undefined

    const onPointerDown = (event) => {
      if (!wrap.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      // Escape has to hand focus back, or it is left on a menu that is gone.
      wrap.current?.querySelector('.site-signin-toggle')?.focus()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="site-signin" ref={wrap}>
      <button
        type="button"
        className="site-signin-toggle"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((was) => !was)}
      >
        Sign in
        <svg
          className="site-signin-caret" viewBox="0 0 24 24" width="14" height="14"
          aria-hidden="true" focusable="false"
        >
          <path
            d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.4"
            strokeLinecap="round" strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div className="site-signin-menu" role="menu">
          <Link role="menuitem" to="/account" onClick={() => setOpen(false)}>
            Candidate
            <span className="muted">Your profile and messages</span>
          </Link>
          <Link role="menuitem" to="/hr" onClick={() => setOpen(false)}>
            Recruiter
            <span className="muted">Search and hire</span>
          </Link>
        </div>
      )}
    </div>
  )
}
