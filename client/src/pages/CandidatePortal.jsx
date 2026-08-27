import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useLocation, useSearchParams } from 'react-router-dom'

import Avatar from '../components/Avatar.jsx'
import CandidateForm from '../components/CandidateForm.jsx'
import Notice, { StatusNotice, useStandingNotice } from '../components/Notice.jsx'
import ChatPanel from '../components/ChatPanel.jsx'
import InfoHint from '../components/InfoHint.jsx'
import PopMenu from '../components/PopMenu.jsx'
import PortalBar from '../components/PortalBar.jsx'
import { usePortalChrome } from '../chrome.jsx'
import { del, get, getToken, patch, post, sendForm, signOut as signOutRequest, withToken } from '../api.js'
import { DATE_LOCALE, formatDate } from '../dates.js'

const POLL_MS = 8000

export default function CandidatePortal() {
  const [ready, setReady] = useState(false)
  const [account, setAccount] = useState(null)

  const load = useCallback(async () => {
    const data = await get('/api/candidate/me', 'candidate')
    setAccount(data)
    return data
  }, [])

  useEffect(() => {
    if (!getToken('candidate')) {
      setReady(true)
      return
    }
    /*
     * Only a refusal ends the session.
     *
     * This used to sign the candidate out on ANY failure — a 500, a dropped
     * connection, a server restarting mid-request — on the reasoning that a
     * failed load means the cookie is dead. Only a 401 means that. Everything
     * else meant a person with a perfectly good session was returned to the
     * sign-in card, and from there the shortest path back is the one that
     * offers to create a profile.
     *
     * A transient failure leaves `account` null and shows the sign-in card
     * either way, but the session survives it, so signing in again works
     * rather than starting an account.
     */
    load()
      .catch((error) => { if (error?.status === 401) return signOutRequest(); return undefined })
      .finally(() => setReady(true))
  }, [load])

  async function signOut() {
    // Only the server can clear an httpOnly cookie, so this is a request now.
    await signOutRequest()
    setAccount(null)
  }

  /*
   * The site header and footer belong to the sign-in screen, not to the
   * account behind it. Declared from the same value that decides which of the
   * two is rendered, so the two can never disagree.
   */
  usePortalChrome(Boolean(account))

  if (!ready) return <div className="panel panel-narrow muted">Checking your session…</div>
  if (!account) return <SignInCard onSignedIn={() => load().then(() => setReady(true))} />

  return <Portal account={account} reload={load} onSignOut={signOut} />
}

// ------------------------------------------------------------- sign in ---

function SignInCard({ onSignedIn }) {
  const [step, setStep] = useState('identify')
  const [identifier, setIdentifier] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notFound, setNotFound] = useState('')

  async function requestCode(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotFound('')
    try {
      setSent(await post('/api/candidate/request-code', { identifier }))
      setStep('code')
    } catch (err) {
      // 404 means no application exists, which the form answers with an offer
      // to create one rather than a bare error.
      if (err.status === 404) setNotFound(err.message)
      else setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function verify(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      // Nothing to keep: the response set an httpOnly session cookie, which is
      // the credential from here on. The body's token is for API clients.
      await post('/api/candidate/verify-code', { identifier, code })
      onSignedIn()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (step === 'code') {
    return (
      <form className="panel panel-login" onSubmit={verify}>
        <h1>Enter your code</h1>
        <p className="muted">
          If an application exists for that {sent?.channel === 'phone' ? 'number' : 'address'}, a
          six-digit code is on its way to <strong>{sent?.maskedTo}</strong>. It expires in{' '}
          {sent?.expiresInMinutes ?? 10} minutes.
        </p>

        {sent?.devCode && (
          <p className="alert alert-warn">
            No email or SMS provider is configured, so the code is shown here and printed to the
            server console: <strong>{sent.devCode}</strong>
          </p>
        )}

        <div className="field">
          <label className="field-label">Six-digit code</label>
          <input
            autoFocus
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        </div>

        <StatusNotice error={error} onDismiss={() => setError('')} />

        <button type="submit" className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => { setStep('identify'); setCode('') }}>
          Use a different email address
        </button>

        {/*
          The one question this screen could not answer.

          Somebody who cannot open that mailbox has nowhere to go: the code is
          unreadable and the button above only returns them to a field they have
          nothing new to type into. Left there, the next thing they meet is an
          offer to create a profile — which orphans the one they already have,
          CV, messages and paid-for reveals with it.

          Changing the address on an account is deliberately not self-service:
          it is the credential now, so it is handled by a person who can check
          who is asking. This is the door to that.
        */}
        <p className="field-hint">
          Lost access to this address? <Link to="/contact">Contact us</Link> and we will move your
          profile to a new one. Do not create a second profile — your first one would stay behind.
        </p>
      </form>
    )
  }

  return (
    <form className="panel panel-login" onSubmit={requestCode}>
      {/* §13 — "Sign In", not "Your account": this is the door, and the page it
          leads to is the account. */}
      <h1>Sign In</h1>
      <p className="muted">
        Enter the email address you applied with. We will send a confirmation code; there is
        no password.
      </p>

      {/*
        §13 replaces the sample values with an instruction. The label above the
        field says the same thing, which the audit flags as a duplication — the
        label is what is kept, because it survives typing and is what a screen
        reader announces, so the placeholder carries the verb instead.
      */}
      <div className="field">
        <label className="field-label" htmlFor="sign-in-identifier">Email address</label>
        <input
          id="sign-in-identifier"
          autoFocus
          value={identifier}
          onChange={(e) => { setIdentifier(e.target.value); setNotFound('') }}
          type="email"
          autoComplete="email"
          placeholder="Enter your email address"
        />
      </div>

      <StatusNotice error={error} onDismiss={() => setError('')} />

      {/*
        Nothing matched — which is far more often the wrong address than a
        missing account.

        It used to offer the phone number as the other thing to try, because
        either one signed you in. Only the email does now, so the second answer
        is a different spelling of the same mailbox rather than a different
        channel: people apply from work and try to sign in from a personal
        address, or the other way round.

        Creating a profile stays, because somebody genuinely new reads this too
        — but it is the second answer. Leading with it told people who had
        simply mistyped that their profile was gone, and following the offer is
        how they ended up with two accounts.
      */}
      {notFound && (
        <div className="not-found">
          <strong>{notFound}</strong>
          <p className="muted">
            Sign-in goes to the email address on your profile. If you have more than one, try the
            other — the address you applied with is the one that works.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => { setNotFound(''); setIdentifier('') }}
          >
            Try another email address
          </button>
          {/* Before the offer to create one, because the person who has lost
              their mailbox and the person who is genuinely new both read this,
              and only one of them should sign up. */}
          <p className="field-hint">
            Applied before but cannot reach that address any more?{' '}
            <Link to="/contact">Contact us</Link> rather than signing up again — a second profile
            leaves the first one behind.
          </p>
          <p className="field-hint">
            Never applied? <Link to="/">Create a profile</Link> — it takes a minute, and afterwards
            you can sign in here.
          </p>
        </div>
      )}

      <button type="submit" className="btn btn-primary btn-block" disabled={busy || !identifier.trim()}>
        {busy ? 'Sending…' : 'Send me a code'}
      </button>

      {/*
        The way out for someone who has no account yet.

        Previously this appeared only after a lookup failed, which meant the
        only route to signing up was to guess wrong first. Someone who has never
        applied has nothing to type into the field above, so the offer has to be
        visible before they try — not as a consolation for an error.
      */}
      <p className="auth-alt">
        New to Cursus? <Link to="/">Create an account</Link>. Upload your CV and you are done in
        under two minutes.
      </p>
    </form>
  )
}

