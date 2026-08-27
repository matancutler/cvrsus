import { useEffect, useRef, useState } from 'react'

import { sendForm } from '../api.js'
import { StatusNotice } from './Notice.jsx'

/**
 * The attach affordance, as a paperclip.
 *
 * Drawn rather than an image so it takes currentColor and dims with the button
 * when the composer is busy.
 */
function PaperClip() {
  return (
    <svg
      viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.8 1.8 0 0 1-2.5-2.5l7.4-7.4" />
    </svg>
  )
}
/**
 * The composer: one job description, one optional instruction, one submission.
 *
 * A search is not a conversation. The expensive part — Claude reading every
 * shortlisted profile — runs once per search, so the recruiter states the role
 * fully up front and gets a ranked list back. Changing the role materially
 * means starting a new search, which is why the composer locks after
 * submitting rather than inviting an edit-and-resend loop.
 */
export default function SearchHero({
  recruiter,
  value,
  onChange,
  instruction = '',
  onInstructionChange,
  onSubmit,
  onNewSearch,
  onModify,
  onRefresh,
  busy = false,
  compact = false,
  submitted = false,
  /*
   * Two seams for the public demo, which renders this same component so that
   * what a stranger tries and what they would buy are the same thing rather
   * than two implementations that drift.
   *
   * `greeting` because "Welcome back" is wrong for somebody who has never been
   * here; `uploadPath` because the extraction route a recruiter uses is behind
   * their session, and the demo has its own with the demo's rate limit on it.
   * Same control, same behaviour, different door.
   */
  greeting = 'Welcome back',
  uploadPath = '/api/hr/jd-text',
  /*
   * The third seam, and the one that changes what the paperclip means.
   *
   * Off everywhere by default. When `maxCvs` is set — only the public demo
   * sets it — the same control also takes applicant CVs, so a visitor can try
   * Triage without the page growing a second uploader for it. Which of the two
   * an attached file becomes is decided by whether there is already a job
   * description in the box:
   *
   *   empty box   → the first file is read as the job description, exactly as
   *                 it always was, and anything after it is a CV;
   *   full box    → every file is a CV.
   *
   * That is the rule a person would guess, and it needs no control to express.
   * `cvs` is held by the caller rather than here because the caller is what
   * submits them.
   */
  maxCvs = 0,
  cvs = [],
  onCvs,
}) {
  const textarea = useRef(null)
  const fileInput = useRef(null)
  const [attaching, setAttaching] = useState(false)
  const [attached, setAttached] = useState(null)
  const [error, setError] = useState('')

  // Grow with the text rather than scrolling inside a fixed box.
  useEffect(() => {
    const el = textarea.current
    if (!el) return
    el.style.height = 'auto'

    /*
     * An empty box is sized to its placeholder, not to one bare line.
     *
     * scrollHeight measures the VALUE, and a placeholder is not one — so an
     * empty textarea reports a single line however long the prompt inside it
     * is. The demo's placeholder is a sentence and a half and was being clipped
     * at the first line with a scrollbar beside it, which is the one piece of
     * text on that screen a first-time visitor is certain to read.
     *
     * Measured by lending the element its own placeholder for a moment. React
     * owns `value` and re-asserts it on the next render, and this assignment
     * fires no event, so nothing downstream can see it happen.
     */
    let measured = el.scrollHeight
    if (!value && el.placeholder) {
      el.value = el.placeholder
      measured = el.scrollHeight
      el.value = ''
    }

    /*
     * A submitted search shows its whole job description.
     *
     * While typing the box is capped so the composer does not push the page
     * around; afterwards the cap only hid what was searched for behind an inner
     * scrollbar, which is the one moment you most want to read it back.
     */
    el.style.height = submitted
      ? `${measured}px`
      : `${Math.min(measured, compact ? 140 : 260)}px`
  }, [value, compact, submitted, maxCvs])

  function submit(event) {
    event.preventDefault()
    if (value.trim() && !busy && !submitted) onSubmit()
  }

  /**
   * The file is read for its text, which then fills the box. The recruiter sees
   * exactly what the model will read and can fix it before searching — PDF
   * extraction is imperfect often enough to matter.
   */
  async function attach(chosen) {
    const files = [...chosen].filter(Boolean)
    if (files.length === 0) return

    setError('')

    /*
     * A job description is needed first, and the box may already hold one.
     *
     * Only the first file is ever read into the box, and only when the box is
     * empty — otherwise attaching a stack of CVs would silently overwrite the
     * role the visitor had just pasted, which is the one thing §9 says must
     * never happen to what they typed.
     */
    let rest = files
    if (!value.trim()) {
      const [first, ...others] = files
      rest = others
      setAttaching(true)
      try {
        const form = new FormData()
        form.append('jd', first)
        const result = await sendForm(uploadPath, form, { role: 'recruiter' })
        onChange(result.text)
        setAttached(result.fileName)
      } catch (err) {
        setError(err.message)
        setAttaching(false)
        return
      }
      setAttaching(false)
    }

    if (maxCvs <= 0 || rest.length === 0) return

    /* Trimmed here as well as refused by the server: telling somebody they
       attached too many is better than the server quietly ignoring six. */
    const room = maxCvs - cvs.length
    if (room <= 0) {
      setError(`That is the most CVs this demo takes at once: ${maxCvs}.`)
      return
    }
    if (rest.length > room) {
      setError(`Only the first ${room} of those were added. This demo takes ${maxCvs} CVs at once.`)
    }
    onCvs?.([...cvs, ...rest.slice(0, room)])
  }

  /*
   * What the paperclip is currently holding, in one line.
   *
   * The filename alone stopped being the whole answer once the same control
   * could also be holding applicant CVs — "3 CVs" is the state a visitor has
   * to be able to check before pressing Search, and an icon cannot say it.
   */
  const heldLabel = [
    attached,
    cvs.length > 0 ? `${cvs.length} CV${cvs.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ') || null

  /* Given name first. It read "Cohen Maya" — surname first, which is a database
     ordering rather than a way of addressing somebody. */
  const name = [recruiter?.firstName, recruiter?.lastName].filter(Boolean).join(' ')

  return (
    <div className={compact ? 'hero hero-compact' : 'hero'}>
      {!compact && (
        <h1 className="hero-greeting">
          <Sparkle />
          {greeting}
          {name && <>, {name}</>}
        </h1>
      )}

      <form className="composer" onSubmit={submit}>
        <textarea
          ref={textarea}
          rows={1}
          value={value}
          readOnly={submitted}
          className={submitted ? 'input-locked' : undefined}
          placeholder={maxCvs > 0
            ? 'Paste the job description, or attach it as a PDF or Word file. '
              + `You can also upload up to ${maxCvs} CVs to try our Triage feature.`
            : 'Paste the job description, or attach it as a PDF or Word file…'}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter searches; Shift+Enter makes a new line.
            if (e.key === 'Enter' && !e.shiftKey) submit(e)
          }}
        />

        {/*
          The optional steer is gone.

          It asked for a second, vaguer version of what the box above already
          takes, and a job description that needs "weight backend depth heavily"
          bolted on is usually a job description that should say so. Searches
          saved with one still echo it below, so nothing already written is
          lost.
        */}

        {submitted && instruction && (
          <p className="muted composer-instruction-echo">Instruction: “{instruction}”</p>
        )}

        <StatusNotice error={error} onDismiss={() => setError('')} />

        <div className="composer-row">
          {submitted ? (
            /*
              Two things a recruiter wants from a finished search, and neither
              was reachable without starting again.

              Modify unlocks the description in place: a brief is usually wrong
              in one line, and retyping the whole thing to change "5 years" to
              "3" is the sort of friction that makes people stop refining.
              Refresh runs the same brief against the pool as it stands now,
              which matters because the pool moves — people join, profiles go
              active — and a stored ranking can only ever show the set that
              existed when it was made.
            */
            <div className="composer-done">
              <span className="muted composer-hint">This search is complete.</span>
              <button type="button" className="btn btn-quiet btn-small" onClick={onModify}>
                Modify
              </button>
              <button
                type="button"
                className="btn btn-quiet btn-small"
                onClick={onRefresh}
                disabled={busy}
              >
                {busy ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          ) : (
            <>
              <input
                ref={fileInput}
                type="file"
                accept=".pdf,.docx"
                /* Only where the composer takes CVs. Everywhere else it is the
                   one job description it has always been. */
                multiple={maxCvs > 0}
                hidden
                onChange={(e) => {
                  const chosen = [...(e.target.files ?? [])]
                  e.target.value = ''
                  attach(chosen)
                }}
              />
              {/*
                A paperclip rather than the words.

                It is the convention every composer uses, and the words were
                competing with the two things on this row that do need reading —
                the keyboard hint and the Search button. The filename still
                appears beside it once something is attached, because that is
                the state you actually have to check; an icon alone cannot tell
                you which file it took.
              */}
              <button
                type="button"
                className="btn btn-quiet btn-small composer-attach"
                disabled={attaching || busy}
                onClick={() => fileInput.current?.click()}
                title={heldLabel ?? 'Attach a job description'}
                aria-label={heldLabel ? `${heldLabel}. Choose more files.` : 'Attach a job description'}
              >
                <PaperClip />
                {attaching && <span className="composer-attach-text">Reading…</span>}
                {!attaching && heldLabel && <span className="composer-attach-text">{heldLabel}</span>}
              </button>
              <span className="muted composer-hint">
                {compact ? 'Press Enter to search' : 'Press Enter to search · Shift+Enter for a new line'}
              </span>
            </>
          )}

          {/* Nothing on a completed search. New search is the first thing in
              the rail, at the top of every screen — a second copy of it here,
              in the primary colour, made the loudest control on the page the
              one that throws your results away. */}
          {/*
            An arrow rather than the word, the way every composer of this shape
            ends. The row already says "Press Enter to search", so the button
            was the third thing on it explaining the same action; the arrow is
            read at a glance and leaves the sentence to do the explaining. The
            name survives for anyone who cannot see it.
          */}
          {!submitted && (
            <button
              type="submit"
              className="btn btn-primary composer-send"
              disabled={busy || !value.trim()}
              aria-label={busy ? 'Searching' : 'Search'}
              title={busy ? 'Searching…' : 'Search'}
            >
              {busy ? <Spinner /> : <SendArrow />}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

/** The send arrow. Up, because the composer sits below what it produces. */
function SendArrow() {
  return (
    <svg
      viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  )
}

/** Busy, in the same box as the arrow so the button does not change size. */
function Spinner() {
  return (
    <svg
      className="composer-spinner" viewBox="0 0 24 24" width="18" height="18"
      fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

function Sparkle() {
  return (
    <svg className="hero-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 2c.3 4.2 2.1 6.6 6.3 7.4-4.2.8-6 3.2-6.3 7.4-.3-4.2-2.1-6.6-6.3-7.4C9.9 8.6 11.7 6.2 12 2Z"
        fill="currentColor"
      />
      <path
        d="M18.5 15c.15 2 1 3.1 3 3.5-2 .4-2.85 1.5-3 3.5-.15-2-1-3.1-3-3.5 2-.4 2.85-1.5 3-3.5Z"
        fill="currentColor"
        opacity="0.65"
      />
    </svg>
  )
}
