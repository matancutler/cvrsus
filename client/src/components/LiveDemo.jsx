import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import CompanySignUpForm from './CompanySignUpForm.jsx'
import { CommentIcon } from './CommentsPopover.jsx'
import SearchHero from './SearchHero.jsx'
import { get, post, sendForm } from '../api.js'
import scoreBand from '../scoreBand.js'
import useDialogFocus from '../useDialogFocus.js'
import PersonIcon from './PersonIcon.jsx'

/**
 * The live JD demo: paste a real job description, see real matches, masked.
 *
 * An overlay rather than a page, and that is the whole design. A recruiter who
 * is reading the landing page and decides to try it should still be reading the
 * landing page when they close it — same scroll position, same argument, no
 * navigation. So this mounts over the page, the page stays where it was, and
 * closing puts the recruiter back exactly where they were standing.
 *
 * Three states live in here, stacked rather than swapped:
 *
 *   1. the demo itself — job description in, ranked masked cards out;
 *   2. the sign-up gate, opened when somebody presses Reveal, drawn over the
 *      results rather than replacing them;
 *   3. the confirmation that their account is in review.
 *
 * The results are never unmounted while the gate is open. Abandoning the
 * sign-up has to return the recruiter to the list they were looking at, with
 * the same search and the same ranking — not to an empty form.
 */

/** The eye. The reveal mark everywhere else in the product. */
function Eye() {
  return (
    <svg
      viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M1.8 12S5.8 5 12 5s10.2 7 10.2 7-4 7-10.2 7S1.8 12 1.8 12Z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  )
}

/** The same eye struck through: nobody has revealed this person yet. */
function EyeOff() {
  return (
    <svg
      className="eye-icon" viewBox="0 0 24 24" width="16" height="16" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M1.6 12S5.3 5.2 12 5.2 22.4 12 22.4 12 18.7 18.8 12 18.8 1.6 12 1.6 12Z" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M4 20 20 4" />
    </svg>
  )
}

/**
 * The workspace rail, shown and not wired.
 *
 * `inert` rather than `disabled` on each control: it removes the whole subtree
 * from the tab order and from the accessibility tree in one attribute, so a
 * keyboard cannot land on a dead button and a screen reader is not read a menu
 * that does nothing. Written as a string because React 18 passes unknown
 * attributes through but drops boolean `true` for ones it does not know.
 *
 * The searches list shows the one search this visitor has run, which is the
 * truth: the history is a real feature and it is empty until you use it.
 */
function DemoRail({ title, hasSearch }) {
  return (
    <aside className="demo-rail" inert="" aria-hidden="true">
      <div className="demo-rail-new"><span aria-hidden="true">+</span> New search</div>

      {/*
        Both places a recruiter goes between searches, in the panel's own
        `.ws-nav` with the panel's own count pill — not a lookalike, so the two
        cannot drift the way "Folders (3)" already had from the pill the rail
        started using.

        Triage belongs here because leaving it out described a product with one
        destination. It is scenery like everything else in this aside, which is
        inert as a whole: there is no button to press and none is implied.
      */}
      <nav className="ws-nav">
        <div className="ws-nav-item">Folders<span className="ws-nav-count">3</span></div>
        <div className="ws-nav-item">Triage<span className="ws-nav-count">2</span></div>
      </nav>

      <div className="demo-rail-history">
        <p className="demo-rail-heading">Searches</p>
        {/*
          The visitor's own search sits above a few earlier ones.

          A rail that is empty until you type shows the feature at its least
          convincing — the history is the part that makes this a workspace
          rather than a search box, and it cannot fill itself for somebody who
          has just arrived. These are scenery, like the rest of the rail, and
          the whole panel is inert so none of them can be pressed.
        */}
        {hasSearch && (
          <>
            <p className="demo-rail-day">Today</p>
            <div className="demo-rail-item demo-rail-item-on">{title || 'Your search'}</div>
          </>
        )}

        <p className="demo-rail-day">Previous 30 days</p>
        {[
          'Senior Backend Engineer, Tel Aviv',
          'Product Designer (B2B SaaS)',
          'Data Analyst, 3+ years',
        ].map((name) => (
          <div key={name} className="demo-rail-item">{name}</div>
        ))}
      </div>

      <div className="demo-rail-account">
        <span className="demo-rail-avatar"><PersonIcon /></span>
        <span className="demo-rail-account-text">
          <strong>CVRSVS</strong>
          <span className="muted">Live Demo</span>
        </span>
      </div>
    </aside>
  )
}