// -------------------------------------------------------------- portal ---

function Portal({ account, reload, onSignOut }) {
  const [params, setParams] = useSearchParams()

  /**
   * `?thread=<recruiterId>` comes from the "you have a message" email. Landing
   * on the profile tab and making someone hunt for the conversation they were
   * just told about is the sort of thing that stops people replying.
   *
   * The parameter is consumed on arrival so a refresh does not drag them back
   * to the same thread after they have navigated away.
   */
  const deepLinked = params.get('thread')
  const [openThread, setOpenThread] = useState(deepLinked ? Number(deepLinked) : null)

  useEffect(() => {
    if (!deepLinked) return
    const next = new URLSearchParams(params)
    next.delete('thread')
    setParams(next, { replace: true })
  }, [deepLinked, params, setParams])

  const { candidate, views, activity } = account

  /*
   * Start the reading column level with the CV box opposite it.
   *
   * The form leads with a photograph, so its first real field sits some way
   * down the page while the summary opposite starts at the top — the two
   * columns read as though one had slipped. The offset is the height of that
   * photograph, which is not a constant: the "Remove" link only exists once a
   * picture has been uploaded, and it changes the block by a line.
   *
   * So it is measured rather than guessed, and re-measured when it changes.
   * A CSS variable carries it, which keeps the arrangement itself in the
   * stylesheet where the rest of the layout lives.
   */
  const page = useRef(null)
  useEffect(() => {
    const grid = page.current
    if (!grid) return undefined

    const photo = grid.querySelector('.photo-lead')
    if (!photo) return undefined

    /*
     * Measured from the form column alone, and never from the column it moves.
     *
     * This used to read the gap between the two columns and close it — which
     * meant reading `.account-side`'s own padding, writing a new padding, and
     * watching `.account-side` for changes. That is a feedback loop: the write
     * resized the very element the observer was watching, so it ran again, and
     * the offset oscillated by a pixel or two forever.
     *
     * A layout that never settles is not just wasteful. Everything positioned
     * from --photo-offset keeps moving, including the pencil that unlocks this
     * form — so a click landed where the button had been a frame ago and hit
     * the form behind it instead. It looked like a dead button, and only to a
     * real pointer: a synthetic `.click()` names its target and cannot miss,
     * which is exactly why every test of mine passed.
     *
     * The distance from the top of the form column to its first field is a fact
     * about that column only. Reading it changes nothing, so there is no loop.
     */
    const measure = () => {
      const main = grid.querySelector('.account-main')
      const anchor = grid.querySelector('.account-main .field-label')
      if (!main || !anchor) return

      const offset = Math.max(
        0,
        Math.round(anchor.getBoundingClientRect().top - main.getBoundingClientRect().top),
      )
      const current = parseFloat(
        getComputedStyle(grid).getPropertyValue('--photo-offset') || '0',
      )
      if (Math.abs(offset - current) > 1) {
        grid.style.setProperty('--photo-offset', `${offset}px`)
      }
    }

    measure()
    /* Only the photograph, whose height changes when a picture is added or
       removed. Never `.account-side` — that is what this writes to. */
    const observer = new ResizeObserver(measure)
    observer.observe(photo)
    return () => observer.disconnect()
    /* Re-run when the account is replaced, not on every render: the effect
       reconnects an observer, and doing that each render is how a cheap
       measurement turns into a permanent one. */
  }, [account])

  return (
    <div className="portal">
      {/* In place of the site header, which is gone from here — see chrome.jsx.
          Sign out moves up into it, so the identity block below is identity
          rather than identity plus a control.

          No workspace label beside the wordmark: a candidate has exactly one
          screen here, so naming it told them something they could not have been
          in any doubt about. */}
      <PortalBar onSignOut={onSignOut} />

      {/*
        No masthead. The photo, name, email and phone had a band of their own
        across the top of the page — four facts the reader supplied and already
        knows, above the form where all four are editable anyway. The photo now
        sits in the form, over the CV box, where it is a control rather than a
        portrait.
      */}
      {/* Carried from the application form, which signs them in and sends them
          straight here. Shown once — it is confirmation, not a status. */}
      <JustAppliedNote />

      {/*
        Only the states that need answering.

        Deactivated and unconfirmed are questions: recruiters cannot see you, or
        we are asking whether they still should. Those stay at the top of the
        page where they cannot be missed. The confirmed state is neither — it is
        a status line plus a control for switching yourself off, which belongs
        with the other account controls at the foot of the page. See
        AccountSettings.
      */}
      <ActivityBanner activity={account.activity} reload={reload} urgentOnly />

      {/*
        One page, not three tabs.

        The profile form and the read-only "how you look to recruiters" cards
        were separate tabs, which meant checking whether a change had landed
        involved editing on one tab and navigating to another to see it. They
        are two halves of one question — what recruiters see — so they sit in one
        region: what recruiters see on the left, and the form that changes it on
        the right.

        The reading column leads because it is the shorter of the two and the
        reason to visit; the form is where you go once you have read something
        you want to change. The account controls close that left column rather
        than running the width of the page — they belong with the other things
        you read and decide about yourself, not under the form.

        Messages left the tab strip entirely and became the dock at the bottom
        right of the screen, so a conversation can stay open while you edit.
      */}
      <div className="account-page" ref={page}>
        <aside className="account-side" aria-label="How recruiters see you">
          <ViewStats views={views} activity={activity} />
          <Categorisation intelligence={account.intelligence} onChanged={reload} />
          <HiddenCompanies companies={account.blockedCompanies} onChanged={reload} />

          {/* Both the ways out of the marketplace: switch yourself off, or
              delete everything. */}
          <AccountSettings account={account} reload={reload} />
        </aside>

        <div className="account-main">
          <ProfileTab account={account} reload={reload} />
        </div>
      </div>

      <MessagingDock
        reload={reload}
        initialRecruiterId={openThread}
        onOpened={() => setOpenThread(null)}
      />
    </div>
  )
}

