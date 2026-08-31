import { useEffect, useRef, useState } from 'react'

import CityField from './CityField.jsx'
import DocumentPicker, {
  CV_ACCEPT,
  MAX_DOCUMENT_BYTES,
  validateCv,
  validateSupportingDocument,
} from './DocumentPicker.jsx'
import InfoHint from './InfoHint.jsx'
import LegalConsent from './LegalConsent.jsx'
import PhotoUploader, { PHOTO_TYPES, PHOTO_TYPE_ERROR } from './PhotoUploader.jsx'
import Req from './Req.jsx'
import TagChips from './TagChips.jsx'
import VerifiedField from './VerifiedField.jsx'
import { PencilIcon, TickIcon } from './EditIcons.jsx'
import { sendForm, withToken } from '../api.js'

export const AVAILABILITY = [
  'Immediately',
  'Within 2 weeks',
  'Within 1 month',
  '1–3 months',
]

export const CAPACITY_OPTIONS = ['Full time', 'Part time', 'Freelance']

const EMPTY = {
  firstName: '',
  middleName: '',
  lastName: '',
  email: '',
  phone: '',
  city: '',
  availability: '',
  /* Yes by default, and always one or the other — see openToAllOpportunities. */
  openToRelocation: 'yes',
  capacity: '',
  notes: '',
  /*
   * Yes by default, and required.
   *
   * This was deliberately unanswered for a while, on the reasoning that a
   * default is us answering for them. The reasoning still holds, and it lost to
   * a plainer fact: an unanswered required radio is a form that refuses to save
   * without saying which of its twenty fields is at fault, and the field it
   * blocks on is one most people would have answered yes to anyway. Yes is the
   * open setting, it is stated in words beside the control, and either radio is
   * one click away before the profile is ever created.
   *
   * Only the blank form starts here. A profile that exists always shows what is
   * stored — see toFormState, which never substitutes a default for an answer.
   */
  openToAllOpportunities: true,
  interestTags: '',
}

/** Mirrors MATCHING.preferenceTagCap on the server. */
const TAG_CAP = 10

/** Mirrors SUMMARY_MAX_CHARS in server/src/ai.js. */
const SUMMARY_MAX_CHARS = 500

/** For naming, in plain words, which fields the CV filled in. */
const FIELD_NAMES = {
  firstName: 'first name',
  middleName: 'middle name',
  lastName: 'last name',
  email: 'email',
  phone: 'phone number',
  city: 'city',
}

/**
 * The stored answer to "open to relocation", as the Yes/No the toggle speaks.
 *
 * SQLite has no boolean type, so this column comes back over the API as 0 or 1
 * and never as false — which made `=== false` a comparison that could not be
 * true. A candidate who answered No was shown Yes on their own profile, and
 * the next save wrote that Yes back over their answer. It went unseen for as
 * long as the default was also Yes, because the wrong branch happened to
 * produce the right word.
 *
 * Unanswered is not No, but it has to be shown as one of the two: a profile
 * from before the question existed has nothing stored, and No is the answer to
 * assume for somebody who never said. Being asked again costs a click; being
 * put in front of employers in another country does not undo.
 */
export function relocationAnswer(value) {
  if (value === null || value === undefined || value === '') return 'no'
  return Number(value) ? 'yes' : 'no'
}

function toFormState(candidate, preferences) {
  if (!candidate) return EMPTY

  return {
    firstName: candidate.first_name ?? '',
    middleName: candidate.middle_name ?? '',
    lastName: candidate.last_name ?? '',
    email: candidate.email ?? '',
    phone: candidate.phone ?? '',
    // Free text now, so what is stored is simply what is shown.
    city: candidate.location ?? '',
    availability: candidate.availability ?? '',
    openToRelocation: relocationAnswer(candidate.open_to_relocation),
    capacity: candidate.capacity ?? '',
    notes: candidate.notes ?? '',
    /*
     * What is stored, or null — never the blank form's default.
     *
     * The column is NOT NULL, so the server always has an answer for a profile
     * that exists and this reads it. The null branch is for the one case where
     * preferences did not load at all: showing "unanswered" makes the form
     * refuse to save, which is the safe failure. Substituting `true` here would
     * quietly reopen somebody who had closed themselves off.
     */
    openToAllOpportunities: preferences?.openToAll ?? null,
    interestTags: (preferences?.tags ?? []).map((tag) => tag.raw).join(', '),
  }
}

/**
 * The application form and the candidate's own edit page render the same
 * component, so the two cannot drift. The only difference is whether a CV must
 * be attached: on the edit page the stored one is kept unless replaced.
 */
