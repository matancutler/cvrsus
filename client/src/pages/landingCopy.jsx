/**
 * The landing page's words, for each side of the marketplace.
 *
 * Kept apart from UploadPage.jsx, which owns the page's mechanics — the role
 * switch, the focus behaviour, the form submission. Copy changes far more often
 * than any of that, and it should be possible to rewrite a paragraph without
 * reading a line of logic.
 *
 * The two sides get genuinely different arguments. The page used to show the
 * candidate pitch to everyone and swap only the card, which meant a recruiter
 * read "upload your CV" while looking at a form asking for their company name.
 *
 * Both are set from the approved copy deck, whose spelling of the brand —
 * CURSUS — is now the one the running text uses everywhere. The wordmark in the
 * header and footer is the exception and still reads CVRSVS.
 */

/*
 * Emphasis is carried by classes the site already has rather than new ones:
 * `.landing-section` for the headings that break the argument into parts,
 * `.landing-kicker` — a bold line with an oxblood rule down its left — for the
 * turns the deck sets in colour, and `.steps` for the numbered walkthroughs,
 * which is the same numbered list the About page draws its two paths with.
 * Introducing a third treatment for any of those jobs would leave the page with
 * two ways of saying the same thing.
 *
 * The decks were rewritten to a much shorter shape: a problem stated in two
 * lines rather than four paragraphs, then numbered steps, then what you need,
 * then a way out. The old version explained the competition twice and buried
 * the mechanism in the middle of the prose.
 *
 * The candidate deck was then rewritten again around one complaint: it was
 * written in the passive voice throughout — "opportunities chase you", "it
 * makes the right jobs find you" — which described a place where things might
 * happen rather than something working on the reader's behalf. The words are
 * the same length and in the same order; the difference is that CURSUS is now
 * the subject of the sentences that matter.
 */

export function CandidatePitch({ onCta, onSwitchSide }) {
  return (
    <>
      <p>
        You spend hours scrolling listings, filling out forms, and uploading the same CV again and
        again — without knowing if anyone will ever read it.
      </p>
      <p>
        Most new hiring tech just helps you apply to <em>more</em> jobs. More applications, more
        noise, same silence.
      </p>

      <p className="landing-kicker">
        CURSUS doesn't help you apply to more jobs. It works your CV for you — actively bringing
        your profile to the recruiters searching for what you bring, and keeping you discoverable
        to everyone else.
      </p>

      <div className="lower-copy">
        <h2 className="landing-section">How it works</h2>
        <ol className="steps">
          <li>
            <strong>Build your profile in under two minutes</strong>
            <span>Upload your CV, tell us what you're open to. That's it: no forms, no cover letters.</span>
          </li>
          <li>
            <strong>Get on with your life</strong>
            <span>
              You don't need to be job hunting. You just need to be open to the right opportunity.
              Your profile keeps working while you don't.
            </span>
          </li>
          {/*
             The step that used to be one event is two, because it was two
             things: what we do, and what the recruiter does. Merged, the only
             verb belonged to the recruiter and our half of it disappeared.

             It is also the step that has to stay honest, being the one that
             claims the most. Nothing is sent to a recruiter who has not
             searched — there are no alerts and no digests — so this says what
             happens when they do search, which is that retrieval puts a
             matching profile at the top and the analysis argues the fit
             requirement by requirement. That is a real thing to promise, and
             it is a smaller thing than approaching people unasked.
          */}
          <li>
            <strong>We push your CV forward</strong>
            <span>
              This is the part nobody else does. When a recruiter's search matches your experience,
              skills and preferences, CURSUS puts you at the top of it and makes the case for why
              you fit. Discovered when they look, promoted when you match.
            </span>
          </li>
          <li>
            <strong>The right people reach out</strong>
            <span>
              Relevant companies contact you directly. No application forms, no cover letters, no
              wondering if anyone read it.
            </span>
          </li>
        </ol>

        <h2 className="landing-section">For everyone</h2>
        <p><strong>Any industry. Any level. Any background.</strong></p>
        <ul className="landing-list">
          <li>No specific experience required</li>
          <li>No degree required</li>
          <li>No cover letter, ever</li>
          <li>Less than two minutes of your time</li>
          <li>Just curiosity about what might be next</li>
        </ul>
        <p>
          Whatever you bring, there may be a company looking for exactly that — and when there is,
          we'll make sure they see you.
        </p>

        {/* The page's own words at the foot of its own argument, so a reader
            convinced by the last line does not have to scroll back up to act
            on it. On a phone the card sits below this, which is exactly where
            the button sends them. */}
        <p className="landing-kicker">Stop chasing. We chase for you.</p>
        <div className="landing-close-cta">
          <button type="button" className="btn btn-primary btn-lg" onClick={onCta}>
            Create my profile
          </button>
        </div>

        {/* Quiet, and last. The role switch at the top of the page is the
            proper way across, but a recruiter who read the candidate pitch to
            the end should not have to go looking for it. */}
        <p className="muted landing-crossover">
          Hiring?{' '}
          <button type="button" className="link-button" onClick={onSwitchSide}>
            See how CURSUS works for companies
          </button>
        </p>
      </div>
    </>
  )
}