/**
 * One masked candidate.
 *
 * Everything shown here arrived already masked from the server — there is no
 * hidden full record behind it being covered up with styling. What is missing
 * from the card is missing from the response.
 */
/**
 * One masked candidate, in the product's own result row.
 *
 * Deliberately the same class names the authenticated list uses — .result,
 * .result-main, .result-identity, .score — rather than a parallel set that
 * merely resembles them. A demo whose rows are a lookalike teaches a layout the
 * recruiter will never see again; sharing the stylesheet means the two cannot
 * drift, and anything the real row gains it gains here.
 *
 * Everything shown arrived already masked from the server. What is missing from
 * this row is missing from the response, not hidden by styling.
 */
function DemoCard({ card, onOpen, onReveal }) {
  const band = scoreBand(card.score)

  return (
    <li className="result">
      <div
        className="result-main" onClick={onOpen} role="button" tabIndex={0}
        title="Open this candidate"
        /* Only keystrokes that land on the row itself. Save and Reveal are real
           buttons inside it, and without this the row's handler called
           preventDefault on their keydown — cancelling the click the browser
           was about to synthesise — and then opened the profile instead. A
           keyboard visitor could not press Reveal at all. */
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() }
        }}
      >
        {/*
          Photograph and identity are one thing on the left, exactly as they are
          in the authenticated row.

          `.result-main` is a three-track grid — [lead] [score] [space] — and
          this used to hand it four children: a rank, a portrait, an identity
          and a side. The fourth wrapped onto a row of its own, so the score sat
          under the card instead of on its centre line, and the rank column the
          real product removed was still being drawn here. Sharing a stylesheet
          only prevents drift if the markup underneath it matches.
        */}
        <span className="result-lead">
          <span className="result-portrait">
            {/* No photograph before a reveal, so the same silhouette the product
                shows for anyone without one. */}
            {/* `.result-avatar` is the 46px row size. `.avatar` alone is the
                92px one the profile editor uses, which left about 29px for the
                name on a 320px screen — and `.avatar-placeholder` has never had
                a rule of its own to correct it. */}
            <span className="result-avatar avatar-empty"><PersonIcon /></span>
          </span>

          {/* Name and availability only. What the person says and how they
              scored sit in the band below, across the whole row — the panel
              moved them out of this column when a 200px "two line" preview
              turned out to be four words a line. */}
          <div className="result-identity">
            <h3>{card.title ?? 'Profile still being read'}</h3>
            <p className="muted">
              {[card.location, card.experience, card.availability].filter(Boolean).join(' · ')}
            </p>
          </div>
        </span>

        {/* The number alone, out of a hundred, on the capacity line. The
            caption under it said "match", which is the axis and not the unit. */}
        <div className="result-side">
          <div className={`score score-${band}`}>
            <span className="score-value">{Math.round(card.score)}%</span>
          </div>
        </div>

        {/* The third track. Empty here — the authenticated row carries the
            team's tags in it — but present, because it is what makes the score
            sit on the card's centre line rather than left of it. */}
        <span className="result-spacer" />

        {/*
          The corner, and the one thing in it that works.

          Reveal was a filled button in the action column beside a muted Save.
          The panel has since moved every per-row action into this corner and
          made Reveal the struck-through eye, first in the group — so a demo
          that keeps the old pair teaches a row the recruiter will never meet.
          The loud call to action is not lost: opening a card still leads to a
          full-width Reveal, which is where the panel puts it too.

          The other three are drawn and inert. `inert` rather than `disabled`
          takes the whole subtree out of the tab order and the accessibility
          tree, so a keyboard cannot land on a dead control and a screen reader
          is not read a menu that does nothing — the same treatment the rail
          gets. Its own stopPropagation, because this sits inside a row that is
          itself a button: without it a press on Reveal opened the profile
          underneath as well, two dialogs in one commit.
        */}
        <span
          className="result-menu"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="icon-button result-reveal"
            onClick={(event) => { event.stopPropagation(); onReveal() }}
            title="Reveal this candidate — their name, contact details and CV"
            aria-label="Reveal this candidate"
          >
            <EyeOff />
          </button>
          <span className="icon-button" inert="" aria-hidden="true">+</span>
          <span className="icon-button" inert="" aria-hidden="true"><CommentIcon /></span>
          <span className="icon-button" inert="" aria-hidden="true">⋮</span>
        </span>

        {/* What the row is for, across its whole width. */}
        <div className="result-say">
          <div className="result-tags">
            {card.skills.slice(0, 4).map((skill) => (
              <span key={skill} className="chip chip-neutral">{skill}</span>
            ))}
          </div>

          {card.reason && <p className="reasoning-line">{card.reason}</p>}
        </div>
      </div>
    </li>
  )
}

