import { useEffect, useState } from 'react'
import {
  Link, NavLink, Navigate, Route, Routes, useLocation, useNavigationType,
} from 'react-router-dom'

import LiveDemo from './components/LiveDemo.jsx'
import MobileNav from './components/MobileNav.jsx'
import SignInMenu from './components/SignInMenu.jsx'
import SiteFooter from './components/SiteFooter.jsx'
import Wordmark from './components/Wordmark.jsx'
import { ChromeProvider, useChrome } from './chrome.jsx'
import CandidatePortal from './pages/CandidatePortal.jsx'
import CheckInPage from './pages/CheckInPage.jsx'
import HrPanel from './pages/HrPanel.jsx'
import InfoPage from './pages/InfoPage.jsx'
import InReviewPage from './pages/InReviewPage.jsx'
import PricingPage from './pages/PricingPage.jsx'
import UploadPage from './pages/UploadPage.jsx'

/**
 * Start a new page at its top.
 *
 * A client-side route change is not a page load, so nothing moves the viewport:
 * following Privacy Policy from the footer — which is by definition at the
 * bottom of a long page — dropped you the same distance down the policy, in the
 * middle of a clause. The scroll position belonged to the page you left.
 *
 * Three deliberate limits on when it fires:
 *
 * `pathname` only, not the whole location. The pricing page keeps its open tab
 * in the query string and the landing page reads `?join=`; those change the
 * search without changing the page, and yanking the reader to the top when they
 * pressed a tab would be its own bug.
 *
 * Not on POP — the browser restores the old position on back and forward, and
 * that is the behaviour people expect. Overriding it would mean reading half a
 * page, following a link, coming back, and having to find your place again.
 *
 * Instant rather than smooth: this is arrival at a new page, not travel within
 * one, and a page that visibly races upward on every navigation reads as a
 * glitch. `scrollTo` with an options object also covers the case where a
 * previous smooth scroll is still in flight — it cancels it.
 */
function ScrollToTop() {
  const { pathname } = useLocation()
  const navigationType = useNavigationType()

  useEffect(() => {
    if (navigationType === 'POP') return
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    // navigationType is intentionally not a dependency: it describes how we
    // arrived at this pathname, not a thing that should re-trigger a scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  return null
}

/**
 * The public site's chrome, and the routes inside it.
 *
 * Both bands disappear once a page declares itself a portal. That is not a
 * cosmetic preference: a signed-in recruiter is using software, and a marketing
 * header offering to sell them what they are already paying for — next to a
 * Sign in button they have visibly already used — is at best clutter and at
 * worst confusing. The portal supplies its own bar, holding the things that are
 * useful from inside: who you are, what you have left, and the way out.
 */
function Shell() {
  const { portal } = useChrome()
  // Owned here rather than inside MobileNav so the header can mark itself open
  // — the bar and the drawer are one control in two pieces.
  const [menuOpen, setMenuOpen] = useState(false)

  /*
   * The live demo, opened from the header.
   *
   * Held at the shell rather than on the landing page because the button that
   * opens it is now in the header, which outlives the route: a recruiter
   * reading About or Pricing can try a real role without first working out that
   * the demo lives on a different page. Route changes leave the overlay's own
   * state alone, so the search survives being opened from anywhere.
   */
  const [demoOpen, setDemoOpen] = useState(false)

  return (
    <div className={portal ? 'app app-portal' : 'app'}>
      {/* Renders nothing; exists to reset the viewport when the route changes.
          Above the header so it runs before anything on the new page can place
          itself — the landing card's own scroll, 120ms later, still wins. */}
      <ScrollToTop />

      {/*
        §1 — one full-bleed band of the logo's oxblood.

        The home icon is gone: the wordmark to its left already goes home, so
        the two sat next to each other doing the same job, and the icon was the
        one that had to explain itself. Destinations are centred; the right-hand
        side holds Sign in and nothing else.
      */}
      {!portal && (
        <header className="site-header">
          <div className="site-header-inner">
            <Link className="brand" to="/" aria-label="Cursus home">
              <Wordmark />
            </Link>

            {/*
              No Recruiters item. The landing page now asks "I am: Candidate or
              Recruiter" above the card, and Sign in already offers the recruiter
              door — a third route to the same place made the header look like it
              had two audiences when only the card ever did.
            */}
            {/* Pricing before Contact: it is what a recruiter comes to find out,
                and Contact is the last resort after the other two. */}
            <nav className="site-nav" aria-label="Main">
              <NavLink to="/about" className="nav-link">About</NavLink>
              <NavLink to="/pricing" className="nav-link">Pricing</NavLink>
              <NavLink to="/contact" className="nav-link">Contact</NavLink>
              {/*
                The demo, last in the row and dressed exactly like the items
                beside it. It is a button rather than a link because nothing
                about the page changes when it is pressed — it opens over
                whatever you were reading — but that is a fact about the
                mechanism, not something the header should announce with a
                different shape.
              */}
              <button type="button" className="nav-link nav-demo" onClick={() => setDemoOpen(true)}>
                Live Demo
              </button>
            </nav>

            <div className="site-actions">
              {/* Both are always rendered; CSS decides which width each belongs
                  to, so there is no viewport listener to get wrong and no flash
                  of the wrong one on first paint. */}
              <SignInMenu />
              <MobileNav
                open={menuOpen}
                onOpen={() => setMenuOpen(true)}
                onClose={() => setMenuOpen(false)}
                onDemo={() => setDemoOpen(true)}
              />
            </div>
          </div>
        </header>
      )}

      <main className={portal ? 'main main-portal' : 'main'}>
        <Routes>
          <Route path="/" element={<UploadPage />} />
          <Route path="/account" element={<CandidatePortal />} />
          <Route path="/hr" element={<HrPanel />} />
          {/* Reached from the monthly email; no session required. */}
          <Route path="/check-in/:token" element={<CheckInPage />} />
          <Route path="/privacy" element={<InfoPage page="privacy" />} />
          <Route path="/terms" element={<InfoPage page="terms" />} />
          <Route path="/about" element={<InfoPage page="about" />} />
          <Route path="/contact" element={<InfoPage page="contact" />} />
          {/* Where a company lands after registering. Public, because
              registering no longer signs anybody in. */}
          <Route path="/in-review" element={<InReviewPage />} />
          {/* Both products on one page, with the tab in the URL so a link can
              land on either — see Appendix A of the pricing model. */}
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {!portal && <SiteFooter />}

      {/*
        Mounted once, above the routes, and rendered through a portal to the
        body. Kept mounted while closed so a recruiter who dismisses it and
        opens it again — possibly from a different page — finds the search they
        already ran rather than an empty composer.
      */}
      <LiveDemo open={demoOpen} onClose={() => setDemoOpen(false)} />
    </div>
  )
}

export default function App() {
  return (
    <ChromeProvider>
      <Shell />
    </ChromeProvider>
  )
}
