import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { DRAFT_NOTICE, LEGAL_DOCUMENTS } from '../legal/legalDocuments.jsx'
import useDialogFocus from '../useDialogFocus.js'

export const CONSENT_ERROR =
  'You must confirm you are 18 or over and agree to the Terms of Service and '
  + 'Privacy Policy to continue.'

/**
 * The agreement that has to be given before an account is created.
 *
 * Sits at the foot of both account-creation forms, directly above their submit
 * buttons — the candidate's and the company's. Consent belongs next to the act
 * it authorizes, not beside a call-to-action higher up the page that only
 * scrolls somewhere.
 *
 * The two documents open in a modal over the form rather than as links. A link
 * would unload the page and take every field with it: the CV already attached,
 * the summary drafted from it, the email and phone codes already proved. Asking
 * someone to read what they are agreeing to should not cost them the form.
 *
 * Controlled: the parent owns `checked` and decides what to do on submit, since
 * the parent is the thing that can refuse to submit. `showError` is the parent
 * saying it just refused.
 */
export default function LegalConsent({ id, checked, onChange, showError = false }) {
  /* Which document is open, or null. One piece of state rather than two flags —
     the modal shows one document at a time and cannot show both. */
  const [open, setOpen] = useState(null)

  const errorId = `${id}-error`

  return (
    <div className="consent-field">
      <label className="consent-check" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          /*
           * Deliberately not `required`. The browser's own bubble would fire
           * before the form's handler and pre-empt the message below, and its
           * wording is neither ours nor translatable. The parent blocks the
           * submit instead.
           *
           * aria-required still tells a screen reader the field is mandatory,
           * which is what `required` was carrying that is worth keeping.
           */
          aria-required="true"
          aria-invalid={showError || undefined}
          aria-describedby={showError ? errorId : undefined}
        />
        <span>
          {/*
            The age affirmation shares this checkbox rather than getting one of
            its own.

            Clause 1 of the Terms has always required 18, and nothing anywhere
            asked. A second box would state it more separately — and it would
            also be a second thing to click on a form that already asks for a
            CV, two verification codes and a photograph, to record a fact the
            person can simply assert. Bundling a self-declaration with the
            agreement it qualifies is ordinary; it is bundling one CONSENT with
            another that is not, and there is only one consent here.
          */}
          I am 18 or over, and I agree to the{' '}
          {/*
            Buttons, not links. They open a dialog rather than going anywhere,
            and `type="button"` matters more than usual here: an unqualified
            <button> inside a <form> submits it, so a reader opening the terms
            would have created the account instead.
          */}
          <button type="button" className="legal-link" onClick={() => setOpen('terms')}>
            Terms of Service
          </button>{' '}
          and{' '}
          <button type="button" className="legal-link" onClick={() => setOpen('privacy')}>
            Privacy Policy
          </button>
          .
        </span>
      </label>

      {showError && (
        /* `alert` so it is announced when it appears — someone who pressed the
           button and had nothing happen is exactly who needs telling why. */
        <p className="consent-error" id={errorId} role="alert">
          {CONSENT_ERROR}
        </p>
      )}

      {open && <LegalModal name={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

/**
 * One of the legal documents, over the form.
 *
 * Through a portal to document.body: the backdrop is `position: fixed`, which
 * an ancestor with a transform or a filter silently turns back into
 * `position: absolute`, and this renders from inside a card that may well grow
 * one. It also puts the markup outside the <form>, so nothing in the dialog can
 * be mistaken for part of it.
 */
function LegalModal({ name, onClose }) {
  const dialogRef = useDialogFocus()
  const { title, subtitle, Body, path } = LEGAL_DOCUMENTS[name]

  useEffect(() => {
    function onKey(event) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)

    /* The document is long enough that a scroll gesture landing on the page
       behind it would carry the form away underneath. Restored on close rather
       than cleared, so a page that had its own reason to lock scrolling keeps
       it. */
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return createPortal(
    <div className="modal-backdrop legal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal legal-modal"
        role="dialog"
        aria-modal="true"
        ref={dialogRef}
        tabIndex={-1}
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Outside the scrolling region on purpose: the way out stays on screen
            at clause 23 as much as at the first line. */}
        <header className="modal-head legal-modal-head">
          <div className="modal-title">
            <h2>{title}</h2>
            <p className="muted">{subtitle}</p>
          </div>
          <button type="button" className="btn btn-quiet" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </header>

        <div className="legal-modal-body legal-doc" tabIndex={0}>
          <p className="alert alert-warn">{DRAFT_NOTICE}</p>
          <Body />
        </div>

        <footer className="legal-modal-foot">
          {/* The standalone page, for anyone who wants it in a tab of their own
              — offered rather than forced, so the form is never taken away from
              someone who did not ask for that. */}
          <a href={path} target="_blank" rel="noreferrer" className="legal-open-page">
            Open as a page
          </a>
          <button type="button" className="btn btn-outline" onClick={onClose}>Close</button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