/**
 * One sorted applicant, in the product's own result row.
 *
 * The same classes DemoCard uses above, and for the same reason: a demo whose
 * rows are a lookalike teaches a layout the recruiter will never see again.
 * What differs is what is in them, because these are the visitor's own CVs and
 * there is nothing to mask — the name is theirs, the file is theirs, and there
 * is no reveal to sell.
 *
 * And no percentage. The demo runs the preliminary pass only — the cheap
 * deterministic ordering a paid Triage opens with, before it reads the top of
 * the pile properly — and §3 of the Triage brief forbids presenting that pass
 * as a score, §4 forbids inventing a Triage percentage beside Search's. So the
 * row shows what the first pass genuinely knows: where the CV landed in the
 * order, and which of the job description's requirements it does and does not
 * evidence. The server does not send a number for this row to round.
 */
function DemoTriageRow({ row }) {
  return (
    <li className="result">
      <div className="result-main">
        <span className="result-lead">
          <div className="result-identity">
            <h3>{row.name ?? row.fileName}</h3>
            <p className="muted">
              {[row.location, row.name ? row.fileName : null].filter(Boolean).join(' · ')}
            </p>
          </div>
        </span>

        <div className="result-side">
          {/* Where it landed, said as a position rather than a percentage.
              The caption stays on this one: "3" alone is a number of nothing,
              and it is the reading rather than the unit that needs saying. */}
          <div className="score">
            <span className="score-value result-rank">{row.rank}</span>
            <span className="score-label">first pass</span>
          </div>
        </div>

        <span className="result-spacer" />

        {/* Green for what the job description asked for and the CV evidences,
            oxblood for what it asked for and the CV does not — the same two
            chips the profile's score reading uses, in the band the panel gives
            them rather than squeezed into the name's column. */}
        <div className="result-say">
          <div className="result-tags">
            {row.matched.map((skill) => (
              <span key={`m-${skill}`} className="chip chip-hit">{skill}</span>
            ))}
            {row.missing.map((skill) => (
              <span key={`x-${skill}`} className="chip chip-miss">{skill}</span>
            ))}
          </div>
        </div>
      </div>
    </li>
  )
}

/**
 * The files that did not get a place in the ranking, and why each one didn't.
 *
 * The server sends a reason per file and there are two distinct kinds: a CV it
 * could not read text out of, and a file it would not accept because the bytes
 * are not what the extension claims. One blanket sentence about scans was
 * telling half of them something untrue about their own file.
 */
