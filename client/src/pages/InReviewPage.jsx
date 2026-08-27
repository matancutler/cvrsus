import { Link, useLocation } from 'react-router-dom'

/**
 * Where a company lands after registering.
 *
 * Registering no longer signs anybody in. The company key is the credential
 * every recruiter at the company signs in with, so releasing it before anyone
 * has looked at the account would make the review a formality behind a door
 * that was already open. It is handed over by whoever approves the company, to
 * the address and number proved during sign-up.
 *
 * That leaves a person who has just filled in a long form with nothing on
 * screen, which is the worst possible moment for silence. This page says three
 * things: it worked, here is what happens next, and here is where the answer
 * will arrive — read back from what they typed, so a mistyped address is
 * visible while it is still worth telling us about.
 *
 * The site header and footer are around it, because this is a public page and
 * they are not signed in.
 */
export default function InReviewPage() {
  const { state } = useLocation()

  const company = state?.company ?? null
  const email = state?.contact?.email ?? null
  const phone = state?.contact?.phone ?? null

  /*
   * Reachable without state — a refresh, a bookmark, a shared link. The page
   * still has to make sense then, so everything specific is optional and the
   * general version is the fallback rather than an error.
   */
  const contact = [email, phone].filter(Boolean).join(' or ')

  return (
    <article className="panel panel-narrow info-page review-page">
      <div className="review-mark" aria-hidden="true">✓</div>

      <h1>{company ? `${company.name} is in review` : 'Your account is in review'}</h1>

      <p className="lead">
        Thanks, the account is created. Our team checks every new company before it can see
        candidate profiles, and we will get back to you shortly.
      </p>

      <div className="review-next">
        <h2>What happens next</h2>
        <ol>
          <li>
            <strong>We review the company.</strong> Usually within one working day.
          </li>
          <li>
            <strong>We send your company key.</strong>{' '}
            {contact
              ? <>It goes to <strong>{contact}</strong>, the details you verified just now.</>
              : 'It goes to the email address and phone number you verified during sign-up.'}
          </li>
          <li>
            <strong>You sign in.</strong> That key, your username and your password are what get
            you and your colleagues in.
          </li>
        </ol>
      </div>

      {/* Said plainly rather than left to be discovered at a sign-in screen that
          refuses them: the key is the one thing they do not have yet, and
          without it "sign in" is not an instruction they can follow. */}
      <p className="muted">
        You cannot sign in until the key arrives. It is one of the three things the sign-in
        screen asks for. Nothing else is needed from you in the meantime.
      </p>

      <div className="about-cta">
        <Link className="btn btn-primary" to="/">Back to the home page</Link>
        <Link className="btn btn-outline" to="/contact">Contact us</Link>
      </div>
    </article>
  )
}
