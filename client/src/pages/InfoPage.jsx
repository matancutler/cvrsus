import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import Req from '../components/Req.jsx'
import { DRAFT_NOTICE, LEGAL_DOCUMENTS } from '../legal/legalDocuments.jsx'
import { post } from '../api.js'

/**
 * The pages the footer and the header link to.
 *
 * Privacy Policy and Terms of Service used to be deliberately unwritten — the
 * route and the layout were ready and the text was not, and inventing clauses
 * would have produced a page that reads like a policy while promising things
 * nobody had agreed to. The drafts now exist, so they are rendered in full.
 *
 * Neither is restated here. Both come from legal/legalDocuments.jsx, which is
 * also what the consent checkbox on the two account-creation forms opens. The
 * document somebody agreed to at sign-up and the document they can read
 * afterwards have to be the same one, and the only way to guarantee that is for
 * there to be one of it.
 */
const PAGES = {
  privacy: { legal: 'privacy' },
  terms: { legal: 'terms' },
  // Pricing has real numbers now and its own page, PricingPage.jsx.
  contact: { title: 'Contact', body: null },
}

/**
 * §12 — the reasons someone writes to us.
 *
 * Listed here rather than left as a free-text subject line so the messages can
 * be routed without reading every one. The set still needs confirming with
 * whoever answers this inbox — it is drawn from what the page already said it
 * was for.
 */
const CONTACT_REASONS = [
  'A question about my profile',
  'A question about my data or privacy',
  'Hiring on Cursus',
  /* Named separately from ordinary hiring: a company asking about volume,
     invoicing or a negotiated rate is not asking the same question as a
     recruiter with one role to fill, and it should not have to arrive as
     "Something else". */
  'An enterprise deal',
  'A problem with the site',
  'Something else',
]

function UserIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false">
      <circle cx="12" cy="8.2" r="3.6" />
      <path d="M5 19.4c0-3.3 3.1-5.4 7-5.4s7 2.1 7 5.4" strokeLinecap="round" />
    </svg>
  )
}

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false">
      <rect x="3.2" y="5.4" width="17.6" height="13.2" rx="2.4" />
      <path d="m4.4 7.4 7.6 5.4 7.6-5.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * §12 — rebuilt to the reference: name and email side by side with leading
 * icons, a reason dropdown, a message box, and a full-width send.
 *
 * The reference drops required-field asterisks entirely. They are kept here
 * anyway: §4 makes the red asterisk a site-wide rule, and following the
 * reference literally on this one form would make it the only page where a
 * required field looks optional.
 */