function NotScored({ rows }) {
  return (
    <div className="demo-not-scored">
      <p className="muted demo-masked-note">
        {`${rows.length} ${rows.length === 1 ? 'file was' : 'files were'} not ranked:`}
      </p>
      <ul className="demo-not-scored-list">
        {rows.map((row) => (
          <li key={row.fileName} className="muted">
            <strong>{row.fileName}</strong>: {row.reason}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function LiveDemo({ open, onClose }) {
  /*
   * One per dialog, not one shared by three.
   *
   * useDialogFocus keeps a single record — the element, its key handler and
   * whatever had focus when it opened — so attaching the same callback ref to
   * the demo, the profile and the gate meant each one overwrote the last. The
   * profile closing consumed the demo's record, and closing the demo then found
   * nothing to restore and dropped focus onto <body>.
   */
  const demoRef = useDialogFocus()
  const profileRef = useDialogFocus()
  const gateRef = useDialogFocus()
  const [jd, setJd] = useState('')
  /* The CVs the paperclip is holding, and what came back when they were sorted.
     Held here rather than in the composer because this is what submits them. */
  const [cvs, setCvs] = useState([])
  const [triage, setTriage] = useState(null)
  /* Server-owned, so the sentence in the placeholder and the rule the route
     enforces are the same number. Null until it answers; the composer shows
     its ordinary placeholder until then rather than guessing. */
  const [limits, setLimits] = useState(null)
  const [state, setState] = useState('idle')   // idle | searching | done
  const [error, setError] = useState('')
  const [search, setSearch] = useState(null)
  /* Which card opened the gate. Held so the gate can name them and so the
     server is told who the recruiter was trying to reach. */
  const [gateFor, setGateFor] = useState(null)
  const [registered, setRegistered] = useState(null)
  /*
   * The terms of the offer, as the server states them. Not a constant here: the
   * grant is configurable on the server, and a number typed into this component
   * would be free to drift away from the credit actually given.
   */
  const [offer, setOffer] = useState({
    freeReveals: null, freeTriageCvs: null, creditCardRequired: false,
  })
  /* The card whose profile is open. A separate layer from the sign-up gate:
     reading someone is free and reveals nothing, so it must not be the thing
     that asks for an account. */
  const [profile, setProfile] = useState(null)
  const textarea = useRef(null)
  const panel = useRef(null)

  /* The page behind must not scroll while the overlay is up: two scrollbars
     with the same wheel is the clearest possible way to say "you have left the
     page", which is the one thing this must not say. */
  useEffect(() => {
    if (!open) return undefined
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [open])

  useEffect(() => {
    if (open) textarea.current?.focus()
  }, [open])

  const close = useCallback(() => {
    /* Deliberately keeps the search. Reopening the demo should show the results
       the recruiter already has rather than an empty box — they closed an
       overlay, they did not throw the work away. */
    setGateFor(null)
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      /* One layer at a time: Escape in the gate returns to the results, and
         only then does it close the demo. */
      if (gateFor) setGateFor(null)
      else if (profile) setProfile(null)
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, gateFor, profile, close])

  async function submit(event) {
    event?.preventDefault?.()
    setError('')
    setState('searching')
    try {
      /*
       * Which of the two products was asked for is decided by what is attached.
       *
       * CVs on the clip mean "sort these", which is Triage; nothing on the clip
       * means "who else is out there", which is search. One composer, one
       * button, and the visitor never has to know there were two routes.
       */
      if (cvs.length > 0) {
        /*
         * The brief is measured before a single byte goes up.
         *
         * The server checks this too — it has to; a client-side rule is not a
         * rule — but its check runs after multer has parsed the body, which
         * means twenty-five CVs are written to disk and read back before
         * anybody discovers the job description was two words long. The
         * thresholds come from the server so there is still only one authority
         * for them.
         */
        const brief = jd.trim()
        if (limits && brief.length < limits.minJdLength) {
          throw new Error('Paste a bit more of the role: a sentence or two about the work, '
            + 'the stack and the seniority is enough to rank against.')
        }
        if (limits && brief.length > limits.maxJdLength) {
          throw new Error('That job description is longer than this demo accepts.')
        }

        const form = new FormData()
        form.append('jobDescription', jd.trim())
        for (const file of cvs) form.append('cvs', file)
        const sorted = await sendForm('/api/public/demo/triage', form)
        setTriage(sorted)
        setSearch(null)
      } else {
        const found = await post('/api/public/demo/search', { jobDescription: jd.trim() })
        setSearch(found)
        setTriage(null)
      }
      setState('done')
    } catch (err) {
      /* §9 — the job description stays in the box. Losing what they pasted is
         the one failure a recruiter will not forgive. */
      setError(err.message)
      setState(search || triage ? 'done' : 'idle')
    }
  }

  async function reveal(card) {
    setGateFor(card)
    try {
      const gate = await post('/api/public/demo/reveal-intent', {
        searchToken: search.searchToken,
        candidateToken: card.token,
      })
      setOffer({
        freeReveals: gate.freeReveals ?? null,
        freeTriageCvs: gate.freeTriageCvs ?? null,
        creditCardRequired: Boolean(gate.creditCardRequired),
      })
    } catch {
      /* The gate still opens. Recording which candidate they wanted is a
         convenience for after they register, not a precondition for offering
         them an account. */
    }
  }

  /*
   * What this demo accepts, asked once when it opens.
   *
   * Failure is silent and harmless: without an answer the composer keeps its
   * ordinary placeholder and the paperclip keeps taking one job description,
   * which is exactly the behaviour it had before Triage was offered here.
   */
  useEffect(() => {
    if (!open || limits) return
    let live = true
    get('/api/public/demo/limits')
      .then((answer) => { if (live) setLimits(answer) })
      .catch(() => {})
    return () => { live = false }
  }, [open, limits])

  if (!open) return null

  return createPortal(
    <div
      className="demo-backdrop"
      role="dialog"
      aria-modal="true"
      ref={demoRef}
      tabIndex={-1}
      aria-label="Cursus recruiter workspace, live demo"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close() }}
    >
      <div className="demo-panel" ref={panel}>
        {/*
          A working copy of the recruiter workspace rather than a form in a box.

          The argument the demo has to make is "this is the thing you would be
          buying", and a bespoke preview makes that argument badly — it shows
          the results without showing the product they arrive in. So the rail,
          the composer and the result list are the ones a signed-in recruiter
          sees, and the only live control is the search itself.

          Everything else is deliberately inert. It is not disabled to be
          coy: a stranger has no searches to reopen, no folders to read and
          nobody to message, so those controls have nothing to do, and a
          control that responds to a click by doing nothing is worse than one
          that plainly does not invite the click.
        */}
        <div className="demo-portal">
          <div className="demo-portal-bar">
            <span className="demo-portal-mark">CVRSVS</span>
            <span className="demo-portal-tag">Live demo</span>
            <button
              type="button"
              className="btn btn-quiet demo-close"
              onClick={close}
              aria-label="Close the demo"
            >
              &times;
            </button>
          </div>

          <div className="demo-portal-body">
            {/*
              The rail, shown and not wired. `inert` takes it out of the tab
              order and out of the accessibility tree in one attribute, which is
              the honest way to say "this is scenery" — pointer-events alone
              would still let a keyboard land on a dead button.
            */}
            <DemoRail title={search?.title} hasSearch={Boolean(search)} />

            <main className={search ? 'demo-portal-main' : 'demo-portal-main demo-portal-main-empty'}>
              {/*
                The product's own composer, not a copy of it. Same component the
                recruiter workspace renders, so the demo cannot drift from the
                thing it is demonstrating — and so the flow a stranger learns
                (type, search, then Modify or Refresh) is the flow they keep.
                Only the paperclip is muted: reading a JD out of a PDF is behind
                the authenticated route.
              */}
              <SearchHero
                greeting="See who is already on Cursus"
                value={jd}
                onChange={setJd}
                onSubmit={() => submit()}
                /*
                 * Modify abandons the result, and the pile belonged to it.
                 *
                 * Dropping the CVs here is also the only way back to a plain
                 * candidate search: the paperclip adds and never removes, so a
                 * visitor who attached a pile would otherwise be able to run
                 * Triage and nothing else for the rest of the session. Refresh
                 * is the other button and keeps them, which is what somebody
                 * re-running the same pile against a tweaked brief wants.
                 */
                onModify={() => { setSearch(null); setTriage(null); setCvs([]) }}
                onRefresh={() => submit()}
                busy={state === 'searching'}
                /* A finished run is a finished run whichever of the two it was.
                   Without the triage half here the composer never entered its
                   submitted state after sorting a pile, so Modify and Refresh —
                   the only two ways on from a result — were unreachable. */
                submitted={state === 'done' && Boolean(search || triage)}
                uploadPath="/api/public/demo/jd-text"
                compact={Boolean(search || triage)}
                /*
                 * The other half of the product, on the control that is already
                 * there. The number comes from the server so the sentence in
                 * the placeholder and the rule the route enforces are one
                 * thing; until it answers, the composer shows its ordinary
                 * placeholder rather than a guess.
                 */
                maxCvs={limits?.triageMaxFiles ?? 0}
                cvs={cvs}
                onCvs={setCvs}
              />

              {/* Inline, and the description stays in the box — §9. */}
              {error && <p className="form-error demo-error" role="alert">{error}</p>}

              {state === 'searching' && (
                /* No percentage: a made-up progress bar is a lie about work
                   whose length nobody knows. */
                <p className="demo-status muted">
                  {cvs.length > 0
                    ? `Reading the role, then scoring ${cvs.length} ${cvs.length === 1 ? 'CV' : 'CVs'} against it.`
                    : 'Reading the role, then scoring candidates against it.'}
                </p>
              )}

              {/*
                A sorted pile, in the same list the search results use.

                Nothing here is masked and nothing is for sale: these are the
                visitor's own applicants, so the row shows the name on the CV,
                the file it came from, and what the job description asked for
                that the CV does or does not evidence.
              */}
              {state === 'done' && triage && (
                <section className="demo-results">
                  {triage.ranked.length === 0 ? (
                    <div className="demo-empty">
                      <h3>Nothing we could rank in those files</h3>
                      <p className="muted">
                        Not one of them could be read. Scans and photographs of a CV have no text
                        layer; a PDF exported from a word processor does.
                      </p>
                      {/* Which file, and why, rather than leaving the visitor to
                          guess which of the ones they attached was the problem. */}
                      {triage.unreadable.length > 0 && <NotScored rows={triage.unreadable} />}
                    </div>
                  ) : (
                    <>
                      <div className="demo-results-head">
                        <span className="muted demo-masked-note">
                          {`Your ${triage.considered} ${triage.considered === 1 ? 'CV' : 'CVs'}, in the order Triage would read them. `}
                          A full Triage then analyses the strongest in depth and writes up each
                          one. Nothing here was stored. The files were read and deleted.
                        </span>
                      </div>
                      <ul className="result-list">
                        {triage.ranked.map((row) => (
                          <DemoTriageRow key={`${row.fileName}-${row.rank}`} row={row} />
                        ))}
                      </ul>

                      {triage.unreadable.length > 0 && <NotScored rows={triage.unreadable} />}
                    </>
                  )}
                </section>
              )}

              {state === 'done' && search && (
                <section className="demo-results">
                  {search.results.length === 0 ? (
                    <div className="demo-empty">
                      <h3>No strong matches for this role yet</h3>
                      <p className="muted">
                        {search.considered > 0
                          ? `We looked at ${search.considered} ${search.considered === 1 ? 'candidate' : 'candidates'} and none is a strong fit for this brief.`
                          : 'Nobody in the pool matches this brief closely enough to show you.'}
                        {' '}
                        We would rather say so than fill the page with people who are not right.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="demo-results-head">
                        <span className="muted demo-masked-note">
                          Names, contact details and CVs stay hidden until you reveal someone.
                        </span>
                      </div>
                      <ul className="result-list">
                        {search.results.map((card) => (
                          <DemoCard
                            key={card.token}
                            card={card}
                            onOpen={() => setProfile(card)}
                            onReveal={() => reveal(card)}
                          />
                        ))}
                      </ul>
                    </>
                  )}
                </section>
              )}
            </main>
          </div>

          {/* Scenery, like the rail: a stranger has nobody to message. No
              chevron, because there is nothing behind it to open. */}
          <div className="demo-dock" inert="" aria-hidden="true">
            <span>Messaging</span>
          </div>
        </div>
      </div>

      {/*
        A candidate's profile, opened from a result row.

        The same shape the authenticated search opens before a reveal: what is
        known about the person, why they came back for this role, and the one
        button that costs something. It carries no more than the row did — the
        server sends a masked preview and this is a second reading of it, not a
        second request — so opening a profile discloses nothing that scrolling
        the list had not already.
      */}
      {profile && (
        <div
          className="demo-gate-backdrop"
          role="dialog"
          aria-modal="true"
          ref={profileRef}
          tabIndex={-1}
          aria-label="Candidate profile"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setProfile(null) }}
        >
          <div className="demo-profile">
            <header className="demo-gate-head">
              <div>
                <h3>{profile.title ?? 'Profile still being read'}</h3>
                <p className="muted">
                  {Math.round(profile.score)}% match · masked until you reveal them
                </p>
              </div>
              <button
                type="button" className="btn btn-quiet demo-close"
                onClick={() => setProfile(null)}
                aria-label="Back to the results"
              >
                &times;
              </button>
            </header>

            <div className="demo-gate-body">
              <dl className="demo-profile-facts">
                {profile.location && (<><dt>Location</dt><dd>{profile.location}</dd></>)}
                {profile.experience && (<><dt>Experience</dt><dd>{profile.experience}</dd></>)}
                {profile.availability && (<><dt>Availability</dt><dd>{profile.availability}</dd></>)}
                {profile.skills.length > 0 && (
                  <><dt>Skills</dt><dd>{profile.skills.join(' · ')}</dd></>
                )}
              </dl>

              {profile.reason && (
                <>
                  <h4 className="demo-profile-why">Why this match</h4>
                  <p className="muted">{profile.reason}</p>
                </>
              )}

              {/* Said plainly, because the empty half of this dialog is the
                  argument for revealing and should not look like a bug. */}
              <p className="muted demo-profile-note">
                Their name, contact details and CV stay hidden until you reveal them.
              </p>

              <button
                type="button"
                className="btn btn-primary demo-reveal"
                onClick={() => { const card = profile; setProfile(null); reveal(card) }}
              >
                <Eye />
                Reveal
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        The sign-up gate. A layer over the demo, not a replacement for it: the
        results stay mounted underneath, so closing this returns the recruiter
        to the search they were reading rather than to a blank page.
      */}
      {gateFor && (
        <div
          className="demo-gate-backdrop"
          role="dialog"
          aria-modal="true"
          ref={gateRef}
          tabIndex={-1}
          aria-label="Create your recruiter account"
          onMouseDown={(event) => { if (event.target === event.currentTarget) setGateFor(null) }}
        >
          <div className="demo-gate">
            <header className="demo-gate-head">
              <div>
                <h3>Reveal this candidate</h3>
                <p className="muted">
                  {/* Both halves of the welcome, because an account comes with
                      both and naming one of them understates what is on offer
                      at the moment somebody is deciding. */}
                  Create your recruiter account
                  {offer.freeReveals ? ` and get ${offer.freeReveals} free reveals` : ''}
                  {offer.freeReveals && offer.freeTriageCvs
                    ? ` and ${offer.freeTriageCvs} free CVs of Triage capacity`
                    : offer.freeTriageCvs ? ` and get ${offer.freeTriageCvs} free CVs of Triage capacity` : ''}.
                  {!offer.creditCardRequired && <> <strong>No credit card required.</strong></>}
                </p>
              </div>
              <button
                type="button" className="btn btn-quiet demo-close"
                onClick={() => setGateFor(null)}
                aria-label="Back to the results"
              >
                &times;
              </button>
            </header>

            <div className="demo-gate-body">
              {registered ? (
                <div className="demo-gate-done">
                  <h4>Your account is with us for review</h4>
                  <p className="muted">
                    We check every company by hand before opening the candidate pool to it. We
                    will reply to {registered.contact?.email} once {registered.company?.name} is
                    approved.
                  </p>
                  <p className="muted">
                    {offer.freeReveals
                      ? `Your ${offer.freeReveals} free reveals${offer.freeTriageCvs ? ` and ${offer.freeTriageCvs} free Triage CVs are` : ' are'} already on the account, and this`
                      : 'This'}
                    {' '}
                    search is saved. It will be waiting when you first sign in, with this
                    candidate still on it.
                  </p>
                  <button type="button" className="btn btn-secondary" onClick={close}>
                    Back to the site
                  </button>
                </div>
              ) : (
                <>
                  <p className="muted demo-gate-note">
                    Your search is kept. After sign-in you come back to this job description, this
                    ranking, and this candidate — nothing to paste again.
                  </p>
                  <CompanySignUpForm
                    chrome="bare"
                    demoSearchToken={search?.searchToken ?? null}
                    onCreated={setRegistered}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}
