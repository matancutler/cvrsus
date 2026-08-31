import { useState } from 'react'
import { createPortal } from 'react-dom'

import { YesNo, relocationAnswer } from './CandidateForm.jsx'
import DocumentPicker, { validateSupportingDocument } from './DocumentPicker.jsx'
import TagChips from './TagChips.jsx'
import { sendForm } from '../api.js'

/**
 * The four things a CV cannot answer, asked once, straight after signup.
 *
 * Capacity, relocation, what they are open to and any extra documents are not
 * in a CV — they are decisions about now, and a document written last year
 * cannot hold them. Everything else on the profile came out of the CV a moment
 * ago and is behind this, ready to be checked.
 *
 * The controls are the profile page's own. Only the arrangement is new: the
 * select, the two Yes/No pairs, the tag picker and the document picker are the
 * same components the form renders, so a change to any of them lands here too
 * rather than drifting from a copy.
 *
 * The identity block rides along on the save because PATCH /api/candidate/me
 * re-reads it with `require: true` — sending only these four fields would be
 * refused with "First name is required" over a form that never showed one.
 */
export default function OnboardingDialog({ account, capacityOptions, tagCap, onDone }) {
  const candidate = account?.candidate ?? {}

  const [capacity, setCapacity] = useState(candidate.capacity ?? '')
  /*
   * No, until they say otherwise.
   *
   * Relocating is the larger commitment of the two answers, and this dialog is
   * shown to somebody who has been on the site for about ninety seconds. A
   * default of yes puts them in front of recruiters hiring in cities they never
   * agreed to move to, and the cost of it being wrong is not symmetrical: a
   * candidate who would relocate and is not asked loses one opportunity, while
   * a candidate who would not and was defaulted into it fields calls about
   * every one of them.
   *
   * Only a stored yes opens as yes. Signup does not send this field at all, so
   * the column is NULL here and NULL is not an answer — relocationAnswer reads
   * it the same way the profile form does, which is the point: the two were
   * disagreeing about what 0 meant.
   */
  const [relocation, setRelocation] = useState(
    relocationAnswer(candidate.open_to_relocation),
  )
  const [openToAll, setOpenToAll] = useState(account?.preferences?.openToAll ?? true)
  const [tags, setTags] = useState(
    (account?.preferences?.tags ?? []).map((tag) => tag.raw).join(', '),
  )
  const [files, setFiles] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const tagCount = tags.split(',').map((tag) => tag.trim()).filter(Boolean).length
  /* Narrowing to nothing is not an answer — it is a profile no search can
     reach. The same rule the form applies, said in the same words. */
  const tagsMissing = !openToAll && tagCount === 0

  /* The same validation the form applies before it will hold a file — a
     picker that accepts anything and fails on save is worse than one that
     says no at the moment of choosing. */
  function chooseDocument(slot, file) {
    const problem = validateSupportingDocument(file)
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    setFiles((was) => ({ ...was, [slot]: file }))
  }

  async function confirm() {
    if (tagsMissing) return
    setBusy(true)
    setError('')

    try {
      const body = new FormData()

      /* Identity, unchanged, because the route insists on it. */
      body.append('firstName', candidate.first_name ?? '')
      if (candidate.middle_name) body.append('middleName', candidate.middle_name)
      body.append('lastName', candidate.last_name ?? '')
      body.append('email', candidate.email ?? '')
      body.append('phone', candidate.phone ?? '')
      body.append('location', candidate.location ?? '')

      body.append('capacity', capacity)
      body.append('openToRelocation', relocation)
      body.append('openToAllOpportunities', openToAll ? 'true' : 'false')
      body.append('interestTags', openToAll ? '' : tags)

      for (const [slot, file] of Object.entries(files)) {
        if (file) body.append(slot, file)
      }

      await sendForm('/api/candidate/me', body, { method: 'PATCH', role: 'candidate' })
      await onDone?.()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="modal onboarding-modal">
        <header className="modal-head">
          <h2 id="onboarding-title">A few things your CV cannot tell us</h2>
          {/*
            That this can wait is said here rather than discovered.

            The dialog has one button and no way past it, which reads as a gate
            even though nothing on it is required — capacity can stay on
            Select and the attachments are optional. Somebody who does not yet
            know their notice period should not have to guess at an answer to
            get to their profile, so the way out is stated plainly instead of
            being left for them to work out.
          */}
          <p className="muted">
            Everything else is already filled in from your CV. You will see it all next —
            and none of this is final. Leave anything blank and set it from your profile
            whenever you like.
          </p>
        </header>

        <div className="modal-body onboarding-body">
          <label className="field">
            <span className="field-label">Capacity</span>
            <select value={capacity} onChange={(e) => setCapacity(e.target.value)}>
              <option value="">Select…</option>
              {capacityOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>

          <YesNo
            label="Open to relocation"
            name="onboarding-relocation"
            value={relocation}
            onChange={setRelocation}
          />

          <YesNo
            label="I'm open to all opportunities"
            name="onboarding-open"
            hint="Say yes and any company hiring for what you do can find you."
            value={openToAll ? 'yes' : 'no'}
            onChange={(next) => setOpenToAll(next === 'yes')}
          />

          {!openToAll && (
            <div className="field">
              <span className="field-label">What are you open to?</span>
              <p className="field-hint">
                Up to {tagCap}, for example: fintech, cybersecurity, product. You will only be
                shown to recruiters hiring in these areas.
              </p>
              <TagChips
                value={tags}
                onChange={setTags}
                max={tagCap}
                placeholder="e.g. fintech"
                addLabel="Add an area you are open to"
                disabled={busy}
              />
              {tagsMissing && (
                <p className="field-hint field-hint-warn">
                  Add at least one, or say yes to all opportunities above.
                </p>
              )}
            </div>
          )}

          <div className="field">
            <span className="field-label">Anything else to attach?</span>
            <p className="field-hint">
              Optional. A cover letter, a portfolio, a reference — whatever helps.
            </p>
            <DocumentPicker
              files={files}
              existing={[]}
              onChoose={chooseDocument}
              onRemove={(slot) => setFiles((was) => {
                const next = { ...was }
                delete next[slot]
                return next
              })}
              disabled={busy}
            />
          </div>

          {error && <p className="alert alert-error">{error}</p>}
        </div>

        <div className="modal-foot onboarding-foot">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || tagsMissing}
            onClick={confirm}
          >
            {busy ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