function ContactForm() {
  /*
   * A ?reason= from elsewhere on the site preselects the dropdown — the pricing
   * page's Contact sales link arrives with one. Validated against the list
   * rather than trusted, so a URL cannot put an option in the select that the
   * server does not recognise.
   */
  const [params] = useSearchParams()
  const preselected = CONTACT_REASONS.includes(params.get('reason')) ? params.get('reason') : ''

  const [form, setForm] = useState({ name: '', email: '', reason: preselected, message: '' })
  const [state, setState] = useState({ status: 'idle', error: '' })

  const update = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    setState({ status: 'sending', error: '' })
    try {
      await post('/api/contact', form)
      setState({ status: 'sent', error: '' })
    } catch (error) {
      setState({ status: 'idle', error: error.message })
    }
  }

  if (state.status === 'sent') {
    return (
      <div className="alert alert-ok">
        <strong>Thanks, we have your message.</strong>
        <p className="muted">We'll reply to {form.email}.</p>
      </div>
    )
  }

  return (
    <form className="contact-form" onSubmit={submit}>
      <div className="contact-row">
        <div className="field">
          <label className="field-label" htmlFor="contact-name">Name<Req /></label>
          <div className="input-icon">
            <UserIcon />
            <input
              id="contact-name" required placeholder="John Smith" value={form.name}
              onChange={(e) => update('name', e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="contact-email">Email Address<Req /></label>
          <div className="input-icon">
            <MailIcon />
            <input
              id="contact-email" required type="email" placeholder="john@example.com"
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="contact-reason">Reason for Contact<Req /></label>
        <select
          id="contact-reason" required value={form.reason}
          onChange={(e) => update('reason', e.target.value)}
        >
          <option value="">Select a reason...</option>
          {CONTACT_REASONS.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
        </select>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="contact-message">Message<Req /></label>
        <textarea
          id="contact-message" required rows={6} placeholder="How can we help you?"
          value={form.message}
          onChange={(e) => update('message', e.target.value)}
        />
      </div>

      {state.error && <p className="alert alert-error">{state.error}</p>}

      <button type="submit" className="btn btn-primary" disabled={state.status === 'sending'}>
        {state.status === 'sending' ? 'Sending…' : 'Send Message'}
      </button>
    </form>
  )
}

/**
 * §11 — the About page.
 *
 * Four sections rather than one column of prose: what this is, the two paths
 * through it, the recruiter case, and what happens to your data. The last of
 * those is the reason a candidate reads this page at all, so it gets the same
 * weight as the pitch rather than a line at the bottom.
 *
 * The header and footer are the site's own and are untouched — this is the page
 * between them.
 */
function AboutPage() {
  return (
    <div className="about">
      <section className="about-section">
        <h1>What is Cursus</h1>

        <div className="intro-grid">
          <div className="intro-copy">
            <p className="lead">
              Cursus is a talent marketplace built around who you are — not what a job advert
              demands.
            </p>
            <p>
              Traditional hiring makes skilled professionals rewrite their CV for every rigid job
              post. Cursus flips it: set up your profile once, in under two minutes, and stay
              discoverable to companies actively looking for your exact experience.
            </p>
            <p>
              Recruiters don't scan stacks of CVs here. They describe the role they're filling, in
              plain language, and Cursus surfaces the closest-matching profiles, with a clear
              explanation of why each one fits.
            </p>
            <p>
              Your privacy holds at every stage. Your surname, contact details and documents stay
              sealed until a recruiter takes a deliberate step to reveal them. Being listed on
              Cursus never leaves you exposed.
            </p>
            <p>
              And you keep authority over your professional presence from start to finish: update
              your preferences as your career changes, hide yourself from search the moment you
              stop looking, delete your profile outright whenever you want.
            </p>
          </div>

          {/* Decorative — everything it conveys is in the copy beside it — so an
              empty alt rather than a description to sit through. */}
          <figure className="intro-figure">
            <img src="/about-interview-2026.jpg" alt="" width="1000" height="1000" />
          </figure>
        </div>
      </section>

      <section className="about-section">
        <p className="about-eyebrow">How it works</p>
        <h2>Two sides, one short path each</h2>
        <p>Cursus only works if both sides do less than they do today. Here's the whole flow.</p>

        <div className="paths">
          <div className="path">
            <h3>If you're looking</h3>
            {/* An ordered list, because these are steps in sequence — the rule
                down the left is drawn from the markers, not added as markup. */}
            <ol className="steps">
              <li>
                <strong>Upload your CV</strong>
                <span>One file, one short page of questions. No skills tags, no years-of-experience dropdowns.</span>
              </li>
              <li>
                <strong>We build your profile</strong>
                <span>Cursus reads your CV and fills in the structure itself. You review it and correct anything that's off.</span>
              </li>
              <li>
                <strong>Recruiters find you</strong>
                <span>You appear in searches for roles that genuinely match your experience, under your first name only.</span>
              </li>
              <li>
                <strong>You get approached directly</strong>
                <span>Contact details are released one candidate at a time, by deliberate action. No bulk exports, no lists sold on.</span>
              </li>
            </ol>

            {/* The way in, at the foot of the side it belongs to — read the
                four steps, then act on them. */}
            <Link className="btn btn-primary path-cta" to="/?join=candidate">
              Create my profile
            </Link>
          </div>

          <div className="path">
            <h3>If you're hiring</h3>
            <ol className="steps">
              <li>
                <strong>Describe the role</strong>
                <span>Write it the way you'd explain it to a colleague. No boolean strings to construct.</span>
              </li>
              <li>
                <strong>Read the matches</strong>
                <span>Ranked candidates, each with the reasoning behind the match, so you can argue with it, not just trust it.</span>
              </li>
              <li>
                <strong>Shortlist into folders</strong>
                <span>Keep a live pipeline per role. Come back and refine the search as the brief changes.</span>
              </li>
              <li>
                <strong>Reach out</strong>
                <span>Reveal contact details for the people you actually want, and send from your own inbox.</span>
              </li>
            </ol>

            {/* ?join=recruiter opens the landing card on the company form, so
                this lands on an account sign-up rather than on a toggle. */}
            <Link className="btn btn-primary path-cta" to="/?join=recruiter">
              Create my account
            </Link>
          </div>
        </div>
      </section>

      <section className="about-section">
        <div className="recruiter-panel">
          <p className="about-eyebrow">For recruiters</p>
          <h2>Search by role, not by keyword</h2>
          <p>
            Keyword search finds the people who happened to write their CV the way you phrased the
            query. Everyone else is invisible — the career-changer, the person whose title doesn't
            travel, the strong candidate who never applied because your job post looked like a
            wall.
          </p>
          <p>
            Cursus searches meaning instead. Describe the role and get back people whose actual
            experience fits it, each with a plain-language explanation of the match you can check
            against your own judgment.
          </p>

          <div className="feature-grid">
            <div className="feature">
              <h3>Candidates who aren't applying</h3>
              <p>
                Everyone here has opted in to being found, and profiles that go quiet for 60 days are
                taken out of search rather than left to look current. Recruiters see how recently
                each candidate was active, and can ask us to reconfirm anyone before spending a
                Reveal. What that buys is a better-founded guess, not a guarantee: it tells you
                somebody was here, not that they will reply. They are
                still open. A profile that stops confirming is labelled with how long it has been,
                so you can see it before you spend anything on it.
              </p>
            </div>
            <div className="feature">
              <h3>Reasoning you can audit</h3>
              <p>Every match comes with why. No opaque score to defend to a hiring manager.</p>
            </div>
            <div className="feature">
              <h3>Pay for what you use</h3>
              <p>
                Solo and agency recruiters pay per contact reveal. Teams subscribe to seats.
                Either way, browsing is never the thing you're billed for.
              </p>
            </div>
            {/*
              The other half of the job, named where recruiters read about the
              first. Search and Triage answer opposite questions — who else is
              out there, and which of the people who already applied to read
              first — and a recruiter who only ever meets one of them is being
              sold half a product.
            */}
            <div className="feature">
              <h3>The applicants you already have</h3>
              <p>
                Cursus Triage sorts the pile, even when the pile is hundreds of CVs. Upload the
                job description and the applications you were already sent, and get every one back
                scored and ranked against the role. It's the same matching engine you see in
                search, pointed at your own inbox.
              </p>
            </div>
          </div>

          <div className="about-cta">
            <Link className="btn btn-primary" to="/pricing">See pricing</Link>
          </div>
        </div>
      </section>

      <section className="about-section">
        <p className="about-eyebrow">Your data</p>
        <h2>Listed, not exposed</h2>
        <p>
          Putting your CV somewhere shouldn't mean losing track of where it went. Cursus is built so
          that being discoverable and being private aren't a trade-off.
        </p>

        <div className="control-grid">
          {[
            ['No public profile.', 'There’s no page of yours on the open internet, and no link a recruiter can forward. Profiles are viewed inside Cursus or not at all.'],
            ['Sealed by default.', 'Recruiters see your first name, summary and experience. Surname, email and phone stay hidden until they choose to reveal them.'],
            ['Block specific employers.', 'Name the companies you don’t want seeing you — your current one included — and you won’t appear in their searches.'],
            ['Never ranked by payment.', 'You can’t buy your way up the results. Matches are ordered by fit, and nothing else.'],
            ['Off when you’re off.', 'Hide yourself from search in one click. If we record no activity for 30 days we start asking, and at 60 days your profile comes out of search by itself — so you are never listed after you have stopped looking.'],
            ['Delete means delete.', 'Remove your profile and documents from Cursus entirely, any time, without asking anyone.'],
          ].map(([title, body]) => (
            <div className="control" key={title}>
              <span className="control-dot" aria-hidden="true" />
              <p><strong>{title}</strong> {body}</p>
            </div>
          ))}
        </div>

        {/* Contact us alone, and first. "Create your profile" now sits beside
            the heading of the side it belongs to, further up; repeating it here
            offered the candidate route at the end of a section about privacy
            controls, where the open question is a question, not a sign-up. */}
        <div className="about-cta">
          <Link className="btn btn-outline" to="/contact">Contact us</Link>
        </div>
      </section>

      {/*
        The way out, after the whole argument.

        The page used to end on "Contact us" at the foot of a section about
        privacy controls — a reader who had just read the entire pitch and was
        convinced by it had nowhere to go. Both audiences read this page, so it
        closes with both doors rather than guessing which one arrived.

        No new classes: the same `about-section`, `about-cta` and buttons every
        other section on this page already uses.
      */}
      <section className="about-section">
        <h2>One profile. The right eyes on it. Nothing exposed.</h2>
        <div className="about-cta">
          <Link className="btn btn-primary" to="/?join=candidate">Create my profile</Link>
          <Link className="btn btn-outline" to="/?join=recruiter">I’m hiring</Link>
        </div>
      </section>
    </div>
  )
}

/**
 * A legal document as a page of its own.
 *
 * Wider than the other info pages: `panel-narrow` is set for a paragraph or two
 * of prose, and twenty-three numbered clauses at that measure is a very long
 * column. `.legal-doc` carries the reading typography and is the same class the
 * modal uses, so the two cannot look like different documents.
 */
function LegalPage({ name }) {
  const { title, subtitle, Body } = LEGAL_DOCUMENTS[name]

  return (
    <article className="panel info-page legal-page legal-doc">
      <header className="legal-page-head">
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
      </header>
      {/* The drafts carry the operator's own instruction that they are not for
          publication while the bracketed fields are unfilled. Surfaced rather
          than dropped — the fields below are visibly still brackets. */}
      <p className="alert alert-warn">{DRAFT_NOTICE}</p>
      <Body />
    </article>
  )
}

export default function InfoPage({ page }) {
  if (page === 'about') return <AboutPage />

  const content = PAGES[page]
  if (!content) return null
  if (content.legal) return <LegalPage name={content.legal} />

  const isContact = page === 'contact'
  const extra = isContact ? ' contact-page' : ''

  return (
    <article className={`panel panel-narrow info-page${extra}`}>
      <h1>{content.title}</h1>
      {content.body}
      {isContact && (
        <>
          <p className="muted">
            Questions about your profile, your data, or hiring on Cursus. We read everything that
            arrives here.
          </p>
          <ContactForm />
        </>
      )}
    </article>
  )
}
