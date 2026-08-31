import { useEffect, useRef, useState } from 'react'

import CityField from './CityField.jsx'
import { CV_ACCEPT } from './DocumentPicker.jsx'
import LegalConsent from './LegalConsent.jsx'
import Req from './Req.jsx'
import VerifiedField from './VerifiedField.jsx'
import { get, sendForm } from '../api.js'

/**
 * Signing up, as four short steps instead of one long form.
 *
 * The old card asked for a CV and then asked for everything the CV already
 * says — name, contact details, city — which is a strange thing to do to
 * somebody who has just handed you a document containing all of it. This reads
 * the CV first and only asks for what it could not answer.
 *
 * The order is forced by the server, not chosen: the account cannot exist until
 * both contact details are proved, and the CV file has to ride in the very
 * request that creates the row, because insertCandidate binds the filename and
 * size as INSERT parameters. So the File is held in state across every step and
 * posted at the end, and the deep extraction — which is fire-and-forget, after
 * the 201 — is what the last step waits on.
 *
 * Nothing here is a new mechanism. The dropzone, the verified fields, the
 * consent box and the pre-fill endpoint are the ones the single-page form
 * already used; what changed is when each is asked for.
 */

const STEPS = ['cv', 'email', 'phone', 'building']

/* Extraction cannot fail an account — every model failure falls back to a
   deterministic read and still writes a row — so this is a ceiling on how long
   we make somebody watch a spinner, not a timeout on a thing that might break.
   Past it we go on to the profile, which reads correctly either way. */
const EXTRACTION_CEILING_MS = 20000
const POLL_MS = 700