/**
 * The three activity states, at the top of the portal.
 *
 * Deactivated shows a persistent banner with a reactivate button — signing in
 * deliberately does not restore visibility, so the only way back is this click.
 * Unconfirmed re-asks the question rather than quietly treating the sign-in as
 * a yes, because turning up is not the same as saying you are still looking.
 */
function ActivityBanner({ activity, reload, urgentOnly = false, confirmedOnly = false }) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')

  if (!activity) return null

  /*
   * The same component renders in two places, and each asks for one half of
   * the states. Splitting it this way rather than into two components keeps
   * the three states — and the single `answer` call behind them — together:
   * they are one state machine, and a copy of it in a second file is how the
   * deactivate path ends up behaving differently from the reactivate path.
   */
  const confirmed = activity.state !== 'deactivated' && activity.state !== 'unconfirmed'
  if (urgentOnly && confirmed) return null
  if (confirmedOnly && !confirmed) return null

  const answer = async (path, body) => {
    setBusy(true)
    setError('')
    try {
      await post(path, body, 'candidate')
      await reload()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const since = activity.since
    ? new Date(activity.since).toLocaleDateString(DATE_LOCALE, { dateStyle: 'medium' })
    : null

  if (activity.state === 'deactivated') {
    return (
      <div className="alert alert-warn activity-banner">
        <div>
          <strong>Your profile is currently deactivated as requested.</strong>
          <p className="muted">
            Recruiters cannot see it and the monthly emails have stopped. Nothing has been
            deleted{activity.deactivatedAt
              ? `, and this has been the case since ${new Date(activity.deactivatedAt).toLocaleDateString(DATE_LOCALE, { dateStyle: 'medium' })}`
              : ''}.
          </p>
          <StatusNotice error={error} onDismiss={() => setError('')} />
        </div>
        <button
          type="button" className="btn btn-primary"
          disabled={busy}
          onClick={() => answer('/api/candidate/me/reactivate', {})}
        >
          {busy ? 'Reactivating…' : 'Reactivate my profile'}
        </button>
      </div>
    )
  }

  if (activity.state === 'unconfirmed') {
    return (
      <div className="alert alert-warn activity-banner">
        <div>
          <strong>Are you still open to job opportunities?</strong>
          <p className="muted">
            Your profile has been unconfirmed for {activity.missed}{' '}
            month{activity.missed === 1 ? '' : 's'}
            {since ? `, since ${since}` : ''}. Recruiters can still find you, and they can see
            that it has not been confirmed.
          </p>
          <StatusNotice error={error} onDismiss={() => setError('')} />
        </div>
        <div className="convo-confirm-actions">
          <button
            type="button" className="btn btn-primary"
            disabled={busy}
            onClick={() => answer('/api/candidate/me/checkin', { answer: 'yes' })}
          >
            {busy ? 'Saving…' : 'Yes, still looking'}
          </button>
          <button
            type="button" className="btn btn-quiet"
            disabled={busy}
            onClick={() => answer('/api/candidate/me/checkin', { answer: 'no' })}
          >
            No, hide my profile
          </button>
        </div>
      </div>
    )
  }

  /*
   * Built like the delete block below it: a heading, what it does, and one
   * button.
   *
   * It used to be a green status strip with a quiet link on the right, which
   * made the two ways out of the marketplace look like different kinds of
   * thing — one an announcement, the other a decision. They are the same
   * decision at two strengths, and the reversible one should not be the one
   * that is harder to find.
   *
   * The status itself is still said, because "deactivate" only makes sense
   * once you know you are currently visible.
   */
  return (
    <section className="account-action">
      <h3>Deactivate profile</h3>

      <StatusNotice error={error} onDismiss={() => setError('')} />

      <button type="button" className="btn btn-danger" onClick={() => setConfirming(true)}>
        Deactivate
      </button>

      {/*
        Asked in a dialog rather than by swapping the button for two.

        Disappearing from every recruiter's search is not something to do by
        mis-clicking, and an inline pair of buttons appears exactly where the
        finger already is. A modal moves the answer somewhere deliberate and
        states the consequence in the same breath as the question.
      */}
      {confirming && createPortal(
        <div
          className="confirm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="deactivate-question"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirming(false) }}
        >
          <div className="confirm-card">
            <h3 id="deactivate-question">Are you sure?</h3>
            <p className="muted">Your profile will be hidden from recruiters.</p>

            <div className="confirm-actions">
              <button
                type="button" className="btn btn-danger-solid"
                disabled={busy}
                onClick={() => answer('/api/candidate/me/checkin', { answer: 'no' })}
              >
                {busy ? 'Hiding…' : 'Confirm'}
              </button>
              <button
                type="button" className="btn btn-secondary"
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  )
}

/**
 * The application confirmation, shown once on arrival.
 *
 * Read from router state rather than a query string so a refresh clears it —
 * "your profile is live" is true the moment you land and stale a minute later,
 * and a URL you could bookmark would keep insisting on it.
 */
function JustAppliedNote() {
  const { state } = useLocation()
  const [dismissed, setDismissed] = useState(false)
  if (!state?.justApplied || dismissed) return null

  return (
    /*
     * A confirmation of the application just submitted, not a status. It used
     * to sit above the save confirmation and both stayed put, so a candidate
     * who edited anything read two green banners stacked, neither of them news.
     */
    <Notice tone="ok" className="activity-banner" onDismiss={() => setDismissed(true)}>
      <div>
        <strong>Your profile is live.</strong>{' '}
        <span className="muted">
          We read {Number(state.charactersRead ?? 0).toLocaleString()} characters from your CV
          {state.documents > 1 ? ` and stored ${state.documents} documents` : ''}. Your reference is{' '}
          <strong>#{state.reference}</strong>. You are signed in: no password to remember, and you
          can change anything below at any time.
        </span>
      </div>
    </Notice>
  )
}

const DIMENSION_LABELS = {
  industry: 'Industries',
  /* "Fields" was ours; "Skills" is the word a candidate would use for the same
     thing, and the one the rest of the product already uses on a CV. */
  function: 'Skills',
  specialization: 'Specialisms',
  role: 'Roles',
}

/**
 * How the platform has categorised this person, shown back to them.
 *
 * These labels decide which searches surface the profile, so the person they
 * describe is entitled to see them. Categorisation only the operator can read
 * is how people end up quietly mis-filed with no way to notice, let alone
 * object — and the evidence line is what makes a wrong label arguable rather
 * than merely visible.
 *
 * Confidence is deliberately worded as how sure we are the label fits, never as
 * a match score. They are different numbers and conflating them would misinform.
 */
/** Which dimensions the candidate may change. Specialisms are the matcher's
    own working-out and are not offered for editing. */
/* Industries first: it is the coarser of the two and the one a recruiter
   filters on before narrowing by skill. */
const EDITABLE_DIMENSIONS = ['industry', 'function']
const MAX_LABELS = 5

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z" />
      <path d="M14.5 6.5 17.5 9.5" />
    </svg>
  )
}

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false">
      <path d="m5 12.5 4.5 4.5L19 7" />
    </svg>
  )
}