export default function CandidateForm({
  mode = 'create',
  candidate = null,
  documents = [],
  preferences = null,
  existingPhotoUrl = null,
  onSubmit,
  onRemoveDocument,
  submitting = false,
  submitLabel,
  error = '',
  children,
  /* Where the picture goes. Defaults to below the CV, which is the
     application's order; the account page asks for it first. */
  photoFirst = false,
  /*
   * Locked until the pencil is pressed.
   *
   * On the account page this form is mostly something you read: it is the
   * profile recruiters see, and every field is already filled in. Left live,
   * every stray keystroke over a focused field is an edit to a live profile,
   * and nothing on screen distinguishes looking from changing. The application
   * form is the opposite — nothing exists yet — so it defaults to editable and
   * this is opt-in.
   */
  lockable = false,
}) {
  const [unlocked, setUnlocked] = useState(!lockable)
  const locked = lockable && !unlocked
  /* Submitting is asked for directly rather than through a submit button — see
     the note on the pencil. */
  const formRef = useRef(null)

  /*
   * While locked this is a profile, not a form.
   *
   * An optional field nobody filled in is a label over an empty box — it says
   * "you have not done this" about something that was never asked for, and a
   * dozen of them turn a profile into a to-do list. They come back the moment
   * the form is unlocked, because that is when an empty field is an invitation
   * rather than a gap.
   */
  /*
   * Absent, not falsy. `false`, `0` and `'no'` are answers; only nothing is
   * nothing. Boolean() collapsed the two, so the first genuinely optional
   * boolean to be guarded here would have vanished from the profile whenever
   * the answer was No.
   */
  const shown = (value) => !locked
    || (value !== '' && value !== null && value !== undefined)
  const isEdit = mode === 'edit'

  const [form, setForm] = useState(() => toFormState(candidate, preferences))
  const [files, setFiles] = useState({})
  const [photo, setPhoto] = useState(null)
  const [photoPreview, setPhotoPreview] = useState(null)
  const [photoCleared, setPhotoCleared] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [cvMissing, setCvMissing] = useState(false)
  const [localError, setLocalError] = useState('')

  const [drafting, setDrafting] = useState(false)
  const [drafted, setDrafted] = useState(false)
  const [draftError, setDraftError] = useState('')
  const [draftTrimmed, setDraftTrimmed] = useState(false)

  /*
   * Proof that the email address and phone number belong to whoever is filling
   * this in. Only the application form asks for them: on the edit page the
   * account already exists and its owner is signed in, which is a stronger
   * claim than a code sent to a field they can see.
   */
  const [proofs, setProofs] = useState({ email: '', phone: '' })

  /*
   * Whether each contact detail is settled: either untouched, or proved just
   * now.
   *
   * Saving is refused while one is not, rather than attempted and rejected. The
   * server enforces the same rule and used to be the only thing that did, so a
   * candidate typed a new number, pressed save, and got a red line back telling
   * them what they should have done first. The Verify button is already sitting
   * beside the field; the honest thing is to leave the save unavailable until it
   * has been used, so the form asks before it refuses.
   */
  const emailSettled = form.email === (candidate?.email ?? '') || Boolean(proofs.email)
  const phoneSettled = form.phone === (candidate?.phone ?? '') || Boolean(proofs.phone)
  const contactsSettled = !isEdit || (emailSettled && phoneSettled)
  const unverified = [
    emailSettled ? null : 'email address',
    phoneSettled ? null : 'phone number',
  ].filter(Boolean)

  /*
   * Agreement to the Terms and the Privacy Policy, on the create form only.
   *
   * Not on the edit page: that account exists because this box was ticked when
   * it was made. Asking again every time somebody changes their notice period
   * would turn a considered agreement into a thing you click past, and there is
   * nothing new to agree to.
   *
   * `agreed` starts false and is never seeded from anything — continued use of
   * the site is not consent, and neither is having been here before.
   */
  const [agreed, setAgreed] = useState(false)
  const [consentError, setConsentError] = useState(false)

  /* What was read out of the CV, so the form can say so rather than appearing
     to have known all along. */
  const [readFromCv, setReadFromCv] = useState([])
  const [reading, setReading] = useState(false)
  // Whether a read has been attempted at all, so "nothing found" can be told
  // apart from "no CV chosen yet" — the two look identical from the state above.
  const [attemptedRead, setAttemptedRead] = useState(false)

  const cvInput = useRef(null)

  const tagCount = form.interestTags.split(',').map((tag) => tag.trim()).filter(Boolean).length

  /**
   * Asks the server to draft a summary from the CV.
   *
   * During onboarding the chosen file is posted with the request — there is no
   * account yet to read it from. On the edit page nothing is sent and the
   * stored CV is used. Either way the draft lands in the textarea and is not
   * saved until the candidate submits the form.
   */
  async function draftSummary() {
    setDrafting(true)
    setDraftError('')
    try {
      const body = new FormData()
      if (files.cv) body.append('cv', files.cv)

      const result = await sendForm('/api/candidate/summary', body, {
        role: isEdit ? 'candidate' : undefined,
      })
      // Belt and braces: the server already caps this, but the textarea must
      // never end up holding more than the form will accept.
      update('notes', String(result.summary ?? '').slice(0, SUMMARY_MAX_CHARS))
      setDrafted(true)
      setDraftTrimmed(Boolean(result.truncated))
    } catch (err) {
      setDraftError(err.message)
    } finally {
      setDrafting(false)
    }
  }

  /*
   * Re-seed when the account arrives from the server after the first render.
   *
   * Both arguments, or this undoes the seeding it exists to finish. It used to
   * call toFormState(candidate) with one, and since an effect always runs after
   * the first render it fired even when the account was already in hand —
   * overwriting a loaded `openToAllOpportunities` with null, because that value
   * lives in `preferences` and not on the candidate row. The visible result was
   * a saved Yes that appeared unanswered every time the page was opened, and a
   * candidate who had answered No lost their interest tags the next time they
   * saved anything at all.
   */
  useEffect(() => {
    if (candidate) setForm(toFormState(candidate, preferences))
  }, [candidate?.id])

  // Object URLs have to be revoked, or each re-pick leaks the previous image.
  useEffect(() => {
    if (!photo) {
      setPhotoPreview(null)
      return undefined
    }
    const url = URL.createObjectURL(photo)
    setPhotoPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  const storedDoc = (slot) => documents.find((doc) => doc.slot === slot) ?? null

  function update(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  /**
   * Fills the form in from the CV that has just been attached.
   *
   * Only ever writes into fields that are still empty. Someone who typed their
   * name before choosing a file has told us more than the file has, and having
   * that quietly replaced by whatever the CV's header happens to say is the
   * behaviour this has to avoid. Availability is deliberately excluded — a CV
   * does not know when you could start.
   *
   * A verified email or phone is left alone as well: overwriting it would strand
   * a proof against an address that is no longer in the field.
   */
  async function prefillFromCv(file) {
    setReading(true)
    setAttemptedRead(true)
    try {
      const body = new FormData()
      body.append('cv', file)
      const { fields } = await sendForm('/api/candidate/parse-cv', body)

      const filled = []
      setForm((prev) => {
        const next = { ...prev }
        for (const key of ['firstName', 'middleName', 'lastName', 'email', 'phone', 'city']) {
          if (!fields[key] || String(prev[key]).trim()) continue
          next[key] = fields[key]
          filled.push(key)
        }
        return next
      })
      setReadFromCv(filled)
    } catch {
      // Nothing to say: the form still works, it is just not pre-filled.
      setReadFromCv([])
    } finally {
      setReading(false)
    }
  }

  function chooseDocument(slot, file) {
    // The CV has to be readable as text; §7 lets the supporting types be images
    // as well, so the two are checked against different lists.
    const problem = slot === 'cv' ? validateCv(file) : validateSupportingDocument(file)
    if (problem) {
      setLocalError(problem)
      return
    }
    setLocalError('')
    if (slot === 'cv') setCvMissing(false)
    setFiles((prev) => ({ ...prev, [slot]: file }))

    // Reading the CV back into the form is what makes "two minutes" true.
    if (slot === 'cv' && !isEdit) prefillFromCv(file)
  }

  function clearDocument(slot) {
    setFiles((prev) => {
      const next = { ...prev }
      delete next[slot]
      return next
    })
    // A stored file is only removed server-side, and only on the edit page.
    if (isEdit && storedDoc(slot) && onRemoveDocument) onRemoveDocument(slot)
  }

  function choosePhoto(selected) {
    if (!selected) return
    if (!PHOTO_TYPES.includes(selected.type)) {
      setLocalError(PHOTO_TYPE_ERROR)
      return
    }
    setLocalError('')
    setPhotoCleared(false)
    setPhoto(selected)
  }

  function removePhoto() {
    setPhoto(null)
    setPhotoCleared(true)
  }

  function handleSubmit(event) {
    event.preventDefault()

    /*
     * Flagged up front, blocking further down.
     *
     * Its message lives under the checkbox rather than in the shared error line,
     * so setting it here means it appears at the same time as whatever else is
     * wrong instead of waiting its turn behind a missing CV. Otherwise the last
     * thing on the form becomes a second round trip for everyone who missed it.
     */
    const consentMissing = !isEdit && !agreed
    setConsentError(consentMissing)

    if (!files.cv && !isEdit) {
      // The browser cannot enforce `required` on the hidden input behind the
      // dropzone, so the missing-CV state is flagged here instead.
      setCvMissing(true)
      setLocalError('Please attach your CV before submitting.')
      cvInput.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }

    setCvMissing(false)
    setLocalError('')

    // The server refuses an unproved address anyway; saying so here means the
    // whole form is not thrown back for something visible on screen.
    if (!isEdit && (!proofs.email || !proofs.phone)) {
      const missing = !proofs.email ? 'email address' : 'phone number'
      setLocalError(`Please verify your ${missing} before applying.`)
      return
    }

    if (form.openToAllOpportunities === null) {
      setLocalError('Say whether you are open to all opportunities.')
      return
    }

    if (!form.openToAllOpportunities) {
      if (tagCount === 0) {
        setLocalError('Add at least one area you are open to, or tick "open to all opportunities".')
        return
      }
      if (tagCount > TAG_CAP) {
        setLocalError(`Please list at most ${TAG_CAP} areas of interest.`)
        return
      }
    }

    // Last, and silent: the message is already on screen under the checkbox
    // from the top of this function. Nothing below this line runs without it.
    if (consentMissing) return

    const { city, interestTags, ...rest } = form

    const data = new FormData()
    // Always sent, even when empty: an omitted field means "leave as it was",
    // so clearing your interests would otherwise silently keep the old ones.
    data.append('interestTags', interestTags)
    /*
     * The agreement itself, which was never actually sent.
     *
     * `agreed` gated the submit button and stopped there, so the server's
     * consent handling — a real column pair and a version constant — could
     * never fire: every account was created with consent_at null, and the
     * profile-completion meter docked everybody a point for it in perpetuity.
     * The box was doing the ethical half of its job and none of the auditable
     * half.
     *
     * Not sent on the edit form: agreeing again is not something an edit does,
     * and `agreed` is false there by construction.
     */
    if (!isEdit) data.append('consent', 'true')
    for (const [slot, file] of Object.entries(files)) data.append(slot, file)
    if (photo) data.append('photo', photo)
    if (photoCleared && !photo) data.append('removePhoto', 'true')
    /*
     * Every field, including the empty ones.
     *
     * Skipping empties made "I cleared this" indistinguishable from "I did not
     * touch this", and the server can only tell those apart by what arrives.
     * With the server no longer nulling whatever a request omits, a skipped
     * empty Capacity would have meant the candidate could never remove one they
     * had set. Same reasoning as interestTags above, applied to the rest of the
     * form rather than to one field of it.
     *
     * The required fields are unaffected: an empty firstName arrives as '' and
     * is refused, exactly as an absent one was.
     */
    for (const [key, value] of Object.entries(rest)) data.append(key, value)
    if (city.trim()) data.append('location', city.trim())
    /*
     * Always, not only when creating an account.
     *
     * The edit form asks a candidate to verify a changed email or phone, waits
     * for the code, enables the save button — and then never sent the proof, so
     * the server refused with "verify your new phone number before saving it".
     * A person who had done exactly what both the field and the error asked
     * could not change either contact detail at all.
     *
     * Safe on an unchanged detail: the proof is empty, and the server skips
     * that field before it reads one.
     */
    data.append('emailProof', proofs.email)
    data.append('phoneProof', proofs.phone)

    onSubmit(data)
  }

  const shownPhoto = photoPreview ?? (photoCleared ? null : existingPhotoUrl)
  const message = localError || error
  const cvFile = files.cv
  const storedCv = storedDoc('cv')
  /* §8 — nothing to read from yet. On the edit page there is always a stored
     CV, so the button is only ever disabled during onboarding. */
  const needsCv = !files.cv && !isEdit

  return (
    <>
    {/*
      The lock control sits OUTSIDE the form, because the form is what gets
      taken out of reach — a toggle inside an inert subtree cannot be pressed to
      turn the subtree back on. It submits by id instead of by being nested.
    */}
    {lockable && (
      <div className="form-lock-bar">
        {/*
          Always type="button", and it asks the form to submit itself.

          It used to be a real submit button — type flipping to "submit" and a
          `form` attribute appearing — the moment the form unlocked. That made
          one press do two things. React flushes a click's state update
          synchronously, so by the time the browser came to run the same click's
          default action the button had already become a submit button pointing
          at the form: pressing Edit unlocked the form and then immediately
          submitted it, and onSubmit locked it straight back. The pencil looked
          completely dead, and only to a real pointer — `element.click()` runs
          its default action before React re-renders, so every test of mine
          pressed it that way and passed.

          Asking the form to submit explicitly means the press does exactly what
          this handler says and nothing the browser adds afterwards.
        */}
        <button
          type="button"
          className="icon-button"
          aria-pressed={!locked}
          disabled={submitting || (!locked && !contactsSettled)}
          aria-label={locked ? 'Edit my details' : 'Save my details'}
          title={locked ? 'Edit'
            : contactsSettled ? 'Save'
              : `Verify your new ${unverified.join(' and ')} first`}
          onClick={() => {
            if (locked) setUnlocked(true)
            else formRef.current?.requestSubmit()
          }}
        >
          {locked ? <PencilIcon /> : <TickIcon />}
        </button>
      </div>
    )}

    <form
      ref={formRef}
      id="candidate-form"
      className={locked ? 'panel panel-narrow form-locked' : 'panel panel-narrow'}
      onSubmit={(event) => { setUnlocked(!lockable); handleSubmit(event) }}
    >
      {/*
        A disabled fieldset, not `inert`.
        Both take every control out of reach in one place — better than
        `disabled` on each field, which is one forgotten prop away from a hole.
        But `inert` is a recent attribute that React 18 has no first-class
        support for and older browsers ignore outright, so whether the lock
        held depended on the reader's browser. A disabled fieldset is as old as
        forms and behaves the same everywhere.
        Nothing is lost at submission: the payload is built from React state,
        not scraped out of the DOM, so controls being disabled does not empty
        it — see handleSubmit.
      */}
      <fieldset className="form-fields" disabled={locked}>
      {children}

      {/*
        The photo, above the CV box and centred on it.

        It used to sit below the CV, on the reasoning that the CV should lead
        and a picture should never be the first thing asked for. That still
        holds for what matters most — the CV is the required field and the photo
        is optional — but the candidate portal had grown a second, larger copy
        of the same picture in a masthead across the top of the page, so the
        photo was on screen twice and neither one was where you would edit it.
        The masthead is gone and this is the only one left, at the size that
        band was using.
      */}
      {/*
        The photograph, above or below the CV depending on where this form is.

        On the application it sits under the CV: that is the only required
        upload and the thing the form exists for, and a large empty circle above
        it read as a field you had failed to fill in. On the account page the
        CV is already on file and the picture is the first thing the person came
        to see, so there it leads. One control, one size; only the order moves.
      */}
      {photoFirst && (
        <div className="photo-lead">
          {/* No Remove while the profile is being read. It is an action, and
              the locked page offers none — PhotoUploader already leaves the
              button out when there is nothing to call, so withholding the
              handler is all this takes. */}
          <PhotoUploader
            photoUrl={shownPhoto}
            onChoose={choosePhoto}
            onRemove={locked ? null : removePhoto}
            /*
             * A locked page is a profile being read: no Remove, no picker, and
             * a silhouette in an empty circle. Pressing Edit turns all three
             * round at once — including for somebody who has just removed the
             * picture they had, where the same circle becomes the way to put a
             * new one back.
             */
            canAdd={!locked}
            disabled={submitting || locked}
            label={null}
          />
        </div>
      )}

      <div className="field">
        <label className="field-label">CV{!isEdit && <Req />}</label>
        {/*
          The CV on file, drawn as the document it is.

          It used to be a sentence — "Currently on file: name.pdf. Attach a new
          file only if you want to replace it." — sitting a few centimetres
          above a list of other attachments that were each a card. Two
          treatments for one idea, and the CV, which is the important one, got
          the quieter of the two.

          The trailing instruction went with it rather than being kept as a
          third line: the dropzone underneath already says "Drop a NEW CV here",
          which is the same fact told at the moment it applies.

          New tab, like the document rows: this is a file, not a destination,
          and the form behind it has unsaved edits in it.
        */}
        {isEdit && storedCv && !cvFile && (
          <ul className="doc-uploads">
            <li className="doc-upload">
              <div className="doc-upload-text">
                <a
                  className="doc-upload-name"
                  href={withToken('/api/candidate/me/documents/cv', 'candidate')}
                  target="_blank"
                  rel="noreferrer"
                >
                  {storedCv.file_name}
                </a>
                {/* No × beside it. Every other document is optional and can be
                    taken away; a profile without a CV is not a profile. */}
                <span className="doc-upload-type">CV · on file</span>
              </div>
            </li>
          </ul>
        )}
        {/* An upload box is a thing to do, not a thing to read — while locked
            the line above already says which CV is on file. */}
        {!locked && (
        <div
          className={['dropzone', dragging ? 'dropzone-active' : '', cvMissing ? 'dropzone-error' : '']
            .filter(Boolean).join(' ')}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragging(false)
            const dropped = e.dataTransfer.files?.[0]
            if (dropped) chooseDocument('cv', dropped)
          }}
          onClick={() => cvInput.current?.click()}
          role="button"
          tabIndex={0}
          aria-invalid={cvMissing}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') cvInput.current?.click() }}
        >
          <input
            ref={cvInput}
            type="file"
            accept={CV_ACCEPT}
            hidden
            onChange={(e) => {
              const selected = e.target.files?.[0]
              if (selected) chooseDocument('cv', selected)
            }}
          />
          {cvFile ? (
            <>
              <strong className="dropzone-file">{cvFile.name}</strong>
              <span className="muted">{(cvFile.size / 1024).toFixed(0)} KB, click to replace</span>
            </>
          ) : (
            <>
              <strong>{isEdit ? 'Drop a new CV here, or click to browse' : 'Drop your CV here, or click to browse'}</strong>
              <span className="muted">PDF or DOCX, up to 5 MB</span>
            </>
          )}
        </div>
        )}
        {cvMissing && <p className="field-error">A CV is required to submit an application.</p>}

        {/*
          Said before the upload, not only after it.

          The green panel below reports what was filled in once it has happened;
          this is the reason to bother attaching a file first rather than typing
          the form out by hand. It disappears once a CV is chosen, because from
          then on the panel is saying something more specific.
        */}
        {!cvFile && !isEdit && (
          <p className="field-hint">
            We'll read your CV and fill in your name, contact details and city for you. You can
            change anything before you submit.
          </p>
        )}

        {/*
          Said out loud, and as its own panel rather than a grey hint line.

          A form that silently fills itself in is a form people scroll past —
          and one that does it in a footnote is one they do not realise
          happened at all. Naming the fields is what tells them which values
          came from the file and are worth a glance before submitting.
        */}
        {reading && (
          <p className="autofill autofill-working">
            <span className="autofill-spinner" aria-hidden="true" />
            Reading your CV and filling in what we can…
          </p>
        )}

        {!reading && readFromCv.length > 0 && (
          <div className="autofill autofill-done">
            <strong>Filled in from your CV</strong>
            <p>
              {readFromCv.map((key) => FIELD_NAMES[key]).join(', ')}. Have a look before you
              apply; every field is still yours to change.
            </p>
            {/* Filling the boxes is all this does. The two contact details are
                still proved with a code, and saying so here stops the green
                panel reading as "these are confirmed". */}
            {readFromCv.some((key) => key === 'email' || key === 'phone') && (
              <p className="autofill-note">
                Your email address and phone number still need confirming with a code.
              </p>
            )}
          </div>
        )}

        {/* Attempted and found nothing. Silence here reads as a broken feature
            to anyone who watched the spinner and saw no fields change. */}
        {!reading && attemptedRead && readFromCv.length === 0 && (
          <p className="field-hint">
            We could not read any details from that file. Please fill the form in yourself.
          </p>
        )}
      </div>

      {!photoFirst && (
        <div className="photo-under-cv">
          {/* Labelled here, unlike the account page's masthead. Small, left
              and inline among labelled fields, the circle is one question in a
              form rather than a portrait — and an unlabelled control among
              labelled ones is the one nobody is sure they have answered. */}
          <PhotoUploader
            photoUrl={shownPhoto}
            onChoose={choosePhoto}
            onRemove={removePhoto}
            disabled={submitting}
          />
        </div>
      )}

      <div className="grid-3">
        <Field label="First name" required>
          {/* Named so the Apply link at the foot of the page can point at it. */}
          <input
            id="first-name"
            required
            value={form.firstName}
            onChange={(e) => update('firstName', e.target.value)}
          />
        </Field>
        {shown(form.middleName) && (
          <Field label="Middle name">
            <input value={form.middleName} onChange={(e) => update('middleName', e.target.value)} />
          </Field>
        )}
        <Field label="Last name" required>
          <input required value={form.lastName} onChange={(e) => update('lastName', e.target.value)} />
        </Field>
      </div>

      {/*
        Both contact details are proved — at sign-up, and again whenever one of
        them changes.

        Being signed in says the session belongs to this account. It says
        nothing about whether the person holds the NEW address, and pointing the
        account's email at an inbox you control is enough to receive every
        sign-in code from then on. An address that has not been touched needs
        nothing: it was proved when the account was made.
      */}
      {isEdit ? (
        <>
          <VerifiedField
            channel="email"
            id="profile-email"
            label="Email"
            type="email"
            autoComplete="email"
            value={form.email}
            proof={proofs.email}
            verified={emailSettled}
            lockWhenVerified={false}
            onChange={(value) => update('email', value)}
            onProof={(proof) => setProofs((prev) => ({ ...prev, email: proof }))}
            disabled={submitting}
          />
          <VerifiedField
            channel="phone"
            id="profile-phone"
            label="Phone number"
            type="tel"
            placeholder="050-123-4567"
            autoComplete="tel"
            value={form.phone}
            proof={proofs.phone}
            verified={phoneSettled}
            lockWhenVerified={false}
            onChange={(value) => update('phone', value)}
            onProof={(proof) => setProofs((prev) => ({ ...prev, phone: proof }))}
            disabled={submitting}
          />
        </>
      ) : (
        /*
          A row each, not two columns.

          Each of these carries an input, a Verify button and a code panel that
          opens beneath it. Halving the card's width for them left an email
          field about ten characters wide — a control you cannot read what you
          typed into is not one worth having.
        */
        <>
          <VerifiedField
            channel="email"
            id="apply-email"
            label="Email"
            type="email"
            autoComplete="email"
            value={form.email}
            proof={proofs.email}
            onChange={(value) => update('email', value)}
            onProof={(proof) => setProofs((prev) => ({ ...prev, email: proof }))}
            disabled={submitting}
          />
          <VerifiedField
            channel="phone"
            id="apply-phone"
            label="Phone number"
            type="tel"
            autoComplete="tel"
            placeholder="050-123-4567"
            value={form.phone}
            proof={proofs.phone}
            onChange={(value) => update('phone', value)}
            onProof={(proof) => setProofs((prev) => ({ ...prev, phone: proof }))}
            disabled={submitting}
          />
        </>
      )}

      <div className="grid-2">
        {/* Free text, with the cities offered under it — see CityField. It was
            once a closed dropdown with an "Other" escape, which asked everyone
            outside the list to describe themselves as an exception; the
            suggestions are back, the exception is not, and matching reads the
            string either way. */}
        <Field label="City" required>
          <CityField
            required
            value={form.city}
            placeholder="New York"
            onChange={(next) => update('city', next)}
          />
        </Field>
        {shown(form.availability) && (
          <Field label="Availability">
            <select value={form.availability} onChange={(e) => update('availability', e.target.value)}>
              <option value="">Select…</option>
              {AVAILABILITY.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </Field>
        )}
      </div>

      {/* §6 — Capacity takes the left column, and the two Yes/No questions
          share the row beneath it. */}
      {shown(form.capacity) && (
        <div className="capacity-row">
          <Field label="Capacity">
            <select value={form.capacity} onChange={(e) => update('capacity', e.target.value)}>
              <option value="">Select…</option>
              {CAPACITY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </Field>
        </div>
      )}

      {/* Relocation first, openness under it — see .preference-row.

          Neither can be unanswered now. Relocation starts at yes, which is the
          answer most people applying would give, and has no Clear: the third
          state only ever meant "we do not know", which is not something a
          recruiter can act on or a candidate meant to say. */}
      <div className="preference-row">
        <YesNo
          name="openToRelocation"
          label="Open to relocation"
          value={form.openToRelocation}
          onChange={(value) => update('openToRelocation', value)}
        />
        <YesNo
          name="openToAll"
          label="I'm open to all opportunities"
          required
          hint="Say yes and any company hiring for what you do can find you."
          /* An empty string checks neither radio, which is what "not yet
             answered" has to look like. */
          value={form.openToAllOpportunities === null
            ? ''
            : (form.openToAllOpportunities ? 'yes' : 'no')}
          onChange={(value) => update('openToAllOpportunities', value === 'yes')}
        />
      </div>

      {/*
        Only when they have said no to everything.

        Answering no narrows who may find them, and narrowing to nothing is not
        an answer — it is an account that no search can reach. So at least one
        area is required here, and the form says so rather than saving a profile
        that quietly cannot be found.
      */}
      {form.openToAllOpportunities === false && (
        <Field label="What are you open to?" required>
          <p className="field-hint">
            Up to {TAG_CAP}, for example: fintech, cybersecurity, product. You will only be shown
            to recruiters hiring in these areas.
          </p>
          <TagChips
            value={form.interestTags}
            onChange={(next) => update('interestTags', next)}
            max={TAG_CAP}
            placeholder="e.g. fintech"
            addLabel="Add an area you are open to"
            disabled={submitting}
          />
          {tagCount === 0 && (
            <p className="field-hint field-hint-warn">
              Add at least one, or say yes to all opportunities above.
            </p>
          )}
        </Field>
      )}


      {/* §7 — one + button in place of four fixed rows.

          While locked this is a list of what is attached: the + goes, and with
          nothing attached the whole block goes, since a heading over an empty
          space says only that you have not done something optional. */}
      {/* The CV is excluded on both sides: it has a section of its own above,
          and counting it here would keep this heading over an empty space for
          everybody who has only uploaded a CV — which is nearly everybody. */}
      {(!locked
        || documents.some((doc) => doc.slot !== 'cv')
        || Object.keys(files).some((slot) => slot !== 'cv')) && (
        <div className="field">
          <label className="field-label">Documents</label>
          {!locked && (
            <p className="field-hint">
              Optional: a cover letter, certifications, recommendations, or anything else worth
              attaching. PDF, DOCX, PNG or JPEG, up to {Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB
              each.
            </p>
          )}
          <DocumentPicker
            files={files}
            existing={documents}
            onChoose={chooseDocument}
            onRemove={clearDocument}
            disabled={submitting}
            canAdd={!locked}
          />
        </div>
      )}

      <Field
        label="Professional Summary"
        /*
         * Two things the old wording got wrong, both of which a candidate would
         * notice before we did.
         *
         * "Recruiters read this alongside your CV" — they do not. The CV is
         * behind a reveal and this is not, which is exactly why it matters and
         * why the employer names come out of it. And nothing said that they
         * come out, so somebody who wrote "at Wix" and found "at a technology
         * company" on their profile would think the site had garbled their
         * writing. It says so now, in one clause, without explaining the
         * machinery.
         */
        hint={`Three or four sentences about your background, in your own words, up to
               ${SUMMARY_MAX_CHARS} characters. This is the first thing a recruiter reads about
               you, before they can see your CV or your contact details — so company names are
               replaced with a description of the employer, such as "a fintech company". Leave it
               blank and we will write one from your CV.`}
      >
        {/*
          The count sits inside the box's bottom-left corner. The textarea
          carries matching bottom padding so a full four lines of text never
          runs underneath it, and the count is opaque so scrolled text passing
          behind stays hidden rather than showing through.
        */}
        <div className="summary-input">
          <textarea
            rows={4}
            value={form.notes}
            maxLength={SUMMARY_MAX_CHARS}
            placeholder="I build payment systems for high-traffic retail…"
            aria-describedby="summary-count"
            onChange={(e) => update('notes', e.target.value)}
          />
          <span
            id="summary-count"
            className={`summary-count${form.notes.length >= SUMMARY_MAX_CHARS ? ' is-full' : ''}`}
          >
            {/*
              Deliberately not an aria-live region: announcing a new number on
              every keystroke would talk over the person typing. Tied to the
              field with aria-describedby instead, so it is read on focus and
              available on demand.
            */}
            {form.notes.length} / {SUMMARY_MAX_CHARS}
            {form.notes.length >= SUMMARY_MAX_CHARS && ' (limit reached)'}
          </span>
        </div>

        {/* Drafting from the CV they have just attached, or the one already on
            file. Always editable afterwards — it is their profile, under their
            name, so nothing is saved until they have read it. */}
        <div className="summary-actions">
          {/*
            One button, under the summary it acts on, and only while editing —
            it writes into the box above, which is not something a locked
            profile should offer. The arrow says "again" at a glance and the
            words say which "again" it is.
          */}
          {!locked && (
          <button
            type="button"
            className="btn btn-secondary btn-small summary-regenerate"
            disabled={drafting || needsCv}
            onClick={draftSummary}
          >
            <RegenerateIcon spinning={drafting} />
            {/*
              "Generate" the first time, "Regenerate" thereafter.
              On the sign-up form there is nothing to re-do — the box is empty
              and this is the first draft — so "Regenerate" was asking the
              reader to repeat something they had not done yet. In the portal
              the summary already exists, and "Regenerate" is exactly right.
            */}
            {drafting
              ? 'Reading your CV…'
              : isEdit ? 'Regenerate with AI' : 'Generate with AI'}
          </button>
          )}

          {/*
            §8 — the explanation for the disabled state moves into an (i).
            Shown only while the button is actually disabled: an icon beside a
            working button invites a click that answers a question nobody has.
          */}
          {needsCv && <InfoHint text="Attach your CV above to use this." label="Why is this unavailable?" />}

          {form.notes.trim() && drafted && (
            <button
              type="button"
              className="btn btn-quiet btn-small"
              disabled={drafting}
              onClick={() => { update('notes', ''); setDrafted(false); setDraftTrimmed(false) }}
            >
              Clear
            </button>
          )}

          {/* What happened after the fact still belongs on the line — it is
              news, not an explanation of a control. */}
          <span className="muted summary-hint">
            {draftError
              || (drafted
                ? (draftTrimmed
                  ? `Draft written from your CV and shortened to fit ${SUMMARY_MAX_CHARS} characters. `
                    + 'Reread the ending and edit anything that is not right.'
                  : 'Draft written from your CV. Edit anything that is not right.')
                : '')}
          </span>
        </div>
      </Field>

      {message && <p className="alert alert-error">{message}</p>}

      {/* Only ever on the edit form, where the consent box below does not
          render — so this still sits directly above the button it explains. */}
      {!contactsSettled && (
        <p className="field-hint contacts-pending">
          Verify your new {unverified.join(' and ')} to save these changes.
        </p>
      )}

      {/* Directly above the button it gates, and nowhere else on the page. */}
      {!isEdit && (
        <LegalConsent
          id="candidate-consent"
          checked={agreed}
          onChange={(next) => {
            setAgreed(next)
            // Ticking it answers the complaint, so the complaint goes.
            if (next) setConsentError(false)
          }}
          showError={consentError}
        />
      )}

      {/* Not disabled when unticked: a button that cannot be pressed cannot
          explain itself, and the message under the checkbox only appears
          because pressing it was allowed. handleSubmit does the refusing.

          An outstanding contact change is the one exception: the note above
          already says what to do, so the button has nothing left to explain. */}
      {!locked && (
        <button
          type="submit"
          className="btn btn-primary btn-block"
          disabled={submitting || !contactsSettled}
          title={contactsSettled ? undefined : `Verify your new ${unverified.join(' and ')} first`}
        >
          {submitting ? 'Saving…' : (submitLabel ?? (isEdit ? 'Save changes' : 'Submit application'))}
        </button>
      )}
      </fieldset>
    </form>
    </>
  )
}

/** The pencil: this is readable, press to change it. */

/** The circular arrow: do this again. Spins while it is being done. */
function RegenerateIcon({ spinning = false }) {
  return (
    <svg
      className={spinning ? 'regenerate-icon is-spinning' : 'regenerate-icon'}
      viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
    >
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  )
}

function Field({ label, hint, required = false, action = null, children }) {
  return (
    <div className="field">
      {/*
        `action` is a control that acts on the whole field rather than on one
        value in it — regenerating a summary, say. It sits on the label line
        because that is where the field is named, and because a small icon at
        the foot of a block of prose is a button nobody finds.
      */}
      <div className="field-label-row">
        <label className="field-label">{label}{required && <Req />}</label>
        {action}
      </div>
      {hint && <p className="field-hint">{hint}</p>}
      {children}
    </div>
  )
}

/**
 * §6 — a Yes/No pair, boxed as one control.
 *
 * Two of these now sit side by side on one line, which is exactly the
 * arrangement that makes it easy to read the wrong label against the wrong
 * pair. Boxing the options and setting the label directly on top of the box
 * with no gap is what keeps each question attached to its own answer; the
 * fieldset makes that grouping true for a screen reader as well as visually.
 */
/* Exported so the onboarding dialog draws the same control rather than a
   lookalike that would drift from it. */
export function YesNo({ name, label, hint, value, onChange, onClear = null, required = false }) {
  return (
    <fieldset className="yesno-field">
      {/* The same marker every other required label on the site uses, so one
          red asterisk means one thing everywhere. */}
      <legend className="field-label">{label}{required && <Req />}</legend>
      <div className="yesno">
        {[['yes', 'Yes'], ['no', 'No']].map(([option, text]) => (
          <label key={option}>
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={(e) => onChange(e.target.value)}
            />
            {text}
          </label>
        ))}
      </div>
      {hint && <p className="field-hint">{hint}</p>}
      {onClear && (
        <button type="button" className="btn btn-quiet btn-small" onClick={onClear}>Clear</button>
      )}
    </fieldset>
  )
}