export default function SignUpFlow({ onDone }) {
  /*
   * 'form' or 'building'. Not a step counter.
   *
   * The three questions were three screens with a progress rail over them,
   * which is the right shape when each answer decides what is asked next. None
   * of these does: the CV, the email and the phone are independent, all three
   * are needed, and splitting them meant a person who mistyped an address on
   * the second screen found out about it on the third. One window, everything
   * visible, one button at the end.
   */
  const [step, setStep] = useState('form')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  /* The CV itself, carried from the first step to the last. */
  const [cv, setCv] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [reading, setReading] = useState(false)
  const [readFields, setReadFields] = useState(null)

  /* What the CV told us, and what it could not. */
  const [identity, setIdentity] = useState({
    firstName: '', middleName: '', lastName: '', city: '',
  })

  const [email, setEmail] = useState('')
  const [emailProof, setEmailProof] = useState('')
  const [phone, setPhone] = useState('')
  const [phoneProof, setPhoneProof] = useState('')
  const [agreed, setAgreed] = useState(false)

  const fileInput = useRef(null)

  /*
   * What the CV did not answer, which is the only thing step one asks for.
   *
   * Computed rather than stored: a candidate who corrects a misread name should
   * not make the field vanish under them mid-edit, so this is only consulted
   * once, when the read finishes.
   */
  const [needs, setNeeds] = useState([])

  async function takeCv(file) {
    if (!file) return
    setCv(file)
    setError('')
    setReading(true)
    setReadFields(null)

    try {
      const body = new FormData()
      body.append('cv', file)
      const { fields } = await sendForm('/api/candidate/parse-cv', body)

      const next = {
        firstName: fields.firstName ?? '',
        middleName: fields.middleName ?? '',
        lastName: fields.lastName ?? '',
        city: fields.city ?? '',
      }
      setIdentity(next)
      if (fields.email) setEmail(fields.email)
      if (fields.phone) setPhone(fields.phone)

      setReadFields(Object.keys(fields))
      /* The three the create route insists on. Anything the CV supplied is
         never put in front of the candidate — they will see it on the profile
         page in a moment and can correct it there. */
      setNeeds(['firstName', 'lastName', 'city'].filter((key) => !next[key]))
    } catch {
      /* The read is a shortcut, not a requirement. Losing it means asking for
         the three fields by hand, which is what the old form did every time. */
      setReadFields([])
      setNeeds(['firstName', 'lastName', 'city'])
    } finally {
      setReading(false)
    }
  }

  function update(key, value) {
    setIdentity((was) => ({ ...was, [key]: value }))
  }

  const identityReady = ['firstName', 'lastName', 'city']
    .every((key) => String(identity[key] ?? '').trim())

  /* Everything the create route insists on, in one place — the button asks
     this, and so does the submit handler, so the two cannot disagree. */
  const ready = Boolean(cv) && !reading && identityReady
    && Boolean(emailProof) && Boolean(phoneProof) && agreed

  async function create() {
    setBusy(true)
    setError('')

    try {
      const body = new FormData()
      body.append('cv', cv)
      body.append('firstName', identity.firstName.trim())
      if (identity.middleName.trim()) body.append('middleName', identity.middleName.trim())
      body.append('lastName', identity.lastName.trim())
      body.append('location', identity.city.trim())
      body.append('email', email.trim())
      body.append('phone', phone.trim())
      body.append('emailProof', emailProof)
      body.append('phoneProof', phoneProof)
      body.append('consent', 'true')

      const created = await sendForm('/api/candidates', body)
      setStep('building')
      await waitForProfile()
      onDone?.(created)
    } catch (err) {
      setError(err.message)
      setBusy(false)
      /* Back to the form, with everything still in it. There is nowhere else
         to be: the field that has to change is already on screen. */
      setStep('form')
    }
  }

  /*
   * Wait for the CV to have been read, then go on.
   *
   * There is no status endpoint and no push channel: extraction is fired after
   * the 201 and nothing records that it is in flight. `profile.extractedAt`
   * flipping from null is the one observable signal, which is what the test
   * suites watch too. With no model key configured this settles in
   * milliseconds; with one it is seconds.
   */
  async function waitForProfile() {
    const until = Date.now() + EXTRACTION_CEILING_MS

    while (Date.now() < until) {
      try {
        /* The 201 set the session cookie, so this is already us. */
        const account = await get('/api/candidate/me')
        if (account?.profile?.extractedAt) return
      } catch {
        /* A hiccup here is not worth failing a finished signup for. */
      }
      await new Promise((resolve) => { setTimeout(resolve, POLL_MS) })
    }
  }

  // -------------------------------------------------------------- the form ---

  if (step === 'building') return <BuildingProfile />

  return (
    <form
      className="signup-flow"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) create()
      }}
    >

      <>
          <div className="field">
            <label className="field-label" htmlFor="signup-cv">Your CV<Req /></label>
            <p className="field-hint">
              We read it and fill in your profile, so there is almost nothing to type.
            </p>
            <div
              className={`dropzone${dragging ? ' dropzone-active' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                takeCv(e.dataTransfer.files?.[0])
              }}
              onClick={() => fileInput.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click() }}
            >
              <input
                id="signup-cv"
                ref={fileInput}
                type="file"
                className="visually-hidden"
                accept={CV_ACCEPT}
                onChange={(e) => takeCv(e.target.files?.[0])}
              />
              {cv
                ? <strong className="dropzone-file">{cv.name}</strong>
                : <strong>Drop your CV here, or click to browse</strong>}
              <span className="muted">PDF or DOCX, up to 5 MB</span>
            </div>
          </div>

          {reading && (
            <p className="autofill autofill-working">
              <span className="autofill-spinner" aria-hidden="true" />
              Reading your CV…
            </p>
          )}

          {/*
            Only what the CV could not answer.

            A name it read correctly is not put in front of anybody: the profile
            page is one screen away and is where it gets checked. Asking here
            would be asking somebody to proofread a document they have not been
            shown yet.
          */}
          {!reading && cv && needs.length > 0 && (
            <div className="signup-gap">
              <p className="field-hint">
                {readFields?.length
                  ? 'A couple of things we could not read from it:'
                  : 'We could not read your CV, so we need these:'}
              </p>
              {needs.includes('firstName') && (
                <label className="field">
                  <span className="field-label">First name<Req /></span>
                  <input
                    value={identity.firstName}
                    onChange={(e) => update('firstName', e.target.value)}
                  />
                </label>
              )}
              {needs.includes('lastName') && (
                <label className="field">
                  <span className="field-label">Last name<Req /></span>
                  <input
                    value={identity.lastName}
                    onChange={(e) => update('lastName', e.target.value)}
                  />
                </label>
              )}
              {/* A div rather than a label, unlike the two above it: a label
                  wrapping the field would send a click on any suggestion back
                  to the input, and the pick would never land. The label is
                  bound by htmlFor instead, which costs an id and nothing
                  else. */}
              {needs.includes('city') && (
                <div className="field">
                  <label className="field-label" htmlFor="signup-city">City<Req /></label>
                  <CityField
                    id="signup-city"
                    value={identity.city}
                    onChange={(next) => update('city', next)}
                  />
                </div>
              )}
            </div>
          )}

          {!reading && cv && needs.length === 0 && readFields?.length > 0 && (
            <p className="autofill autofill-done">
              Read from your CV: {readableList(readFields)}. You can check it all in a moment.
            </p>
          )}
      </>

      <VerifiedField
        channel="email"
        label="Email address"
        id="signup-email"
        value={email}
        proof={emailProof}
        onChange={setEmail}
        onProof={setEmailProof}
      />

      <VerifiedField
        channel="phone"
        label="Phone number"
        id="signup-phone"
        value={phone}
        proof={phoneProof}
        onChange={setPhone}
        onProof={setPhoneProof}
      />

      {/* Consent has to be collected before the account exists — the create
          route refuses without it — so it sits immediately above the button
          that does the creating. */}
      <LegalConsent id="candidate-consent" checked={agreed} onChange={setAgreed} />

      {error && <p className="alert alert-error">{error}</p>}

      {/*
        One button, across the foot.

        Everything it needs is above it and visible, so there is nothing for a
        second control to navigate between. It stays disabled until all five
        conditions hold rather than accepting the press and reporting what is
        missing: the missing thing is on screen, and a form that refuses a
        press it could have prevented is a form that wasted the press.
      */}
      <button
        type="submit"
        className="btn btn-primary btn-block"
        disabled={busy || !ready}
      >
        {busy ? 'Creating your profile…' : 'Confirm'}
      </button>
    </form>
  )
}

/**
 * The wait while the CV is read.
 *
 * It says what is happening rather than spinning silently, because the thing
 * being waited for is the reason they uploaded a CV at all — and because with a
 * model key this is the several seconds in which the product does the work it
 * promised.
 */
function BuildingProfile() {
  return (
    <div className="signup-building">
      <span className="autofill-spinner autofill-spinner-lg" aria-hidden="true" />
      <h2>Building your profile from your CV…</h2>
      <p className="muted">
        We are reading your experience, your skills and where you have worked. This takes a
        moment, and you will be able to check all of it.
      </p>
    </div>
  )
}

/** "your name, your city and your email" — an Oxford comma and no array syntax. */
function readableList(keys) {
  const words = {
    firstName: 'your name', middleName: 'your name', lastName: 'your name',
    email: 'your email address', phone: 'your phone number', city: 'your city',
  }
  const said = [...new Set(keys.map((key) => words[key]).filter(Boolean))]
  if (said.length <= 1) return said[0] ?? 'nothing'
  return `${said.slice(0, -1).join(', ')} and ${said.at(-1)}`
}