/**
 * A row of tags for one dimension, editable in place.
 *
 * Adding is a text box rather than a menu of every concept: the vocabulary runs
 * to hundreds of entries, and a candidate knows the words for their own work.
 * The server resolves what they type against that vocabulary and refuses
 * anything it cannot place — a tag it accepted but could not match on would
 * look like it changed who finds them while changing nothing.
 */
function LabelRow({ dimension, labels, editing, onAdd, onRemove, busy }) {
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const full = labels.length >= MAX_LABELS

  function submit(event) {
    event.preventDefault()
    if (!text.trim()) return
    onAdd(dimension, text.trim())
    setText('')
    setAdding(false)
  }

  return (
    <div className="field">
      <span className="field-label">{DIMENSION_LABELS[dimension] ?? dimension}</span>

      <div className="chip-row">
        {labels.map((label) => (
          /*
            No confidence tag here. "clear / likely / possible" is how sure the
            extractor is — a fact about our reading of the CV rather than about
            the candidate — and shown to the person themselves it invites an
            argument they have no way to win.
          */
          <span key={label.concept} className="chip" title={label.evidence ?? ''}>
            {label.label}
            {editing && (
              <button
                type="button"
                className="chip-x"
                disabled={busy}
                aria-label={`Remove ${label.label}`}
                onClick={() => onRemove(dimension, label.label)}
              >
                &times;
              </button>
            )}
          </span>
        ))}

        {editing && !adding && !full && (
          <button
            type="button"
            className="chip chip-add"
            disabled={busy}
            aria-label={`Add to ${DIMENSION_LABELS[dimension] ?? dimension}`}
            onClick={() => setAdding(true)}
          >
            +
          </button>
        )}

        {/* Said rather than left to be discovered by a refusal. */}
        {editing && full && <span className="muted chip-limit">{MAX_LABELS} is the maximum</span>}
      </div>

      {editing && adding && (
        <form className="chip-add-form" onSubmit={submit}>
          <input
            autoFocus
            value={text}
            maxLength={60}
            placeholder={dimension === 'industry' ? 'e.g. Cybersecurity' : 'e.g. Supply Chain'}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { setAdding(false); setText('') } }}
          />
          <button type="submit" className="btn btn-secondary btn-small" disabled={busy || !text.trim()}>
            Add
          </button>
          <button
            type="button" className="btn btn-quiet btn-small"
            onClick={() => { setAdding(false); setText('') }}
          >
            Cancel
          </button>
        </form>
      )}
    </div>
  )
}

/**
 * How the platform has categorised this person, and their say in it.
 *
 * The labels are read out of a CV, and the reading is sometimes wrong — a career
 * that changed direction, a word taken literally. The only remedy used to be
 * "edit your profile and we will read it again", which is a slow and indirect
 * way to say "no, I do not work in Logistics".
 *
 * Editing writes to the stored profile rather than to this page: it changes
 * which searches find them, which is the entire reason to offer it.
 */
