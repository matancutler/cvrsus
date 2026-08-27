
import Wordmark from './Wordmark.jsx'

/**
 * The signed-in bar, in place of the site header.
 *
 * When the marketing chrome goes, two things it was quietly doing have to be
 * picked up: saying which product you are looking at, and giving you a way out
 * of it. Everything else it carried — About, Pricing, Contact, Sign in — is
 * either irrelevant to somebody already inside or, in Sign in's case, actively
 * wrong.
 *
 * So this is deliberately thin. A wordmark, a name for the workspace, whatever
 * that workspace needs at hand, and Sign out. It is not navigation: the tabs
 * below it are, and a second row of destinations above them would put two
 * competing menus on one screen.
 *
 * The wordmark does not link home. Inside a portal, a logo that navigates to a
 * marketing page is a trapdoor — the enterprise convention is that it returns
 * you to the workspace root, and here that is the page you are already on.
 */
export default function PortalBar({ label, children, onSignOut }) {
  return (
    <div className="portal-bar">
      <div className="portal-bar-inner">
        <div className="portal-bar-brand">
          <Wordmark size={20} />
          {label && <span className="portal-bar-label">{label}</span>}
        </div>

        <div className="portal-bar-actions">
          {children}
          <button type="button" className="btn btn-quiet btn-small" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}

/*
 * There is no PortalLink any more.
 *
 * It was the one link back to the public site, for a recruiter on their way to
 * Pricing. Buying moved into the workspace — Billing opens as a dialog over
 * whatever you were doing — so the link had no page left to be on, and it was
 * exported, imported by HrPanel and rendered nowhere for some time.
 */