export function RecruiterPitch({ onCta, onSwitchSide }) {
  return (
    <>
      <p>
        AI made applying effortless. Now every role gets flooded: tailored CVs, generated cover
        letters, applications engineered to pass your screening. More volume, not better candidates.
      </p>
      <p>
        And when every CV can be rewritten to mirror your job description, a perfectly tailored CV
        means very little.
      </p>

      <p className="landing-kicker">CURSUS is built differently.</p>

      <p><strong>One candidate. One profile. One authentic CV.</strong></p>
      <p>
        Candidates on CURSUS maintain a single consistent profile representing their actual
        professional background, not a fresh version generated for every role they appear against.
      </p>
      <p>You see the person, not an application engineered to get through your filter.</p>

      <div className="lower-copy">
        <h2 className="landing-section">How it works</h2>
        <ol className="steps">
          <li>
            <strong>Tell us who you need</strong>
            <span>Paste or upload a job description: no Boolean syntax, no complicated search builder.</span>
          </li>
          <li>
            <strong>We match against the pool</strong>
            <span>
              Our matching system compares your requirements against candidate experience, skills
              and preferences, and ranks the strongest matches, with an explanation of why each
              one fits.
            </span>
          </li>
          <li>
            <strong>Reach out directly</strong>
            <span>
              See someone worth pursuing? Reveal their profile and contact them. Then get to the
              part of recruiting that actually matters: talking to the right people.
            </span>
          </li>
        </ol>

        {/*
          The applicant pile, named on the page that sells the search.

          A recruiter arriving here has two problems and we only ever mentioned
          one of them. Naming Triage in the same breath is also how the invented
          word first gets explained — in a sentence about the situation it
          solves, rather than as a line item on a price list.
        */}
        <h2 className="landing-section">Already drowning in applications?</h2>
        <p>
          <strong>CURSUS Triage</strong> sorts the stack you already have. Upload your job
          description and the CVs you received, and read them back ranked against the role, instead
          of opening them one at a time.
        </p>

        <h2 className="landing-section">What you'll bring</h2>
        <ul className="landing-list">
          <li>A role you're hiring for</li>
          <li>A job description, or a few minutes to describe it</li>
        </ul>
        <p>That's it.</p>
        <ul className="landing-list">
          <li>No complicated search syntax</li>
          <li>No lengthy sourcing process</li>
          <li>No agency retainers or mandates</li>
          <li>No sifting through hundreds of applications</li>
          <li>No guessing whether a CV was tailored for your role</li>
        </ul>
        <p><strong>Less noise. More signal.</strong></p>

        <p className="landing-kicker">Search once. See who actually matches.</p>
        <div className="landing-close-cta">
          <button type="button" className="btn btn-primary btn-lg" onClick={onCta}>
            Create my account
          </button>
        </div>

        <p className="muted landing-crossover">
          Looking for a role yourself?{' '}
          <button type="button" className="link-button" onClick={onSwitchSide}>
            See how CURSUS works for candidates
          </button>
        </p>
      </div>
    </>
  )
}