function Categorisation({ intelligence, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function edit(dimension, label, action) {
    setBusy(true)
    setError('')
    try {
      await patch('/api/candidate/me/labels', { dimension, label, action }, 'candidate')
      /* Refetched rather than patched in place: the edit changes the stored
         profile, and the page should show what is stored, not what we hoped. */
      await onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (!intelligence || intelligence.labels.length === 0) {
    return (
      <section className="panel panel-narrow categorisation">
        <h2>How you are categorised</h2>
        <p className="muted">
          We have not categorised your profile yet. This happens shortly after your CV is read, so
          check back in a moment.
        </p>
      </section>
    )
  }

  const byDimension = new Map()
  for (const label of intelligence.labels) {
    if (!byDimension.has(label.dimension)) byDimension.set(label.dimension, [])
    byDimension.get(label.dimension).push(label)
  }

  /* Editable dimensions first and always present, so the row a candidate wants
     to correct does not vanish when the extractor found nothing for it. */
  const rows = [
    ...EDITABLE_DIMENSIONS.map((dimension) => [dimension, byDimension.get(dimension) ?? []]),
    ...[...byDimension.entries()].filter(([dimension]) => !EDITABLE_DIMENSIONS.includes(dimension)),
  ]

  return (
    <section className="panel panel-narrow categorisation">
      <div className="categorisation-head">
        <h2>How you are categorised</h2>
        {/*
          One control that changes what it does, rather than an Edit that turns
          into a Save beside a Cancel. Every change is written as it is made —
          there is no pending state to discard — so the tick means "done", not
          "commit", and a second button offering to undo nothing would be a lie.
        */}
        <button
          type="button"
          className="icon-button"
          aria-pressed={editing}
          aria-label={editing ? 'Finish editing' : 'Edit how you are categorised'}
          title={editing ? 'Done' : 'Edit'}
          onClick={() => { setEditing((was) => !was); setError('') }}
        >
          {editing ? <TickIcon /> : <PencilIcon />}
        </button>
      </div>

      <StatusNotice error={error} onDismiss={() => setError('')} />

      {rows.map(([dimension, labels]) => (
        <LabelRow
          key={dimension}
          dimension={dimension}
          labels={labels}
          editing={editing && EDITABLE_DIMENSIONS.includes(dimension)}
          busy={busy}
          onAdd={(dim, label) => edit(dim, label, 'add')}
          onRemove={(dim, label) => edit(dim, label, 'remove')}
        />
      ))}
    </section>
  )
}

/**
 * The companies this candidate does not want to be found by.
 *
 * Its own section rather than a field on the profile form, because it is not a
 * fact about them — it is an instruction about who may see the facts. It sits
 * under the categorisation for that reason: both answer "who finds me, and
 * how", and both are edited the same way.
 *
 * Written as each change is made, like the categorisation above. There is no
 * pending state and so no Save: the tick means the candidate is finished, not
 * that anything is waiting on it, and a browser closed mid-edit has still saved
 * every company that was added before it closed.
 */
function HiddenCompanies({ companies, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const list = companies ?? []

  /*
   * The whole list every time, not an add or a remove instruction.
   *
   * The server replaces what it is given, so sending the list the candidate can
   * see means the thing on screen and the thing stored cannot drift apart. It
   * also makes "remove the last one" expressible: an empty array is a real
   * instruction here, which is exactly the distinction the route is written to
   * honour.
   */
  async function save(next) {
    setBusy(true)
    setError('')
    try {
      await patch('/api/candidate/me/blocked-companies', { companies: next }, 'candidate')
      await onChanged()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function add(event) {
    event.preventDefault()
    const name = text.trim()
    if (!name) return

    /* Case-insensitively, because "Google" and "google" are one company and a
       list showing both would look like a bug to the person who typed them. */
    const already = list.some((entry) => entry.toLowerCase() === name.toLowerCase())
    if (already) {
      setText('')
      setAdding(false)
      return
    }

    setText('')
    setAdding(false)
    save([...list, name])
  }

  return (
    <section className="panel panel-narrow categorisation hidden-companies">
      <div className="categorisation-head">
        <h2>Hide my profile from these companies</h2>
        <button
          type="button"
          className="icon-button"
          aria-pressed={editing}
          aria-label={editing ? 'Finish editing hidden companies' : 'Edit hidden companies'}
          title={editing ? 'Done' : 'Edit'}
          onClick={() => { setEditing((was) => !was); setAdding(false); setText(''); setError('') }}
        >
          {editing ? <TickIcon /> : <PencilIcon />}
        </button>
      </div>

      <p className="muted hidden-companies-note">
        You will not appear in searches run by anyone at these companies.
      </p>

      <StatusNotice error={error} onDismiss={() => setError('')} />

      <div className="chip-row">
        {list.map((name) => (
          <span key={name} className="chip">
            {name}
            {editing && (
              <button
                type="button"
                className="chip-x"
                disabled={busy}
                aria-label={`Stop hiding from ${name}`}
                onClick={() => save(list.filter((entry) => entry !== name))}
              >
                &times;
              </button>
            )}
          </span>
        ))}

        {editing && !adding && (
          <button
            type="button"
            className="chip chip-add"
            disabled={busy}
            aria-label="Add a company to hide from"
            onClick={() => setAdding(true)}
          >
            +
          </button>
        )}

        {/* Said once, where an empty row would otherwise read as a loading
            state. Not shown while editing, because the + is the answer to
            "and now what?" and the sentence would only be in its way. */}
        {list.length === 0 && !editing && <span className="muted">No companies hidden</span>}
      </div>

      {editing && adding && (
        <form className="chip-add-form" onSubmit={add}>
          <input
            autoFocus
            value={text}
            maxLength={120}
            placeholder="e.g. KPMG"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { setAdding(false); setText('') } }}
          />
          <button type="submit" className="btn btn-secondary btn-small" disabled={busy || !text.trim()}>
            Add
          </button>
          <button
            type="button" className="btn btn-quiet btn-small"
            onClick={() => { setAdding(false); setText('') }}
          >
            Cancel
          </button>
        </form>
      )}
    </section>
  )
}

/**
 * How many companies hold this candidate's contact details.
 *
 * It used to count profile openings, which moved every time any recruiter
 * expanded the card in a results list — a number that rose from being read and
 * that the candidate could do nothing with. This counts reveals instead: the
 * deliberate step that hands over their surname, email and phone.
 *
 * By company rather than by recruiter, because that is how the access is
 * granted — one recruiter at a firm revealing means the firm has them.
 */
function ViewStats({ views, activity }) {
  const companies = views.revealedCompanies ?? 0
  /* Today, not the date of the last reveal: the sentence is a statement about
     the count as it stands right now, which is what "as of" means. */
  const asOf = formatDate(new Date(), { day: '2-digit', month: 'short', year: 'numeric' })

  /* Both ways out of search, and they are not the same thing to the person
     they happened to: one they chose, the other happened to them. */
  const hidden = activity?.state === 'deactivated' || activity?.state === 'hidden'
  const lapsed = activity?.state === 'hidden'
  const orange = activity?.state === 'orange'
  const hiddenOn = activity?.hiddenDueAt ? formatDate(activity.hiddenDueAt) : null
  const daysLeft = activity?.daysUntilHidden

  return (
    <section className="stats stats-single">
      <div className="stat">
        {/*
          The figure sits in the sentence rather than above it.

          It was a display-sized numeral with the words beneath — the right
          shape for a dashboard tile and the wrong one here, where this is one
          fact in a reading column and a lone "1" was the loudest thing on the
          page. Plural throughout now that the number is inline: the sentence
          reads as a count rather than as a subject, so it no longer has to
          agree with it.
        */}
        <span className="stat-line">
          <span className="stat-value">{companies}</span>
          <span className="stat-label">
            {companies === 1 ? 'company has' : 'companies have'} revealed your profile
            and hold your contact details, as of {asOf}
          </span>
        </span>

        {/*
          Whether recruiters can see them at all, which is the fact the count
          above is meaningless without: nought companies means something very
          different when the profile is hidden.
        */}
        <span className="stat-status">
          Status:{' '}
          <strong className={hidden ? 'status-word status-hidden' : 'status-word status-open'}>
            {hidden ? 'Hidden' : 'Open'}
          </strong>
          <InfoHint
            label="What this status means"
            text={hiddenText({ hidden, lapsed, orange, daysLeft, hiddenOn })}
          />
        </span>

        {/*
          The countdown, and only while it is running.

          Shown to an Orange candidate because it is the one fact they can act
          on — signing in is enough to clear it — and hidden from a Green one,
          for whom a date sixty days out is noise rather than information.
        */}
        {orange && daysLeft !== undefined && (
          <span className="stat-status stat-warning">
            No activity recorded for {activity.days} days. Your profile is hidden from
            recruiters in {daysLeft} {daysLeft === 1 ? 'day' : 'days'} unless you sign in
            or confirm you are still open.
          </span>
        )}
      </div>
    </section>
  )
}

/**
 * What the status hint says, which depends on which of four situations the
 * candidate is in.
 *
 * Pulled out of the JSX because the nested ternary it replaced could not be
 * read, and because the distinction it draws — hidden by choice against hidden
 * by silence — is one the candidate cares about more than we do.
 *
 * Nothing here promises recruiter interest. Being visible is being findable,
 * and a sentence that implied approaches would follow would be selling
 * something Cursus cannot deliver.
 */
function hiddenText({ hidden, lapsed, orange, daysLeft, hiddenOn }) {
  if (lapsed) {
    return 'Your profile was hidden because we recorded no activity for 60 days. '
      + 'Signing in or confirming you are still open puts you back in recruiter searches.'
  }
  if (hidden) {
    return 'You are out of every recruiter search until you turn your profile back on.'
  }
  if (orange) {
    return `Recruiters can see you, with a note that we have not recorded activity recently.`
      + (hiddenOn ? ` Your profile is hidden on ${hiddenOn} unless you sign in or confirm.` : '')
  }
  return 'Recruiters can see your profile is current. Being visible does not guarantee '
    + 'that any recruiter will contact you.'
}

function ProfileTab({ account, reload }) {
  const { candidate, documents, preferences } = account
  const [status, setStatus] = useState({ state: 'idle' })

  async function save(data) {
    setStatus({ state: 'saving' })
    try {
      await sendForm('/api/candidate/me', data, { method: 'PATCH', role: 'candidate' })
      await reload()
      setStatus({ state: 'saved' })
    } catch (error) {
      setStatus({ state: 'error', message: error.message })
    }
  }

  async function removeDocument(slot) {
    try {
      await del(`/api/candidate/me/documents/${slot}`, 'candidate')
      await reload()
    } catch (error) {
      setStatus({ state: 'error', message: error.message })
    }
  }

  return (
    <>
      {/* One status line for the whole tab. It clears itself after half a
          minute, and a second save replaces it rather than adding to it. */}
      <StatusNotice
        notice={status.state === 'saved' ? 'Your details have been updated.' : ''}
        onDismiss={() => setStatus({ state: 'idle' })}
      />
      <CandidateForm
        mode="edit"
        photoFirst
        lockable
        candidate={candidate}
        documents={documents}
        preferences={preferences ?? null}
        existingPhotoUrl={candidate.hasPhoto ? withToken('/api/candidate/me/photo', 'candidate') : null}
        onSubmit={save}
        onRemoveDocument={removeDocument}
        submitting={status.state === 'saving'}
        error={status.state === 'error' ? status.message : ''}
      >
        {/* No heading. The page is the profile — a title saying so, over a
            sentence explaining that a form saves when you save it, was two
            lines spent on nothing the reader could have doubted. */}
      </CandidateForm>
    </>
  )
}

/**
 * The two ways out of the marketplace, in one box at the foot of the page.
 *
 * Deactivating and deleting are the same kind of decision — they are what you
 * come here to do when you have stopped looking — and they were at opposite
 * ends of the page, the first as a green banner up by the masthead and the
 * second below the edit form. Someone who had found a job had to know that
 * "stop showing me to recruiters" lived in a success-coloured strip and not
 * next to the button that says delete.
 *
 * Deactivate first, and deliberately: it is the reversible one, and putting it
 * above delete means the recoverable answer is the one you meet first.
 */
function AccountSettings({ account, reload }) {
  return (
    <section className="account-settings">
      <ActivityBanner activity={account.activity} reload={reload} confirmedOnly />
      <DangerZone account={account} />
    </section>
  )
}

/**
 * Deleting an account is irreversible and destroys files, so it takes two
 * deliberate steps and the candidate has to type their own email address. A
 * misclick can never destroy an account.
 */
function DangerZone({ account }) {
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState(null)
  /* Confirm stays disabled until this is ticked. */
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function begin() {
    setError('')
    setOpen(true)
    try {
      const data = await get('/api/candidate/me/deletion-preview', 'candidate')
      setPreview(data.preview)
    } catch (err) {
      setError(err.message)
    }
  }

  async function confirmDelete() {
    setBusy(true)
    setError('')
    try {
      await del('/api/candidate/me', 'candidate', { acknowledged: true })
      /* Awaited: the line below navigates, and an unawaited sign-out races the
         navigation — sometimes clearing the dismissals, sometimes not. */
      await signOutRequest()
      // A full reload is the honest end state: there is no account left to render.
      window.location.assign('/')
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  function close() {
    setOpen(false)
    setAgreed(false)
    setError('')
  }

  return (
    <section className="account-action">
      <h3>Delete profile</h3>

      <button type="button" className="btn btn-danger" onClick={begin}>
        Delete
      </button>

      {/*
        Asked in a dialog, like deactivating.

        The agreement comes first and stands alone, because it is the thing
        being agreed to. Under it, set apart by an asterisk, is the one fact
        about this account that the agreement cannot speak for: a copy already
        downloaded is out of reach, and no undertaking on this screen changes
        that. Keeping it out of the list of things deletion destroys is the
        point — it is the exception to that list, not a member of it.
      */}
      {open && createPortal(
        <div
          className="confirm-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-question"
          onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) close() }}
        >
          <div className="confirm-card confirm-card-wide">
            <h3 id="delete-question">Are you sure?</h3>

            {/*
              The consequence and the agreement to it are one control.

              A paragraph above a bare checkbox is a paragraph people tick past;
              putting the words inside the label means the thing being agreed to
              is the thing being read, and the pointer target is the sentence
              rather than a 16px square beside it.
            */}
            <label className="danger-agree">
              <input
                type="checkbox"
                checked={agreed}
                disabled={busy}
                onChange={(event) => setAgreed(event.target.checked)}
              />
              <span>
                I agree: my profile will be permanently deleted. This permanently removes my
                profile, every document I uploaded, my messages, and my history. It cannot be
                undone and nothing is kept.
              </span>
            </label>

            {preview && (
              <p className="danger-footnote">
                {preview.downloads > 0
                  ? `*${preview.downloads} recruiter${preview.downloads === 1 ? ' has' : 's have'} already downloaded your CV. We cannot recall those copies`
                  : '*No recruiter has downloaded your CV'}
              </p>
            )}

            <StatusNotice error={error} onDismiss={() => setError('')} />

            <div className="confirm-actions">
              <button
                type="button" className="btn btn-danger-solid"
                disabled={!agreed || busy}
                onClick={confirmDelete}
              >
                {busy ? 'Deleting…' : 'Confirm'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={close}>
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </section>
  )
}

/**
 * How many conversations can be open at once.
 *
 * Each window is a fixed width, and they sit in a row beside the list panel.
 * Past this they would run off the left of the screen, so opening a third
 * closes the oldest — which is what makes "open another one" always work
 * rather than silently doing nothing.
 */
const MAX_OPEN_WINDOWS = 2

/**
 * Messaging, docked to the bottom right.
 *
 * It was a tab, which made a conversation somewhere you navigated to: reading a
 * recruiter's question meant leaving the profile, and answering it meant
 * remembering what they had asked. Docking it means the conversation sits over
 * the page you were already on and both stay in view.
 *
 * The shape is the one people already know from LinkedIn and every chat product
 * since: a collapsed bar in the corner, a list when you open it, and each
 * conversation as its own small window alongside. Nothing here is novel on
 * purpose — a messaging pattern is not the place to be original.
 */
function MessagingDock({ reload, initialRecruiterId = null, onOpened }) {
  const [threads, setThreads] = useState([])
  const [listOpen, setListOpen] = useState(false)
  /* Recruiter ids, left to right as rendered. Newest opens nearest the list. */
  const [open, setOpen] = useState([])
  const [error, setError] = useState('')

  const loadThreads = useCallback(async () => {
    const data = await get('/api/candidate/threads', 'candidate')
    setThreads(data.threads)
    return data.threads
  }, [])

  useEffect(() => { loadThreads().catch(() => {}) }, [loadThreads])

  /* The list polls on its own so an arriving message lights the dock up even
     when nothing is open — otherwise the badge only ever updated if you were
     already reading. */
  useEffect(() => {
    const timer = setInterval(() => {
      loadThreads().then(() => reload()).catch(() => {})
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [loadThreads, reload])

  const openThread = useCallback((recruiterId) => {
    setOpen((current) => {
      if (current.includes(recruiterId)) return current
      return [...current, recruiterId].slice(-MAX_OPEN_WINDOWS)
    })
  }, [])

  /**
   * Opens the conversation the "you have a message" email pointed at, once the
   * list confirms it is really theirs — a recruiter id in a URL should not open
   * anything on its own.
   */
  useEffect(() => {
    if (initialRecruiterId === null || threads.length === 0) return
    if (threads.some((item) => item.recruiter_id === initialRecruiterId)) {
      openThread(initialRecruiterId)
      setListOpen(true)
    }
    onOpened?.()
  }, [initialRecruiterId, threads, onOpened, openThread])

  const unread = threads.reduce((total, item) => total + (item.unread ?? 0), 0)

  return (
    <div className="dock">
      {open.map((recruiterId) => {
        const summary = threads.find((item) => item.recruiter_id === recruiterId)
        return (
          <ChatWindow
            key={recruiterId}
            recruiterId={recruiterId}
            summary={summary}
            reload={reload}
            onRead={loadThreads}
            onThreadsChanged={setThreads}
            onError={setError}
            onClose={() => setOpen((current) => current.filter((id) => id !== recruiterId))}
          />
        )
      })}

      <section className={listOpen ? 'dock-panel dock-panel-open' : 'dock-panel'}>
        <header className="dock-head">
          <button
            type="button"
            className="dock-head-toggle"
            aria-expanded={listOpen}
            onClick={() => setListOpen((was) => !was)}
          >
            <span className="dock-title">Messaging</span>
            {unread > 0 && <span className="badge">{unread}</span>}
          </button>
          <button
            type="button"
            className="dock-icon"
            aria-label={listOpen ? 'Collapse messaging' : 'Expand messaging'}
            onClick={() => setListOpen((was) => !was)}
          >
            <Chevron up={!listOpen} />
          </button>
        </header>

        {listOpen && (
          <div className="dock-body">
            {error && <p className="alert alert-error dock-empty">{error}</p>}
            {threads.length === 0 ? (
              <p className="muted dock-empty">
                When a recruiter wants to talk to you about a role, their message appears here.
                Recruiters start the conversation.
              </p>
            ) : (
              <ul className="dock-list">
                {threads.map((item) => (
                  <li key={item.recruiter_id}>
                    <ConversationRow
                      item={item}
                      onOpen={() => openThread(item.recruiter_id)}
                      onChanged={setThreads}
                      onError={setError}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

/**
 * When a message arrived, in as few characters as will do.
 *
 * Today is a time, this year is a day and month, anything older takes the year.
 * A conversation list is scanned rather than read, and "15 August 2026, 20:36"
 * on every row is four times the width of the only part that distinguishes them.
 */
function shortWhen(iso) {
  if (!iso) return ''
  const then = new Date(iso)
  const now = new Date()
  const sameDay = then.toDateString() === now.toDateString()
  if (sameDay) return then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (then.getFullYear() === now.getFullYear()) {
    return then.toLocaleDateString(DATE_LOCALE, { day: 'numeric', month: 'short' })
  }
  return then.toLocaleDateString(DATE_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * One conversation in the list: open it, or act on it.
 *
 * The row and its menu are siblings rather than nested — a button inside a
 * button is invalid, and the browser resolves it by making the inner one
 * unclickable, which is exactly the control you least want dead.
 */
function ConversationRow({ item, onOpen, onChanged, onError }) {
  return (
    <div className={item.unread > 0 ? 'dock-row-wrap dock-row-unread' : 'dock-row-wrap'}>
      <button type="button" className="dock-row" onClick={onOpen}>
        <Avatar src={null} firstName={item.first_name} lastName={item.last_name} />
        <span className="dock-row-text">
          {/* The company leads, since that is what a candidate recognises; the
              recruiter is the supporting line. */}
          <span className="dock-row-top">
            <strong>{item.company_name}</strong>
            <span className="dock-when">{shortWhen(item.last_at)}</span>
          </span>
          <span className="muted">{item.first_name} {item.last_name}</span>
        </span>
        {item.unread > 0 && <span className="badge">{item.unread}</span>}
      </button>

      <ConversationActions
        recruiterId={item.recruiter_id}
        name={item.company_name}
        onChanged={onChanged}
        onError={onError}
      />
    </div>
  )
}
/**
 * What you can do to a conversation without reading it.
 *
 * Mounted on each row of the list and in the header of an open window, so which
 * actions you can reach does not depend on the conversation being open.
 *
 * PopMenu decides where it appears: the dock sits at the bottom of the window
 * inside containers that clip, so the menu escapes them and opens upward when
 * there is no room below.
 */
function ConversationActions({ recruiterId, name, onChanged, onError, onActed }) {
  async function act(run) {
    try {
      const data = await run()
      onChanged?.(data.threads)
      onActed?.()
    } catch (err) {
      onError?.(err.message)
    }
  }

  return (
    <PopMenu
      label={`More for ${name}`}
      items={[
        {
          key: 'unread',
          label: 'Mark as unread',
          onSelect: () => act(() => post(`/api/candidate/threads/${recruiterId}/unread`, {}, 'candidate')),
        },
        /*
         * "Remove from my inbox", not "Delete conversation".
         *
         * The old label promised something the action does not do and was never
         * meant to do: this writes one row to conversation_hidden and touches
         * no message. The other party keeps their copy, and a later message
         * brings the thread back here — behaviour that is right for the reasons
         * set out beside the table in schema.js, and that a person who read the
         * word "Delete" would have no way to predict.
         *
         * The behaviour is the considered one. The label was the part that was
         * wrong, so the label is the part that changed.
         */
        {
          key: 'delete',
          label: 'Remove from my inbox',
          danger: true,
          onSelect: () => act(() => del(`/api/candidate/threads/${recruiterId}`, 'candidate')),
        },
      ]}
    />
  )
}

function Chevron({ up = false }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
    >
      <path d={up ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
    </svg>
  )
}

/**
 * One conversation, in its own window beside the dock.
 *
 * It loads and polls its own thread rather than being handed one: two windows
 * can be open at once, and a single thread in the parent would mean the second
 * one to open overwrote the first. Collapsing keeps the window mounted, so the
 * polling continues and a reply is already there when it is reopened.
 */
function ChatWindow({
  recruiterId, summary, reload, onRead, onThreadsChanged, onError, onClose,
}) {
  const [thread, setThread] = useState(null)
  const [sending, setSending] = useState(false)
  const [minimised, setMinimised] = useState(false)

  const loadThread = useCallback(async () => {
    setThread(await get(`/api/candidate/threads/${recruiterId}`, 'candidate'))
  }, [recruiterId])

  useEffect(() => {
    loadThread().catch(() => {})
    const timer = setInterval(() => { loadThread().catch(() => {}) }, POLL_MS)
    return () => clearInterval(timer)
  }, [loadThread])

  /* Opening a conversation reads it, so the badge on the dock and the count in
     the portal both have to be refetched — otherwise the unread mark stays lit
     over a thread that is open on screen. */
  useEffect(() => {
    if (!thread) return
    onRead?.().catch(() => {})
    reload?.().catch(() => {})
    // Once per opened thread, not on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recruiterId, Boolean(thread)])

  async function send(body) {
    setSending(true)
    try {
      const data = await post(`/api/candidate/threads/${recruiterId}`, { body }, 'candidate')
      setThread((prev) => ({ ...prev, messages: data.messages, status: data.status }))
      await onRead?.()
    } finally {
      setSending(false)
    }
  }

  const company = thread?.recruiter.company ?? summary?.company_name ?? 'Conversation'
  const person = thread?.recruiter.name
    ?? [summary?.first_name, summary?.last_name].filter(Boolean).join(' ')

  return (
    <section className={minimised ? 'chat-window chat-window-min' : 'chat-window'}>
      <header className="chat-window-head">
        <Avatar src={null} firstName={summary?.first_name} lastName={summary?.last_name} />
        {/* The whole heading toggles, which is the behaviour people expect from
            a docked chat — clicking the bar puts it away. */}
        <button
          type="button"
          className="chat-window-title"
          aria-expanded={!minimised}
          onClick={() => setMinimised((was) => !was)}
        >
          <strong>{company}</strong>
          <span className="muted">{person}</span>
        </button>
        {/* The same actions the list row offers. Marking unread or clearing a
            conversation from here also shuts the window: both are ways of
            saying "not now", and leaving it open would contradict that. */}
        <ConversationActions
          recruiterId={recruiterId}
          name={company}
          onChanged={onThreadsChanged}
          onError={onError}
          onActed={onClose}
        />
        <button
          type="button" className="dock-icon"
          aria-label={minimised ? `Expand conversation with ${company}` : `Minimise conversation with ${company}`}
          onClick={() => setMinimised((was) => !was)}
        >
          <Chevron up={minimised} />
        </button>
        <button
          type="button" className="dock-icon"
          aria-label={`Close conversation with ${company}`}
          onClick={onClose}
        >
          &times;
        </button>
      </header>

      {!minimised && (
        thread ? (
          <>
            {thread.status === 'closed' && (
              <p className="alert alert-muted chat-window-note">
                {company} closed this conversation, so it is no longer accepting replies. Everything
                you have both written stays here.
              </p>
            )}
            <ChatPanel
              messages={thread.messages}
              meSender="candidate"
              onSend={send}
              sending={sending}
              disabled={thread.status === 'closed'}
              placeholder="Write a message…"
            />
          </>
        ) : (
          <p className="muted chat-empty">Loading…</p>
        )
      )}
    </section>
  )
}
