import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import SignUpFlow from '../components/SignUpFlow.jsx'
import CompanySignUpForm from '../components/CompanySignUpForm.jsx'
import StatsBanner from '../components/StatsBanner.jsx'
import { CandidatePitch, RecruiterPitch } from './landingCopy.jsx'
import { sendForm } from '../api.js'

/**
 * The landing page.
 *
 * Shaped like a job advert on purpose: the proposition reads down the left, the
 * application sits in a card on the right, and the CV is the first thing asked
 * for. The joke only works if joining is genuinely short, so nothing that can
 * be read out of the CV is asked for here.
 */
export default function UploadPage() {
  const [status, setStatus] = useState({ state: 'idle' })
  /*
   * Who is filling this card in.
   *
   * The landing page used to serve candidates alone, and a recruiter had to
   * work out that "Recruiters" in the header was where they should have gone.
   * Asking outright is one click and no navigation: the page, the argument and
   * the scroll position all stay put, and only the card changes.
   *
   * `?join=recruiter` answers the question in advance. The About page explains
   * both sides and offers a way into each, and a recruiter who clicks "Create
   * an account" there should land on the account form rather than on the
   * candidate card with a toggle to find. Anything other than 'recruiter' means
   * the candidate side, so a mistyped or stale link degrades to the default
   * rather than to a blank page.
   */
  const [params] = useSearchParams()
  const [role, setRole] = useState(
    params.get('join') === 'recruiter' ? 'recruiter' : 'candidate',
  )
  const recruiter = role === 'recruiter'
  const navigate = useNavigate()
  const cardRef = useRef(null)

  /**
   * The hero button is navigation, not submission.
   *
   * §10 — on a narrow screen the form is stacked below the pitch, so this
   * carries someone to the top of the card and lands them in its first field.
   * On desktop the card is already beside the copy and nothing has to move; the
   * focus and the highlight still happen, so the button says where the form
   * starts rather than being a decoration that does nothing when clicked.
   *
   * `scrollIntoView` on the card rather than a jump to page top: the button
   * sits near the top of the hero, so "go up" is no longer the instruction.
   *
   * The field is found rather than named. It used to look for `#first-name`,
   * which exists only on the candidate form — so on the recruiter panel the
   * button scrolled and then pointed at nothing. Asking the card for its first
   * real field works for whichever panel is showing, and keeps working if
   * either form's opening question changes.
   */
  /*
   * The other side of the pitch, read from its beginning.
   *
   * These two links sit at the very bottom of a long page, and switching sides
   * replaces everything above them — so without this the reader is left at the
   * foot of a page they have not seen the top of, looking at whatever happens
   * to be the same distance down the new one. The role switch at the top does
   * not need this: it is already there.
   */
  function switchSide(next) {
    setRole(next)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: 0, behavior: reduced ? 'auto' : 'smooth' })
  }

  function focusApplication() {
    const card = cardRef.current
    if (!card) return

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    card.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' })

    /*
     * The first thing there is to type into.
     *
     * `[hidden]` and `type=file` are excluded deliberately: the CV dropzone and
     * the photo uploader both put a hidden file input above the first visible
     * field, and focusing one of those would move focus somewhere invisible.
     */
    const first = card.querySelector(
      'input:not([hidden]):not([type="file"]):not([readonly]), select, textarea',
    )
    if (!first) return

    first.classList.add('field-called')
    first.focus({ preventScroll: true })
    window.setTimeout(() => first.classList.remove('field-called'), 1500)
  }

  /*
   * Arriving with ?join= means somebody pressed a button asking for this form,
   * so it is put in front of them rather than left below the fold on a phone.
   *
   * On arrival only — an empty dependency list — so switching role with the
   * toggle afterwards does not drag the page back down. The short delay is
   * needed because the card has no layout on the first paint, and
   * scrollIntoView against a zero-height element does nothing.
   */
  useEffect(() => {
    if (!params.get('join')) return undefined
    const id = window.setTimeout(focusApplication, 120)
    return () => window.clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /*
   * Submitting moved into SignUpFlow with the form it belonged to.
   *
   * The refusal it used to handle is still handled the same way and for the
   * same reason: a duplicate arrives as an error in the server's own words,
   * naming whether it was the email address or the phone number that is taken,
   * shown on the step that can fix it. It never swaps the card for a "you are
   * back" panel — that reads a collision as a returning user when it is just as
   * easily somebody who mistyped a digit into a stranger's number.
   */

  if (status.state === 'done') {
    const { result } = status
    return (
      <div className="panel panel-narrow success-panel">
        <div className="success-mark">✓</div>
        <h1>Your Cursus profile is live</h1>
        <p className="muted">
          We read {result.charactersRead.toLocaleString()} characters from your CV. Your reference is{' '}
          <strong>#{result.id}</strong>.
        </p>
        <Link className="btn btn-primary" to="/account">Go to my profile</Link>
      </div>
    )
  }

  return (
    <div className="landing">
      {/*
        Who the page is for, asked above everything rather than at the top of
        the card.

        It governs both columns — the card it swaps and the argument beside it —
        so sitting inside one of them understated it. Centred across the page
        above the masthead, it reads as the first question the site asks.

        A radiogroup rather than two links: the answer changes what is below it
        on this page, and nothing else. A recruiter who lands here following the
        proposition should not have to notice a header item and navigate away to
        find the form that applies to them.
      */}
      {/*
        The visible "I am:" is gone, so `aria-label` is now the only thing
        naming this group — which is why it says the same words rather than
        being dropped with it.
      */}
      <div className="role-switch" role="radiogroup" aria-label="I am">
        {[['candidate', 'Candidate'], ['recruiter', 'Recruiter']].map(([value, text]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={role === value}
            className={role === value ? 'role-option role-option-on' : 'role-option'}
            onClick={() => setRole(value)}
          >
            {text}
          </button>
        ))}
      </div>

      <article className="candidate-pitch">
        {/*
          §2 — Welcome to CURSUS is the title, and the proposition sits under it.

          This puts the greeting above the argument in the type hierarchy, which
          is the inverse of the usual arrangement. It is what the section
          specifies; the two sizes are kept a step apart rather than a leap, so
          the pair still reads as one masthead.

          Everything below the greeting now differs by side. The page used to
          show the candidate argument to everyone and swap only the card, so a
          recruiter read "upload your CV" beside a form asking for their company
          name. The words in landingCopy.jsx.
        */}
        <h1 className="landing-welcome">Welcome to CURSUS</h1>
        {/*
          The break after "Two minutes now." is deliberate, not the wrapping.

          It is two claims — what it costs you, and what you get — and the pause
          between them is the line. Left to wrap, the break landed wherever the
          column width put it: after "Candidates" on the recruiter side, mid
          phrase. An explicit <br /> holds it at the full stop, and the sentence
          still reads as one line on a narrow screen where it cannot fit anyway.
        */}
        {/*
          The break after "Two minutes now." is deliberate, not the wrapping.

          It is two claims — what it costs you, and what you get — and the pause
          between them is the line. Left to wrap, the break landed wherever the
          column width put it, mid phrase. An explicit <br /> holds it at the
          full stop, and the sentence still reads as one line on a narrow screen
          where it cannot fit anyway.

          The recruiter side says something else entirely now. "Two minutes" is
          a candidate-side promise — a recruiter does not care that signing up
          is quick, they care that screening gets shorter — and "come to you
          later" undersold the product, which delivers a shortlist now.

          The candidate half now names who does the work. "Opportunities chase
          you later" left the second claim without an actor at the exact moment
          the reader is deciding whether anything happens after they upload —
          it read as a place things might occur, rather than something that
          goes to work on their behalf.
        */}
        <p className="landing-title">
          {recruiter ? (
            <>
              You shouldn't have to dig through hundreds of applications to find three good
              candidates. Tell us who you need. We'll show you who fits.
            </>
          ) : (
            <>
              Two minutes now.<br />Then we put your CV in front of the recruiters who are looking
              exactly for you.
            </>
          )}
        </p>

        {/*
          §10 — the call to action sits here, at the top of the argument rather
          than after all of it.

          Neither label says "Apply": nobody applies on Cursus, and a button
          saying so would describe the thing this product exists to replace. A
          recruiter is opening a company account with an administrator on it,
          which is what the card beside this button actually creates.
        */}
        <div className="landing-lead-row">
          <h2 className="landing-lead">
            {recruiter ? 'Recruiting is backwards.' : 'Job searching is backwards.'}
          </h2>
          {/* The demo used to sit beside this button. It is in the header now,
              where it is reachable from every page rather than only from the
              recruiter half of this one. */}
          <button type="button" className="btn btn-primary btn-apply-top" onClick={focusApplication}>
            {recruiter ? 'Create my account' : 'Create my profile'}
          </button>
        </div>

        {/* The one line that answers "what does pressing that cost me". It sits
            under the button rather than beside it so the row above keeps the
            heading and the action on one line. */}
        <p className="muted landing-microcopy">
          {recruiter
            ? 'Paste a job description. Get a ranked shortlist.'
            : 'Free for candidates. No cover letter. Ever.'}
        </p>

        {/*
          The pitch is given the page's two verbs rather than reaching for them:
          the closing button focuses the card the same way the one at the top
          does, and the crossover line at the foot flips the side — which is the
          role switch above, reached from where somebody finished reading.
        */}
        {recruiter
          ? <RecruiterPitch onCta={focusApplication} onSwitchSide={() => switchSide('candidate')} />
          : <CandidatePitch onCta={focusApplication} onSwitchSide={() => switchSide('recruiter')} />}

        {/* Fills the space the copy leaves at the foot of the column. Renders
            nothing while the numbers are too small to be encouraging. */}
        <StatsBanner />
      </article>

      <aside className="application-card" id="apply" ref={cardRef} aria-label="Join Cursus">
        {/*
            The form, always — on both sides of the page, whoever the browser
            thinks is signed in.

            A card used to stand in front of it reading "You already have a
            profile" whenever a candidate session existed. That assumes the
            person at the keyboard is the person who signed in last, and on a
            shared computer — a family laptop, a library machine, a careers
            service desk — it is simply wrong: the second person is told they
            have an account they never made, and given no way to make one.

            Nothing is lost by dropping it. A real duplicate is still refused,
            by the server, on the details actually typed — which is the honest
            test, where "is there a session in this browser" was a guess about
            who is reading.
        */}
        {role === 'candidate' ? (
          <div className="panel">
            <header className="panel-head">
              {/* "your" in the heading and "my" on the button: the card is
                  addressing the reader, and the button is the reader speaking.
                  It matches the recruiter card's "Create your business
                  account" directly above the same fold. */}
              <h2>Create your profile</h2>
              <p className="muted">
                Upload your CV and we build the profile from it. You check it at the end.
              </p>
            </header>

            {/*
              The stepped flow, not the old single card.

              The card asked for a CV and then asked for everything the CV
              already says. This reads it first and asks only for what it could
              not answer — see SignUpFlow, which reuses the same dropzone,
              verified fields and consent box the card used.
            */}
            <SignUpFlow
              onDone={(created) => {
                navigate('/account', {
                  replace: true,
                  state: {
                    justApplied: true,
                    onboarding: true,
                    reference: created.id,
                    documents: created.documents,
                    charactersRead: created.charactersRead,
                  },
                })
              }}
            />
          </div>
        ) : (
          <>
            <header className="panel-head">
              <h2>Create your business account</h2>
              <p className="required-note">
                Fields marked with <span className="req">*</span> are required.
              </p>
            </header>
            {/* The same form /hr serves, so the two cannot drift. `bare`
                because this aside is already the card. */}
            <CompanySignUpForm
              chrome="bare"
              onCreated={(created) => navigate('/in-review', { state: created })}
            />
          </>
        )}
      </aside>
    </div>
  )
}
